// Pure notification policy (#407 Phase 2): which rule applies to a request,
// whether a downtime or pause is active, and the final deliver-or-hold call.
// No electron/DB/fs. Downtime math uses the host's local time.
import type {
  Downtime, EffectiveRule, NotificationKind, NotifyLevel, NotifyRule, PauseState, RuleScopeKind, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';

export interface NotifyRequest {
  kind: NotificationKind;
  priority: TodoPriority;
  source: TodoSource;
  dedupeKey: string | null;
  tags: string[];
}

export interface ResolveCtx {
  rules: NotifyRule[];
  defaultLevel: NotifyLevel;
  pause: PauseState | null;
  downtimes: Downtime[];
  now: number;
}

export type Resolution = { deliver: true } | { deliver: false; heldReason: string };

const STRICTNESS: Record<NotifyLevel, number> = { all: 0, high: 1, urgent: 2, off: 3 };

export function sourceScopeValue(s: TodoSource): string {
  return s.kind === 'user' ? 'user' : `${s.kind}:${s.id ?? ''}`;
}

export function scopesFor(req: NotifyRequest): Array<{ scopeKind: RuleScopeKind; scopeValue: string }> {
  const src = sourceScopeValue(req.source);
  return [
    ...(req.dedupeKey ? [{ scopeKind: 'key' as const, scopeValue: `${src}:${req.dedupeKey}` }] : []),
    { scopeKind: 'source' as const, scopeValue: src },
    ...req.tags.map((t) => ({ scopeKind: 'tag' as const, scopeValue: t })),
    { scopeKind: 'global' as const, scopeValue: '' }
  ];
}

export function levelAllows(level: NotifyLevel, priority: TodoPriority): boolean {
  switch (level) {
    case 'all': return true;
    case 'high': return priority === 'high' || priority === 'urgent';
    case 'urgent': return priority === 'urgent';
    case 'off': return false;
  }
}

function asEffective(r: NotifyRule, now: number): EffectiveRule {
  const snoozed = r.snoozeUntil !== null && r.snoozeUntil > now;
  return { level: snoozed ? 'off' : r.level, snoozeUntil: snoozed ? r.snoozeUntil : null, ruleId: r.id, scopeKind: r.scopeKind };
}

export function effectiveRule(req: NotifyRequest, rules: NotifyRule[], defaultLevel: NotifyLevel, now: number): EffectiveRule {
  const find = (kind: RuleScopeKind, value: string) => rules.find((r) => r.scopeKind === kind && r.scopeValue === value);
  for (const s of scopesFor(req)) {
    if (s.scopeKind === 'tag') {
      const tagRules = req.tags.map((t) => find('tag', t)).filter((r): r is NotifyRule => !!r).map((r) => asEffective(r, now));
      if (tagRules.length) return tagRules.reduce((a, b) => (STRICTNESS[b.level] > STRICTNESS[a.level] ? b : a));
      continue;
    }
    if (s.scopeKind === 'global') break;
    const r = find(s.scopeKind, s.scopeValue);
    if (r) return asEffective(r, now);
  }
  return { level: defaultLevel, snoozeUntil: null, ruleId: null, scopeKind: 'global' };
}

const MIN = 60_000;

/** The window of `d` containing `now`, or null. Windows start on a listed day;
 *  end ≤ start wraps past midnight (start = end ⇒ a full day). */
export function downtimeWindowAt(d: Downtime, now: number): { start: number; end: number } | null {
  if (!d.enabled) return null;
  const today = new Date(now);
  for (const offset of [0, -1]) {
    const y = today.getFullYear(), m = today.getMonth(), day = today.getDate() + offset;
    const base = new Date(y, m, day);
    const dow = (base.getDay() + 6) % 7;
    if (!d.days.includes(dow)) continue;
    const start = new Date(y, m, day, 0, d.startMin).getTime();
    const end = new Date(y, m, day, 0, d.endMin > d.startMin ? d.endMin : d.endMin + 1440).getTime();
    if (now >= start && now < end) return { start, end };
  }
  return null;
}

export function activeDowntime(ds: Downtime[], now: number): { downtime: Downtime; start: number; end: number } | null {
  for (const d of ds) {
    const w = downtimeWindowAt(d, now);
    if (w) return { downtime: d, ...w };
  }
  return null;
}

export function nextDowntime(ds: Downtime[], now: number): { downtime: Downtime; startsAt: number } | null {
  let best: { downtime: Downtime; startsAt: number } | null = null;
  const t = new Date(now);
  for (const d of ds) {
    if (!d.enabled) continue;
    for (let offset = 0; offset <= 7; offset++) {
      const base = new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset);
      if (!d.days.includes((base.getDay() + 6) % 7)) continue;
      const startsAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, d.startMin).getTime();
      if (startsAt <= now) continue;
      if (!best || startsAt < best.startsAt) best = { downtime: d, startsAt };
      break;
    }
  }
  return best;
}

export function pauseActive(p: PauseState | null, now: number): boolean {
  return !!p && (p.until === null || p.until > now);
}

export function resolve(req: NotifyRequest, ctx: ResolveCtx): Resolution {
  if (req.kind === 'test' || req.kind === 'digest') return { deliver: true };
  const eff = effectiveRule(req, ctx.rules, ctx.defaultLevel, ctx.now);
  if (!levelAllows(eff.level, req.priority)) {
    return { deliver: false, heldReason: eff.ruleId ? `rule:${eff.ruleId}` : 'default-level' };
  }
  const paused = pauseActive(ctx.pause, ctx.now);
  const dt = activeDowntime(ctx.downtimes, ctx.now);
  const pauseDecides = paused && (!dt || ctx.pause!.setAt >= dt.start);
  if (pauseDecides) {
    return req.priority === 'urgent' && ctx.pause!.letUrgent ? { deliver: true } : { deliver: false, heldReason: 'pause' };
  }
  if (dt) {
    const b = dt.downtime.bypass;
    const passes = (b !== 'none' && req.priority === 'urgent') || (b === 'urgent+input' && req.kind === 'input-wait');
    return passes ? { deliver: true } : { deliver: false, heldReason: `downtime:${dt.downtime.id}` };
  }
  return { deliver: true };
}

/** Allow callers (unit tests, the service) to express minutes cleanly. */
export const minutes = (n: number): number => n * MIN;
