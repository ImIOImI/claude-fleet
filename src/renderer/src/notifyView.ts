// Pure display helpers for notifications (#407 Phase 2): labels, presets for
// pause and snooze, quiet-state wording and downtime formatting.
import type { Downtime, EffectiveRule, NotifyLevel, NotifyRule, QuietState, RuleScopeKind } from '../../preload/inboxTypes';

export const LEVEL_LABELS: Record<NotifyLevel, string> = {
  all: 'All',
  high: 'High and up',
  urgent: 'Urgent only',
  off: 'Off'
};

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function hhmmToMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function daysLabel(days: number[]): string {
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '0,1,2,3,4,5,6') return 'every day';
  if (s === '0,1,2,3,4') return 'Mon–Fri';
  if (s === '5,6') return 'Sat–Sun';
  return days.length ? [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(', ') : 'no days';
}

export function downtimeSummary(d: Downtime): string {
  const span = d.startMin === d.endMin ? 'all day' : `${minToHHMM(d.startMin)}–${minToHHMM(d.endMin)}`;
  return `${daysLabel(d.days)} · ${span}`;
}

export const BYPASS_LABELS: Record<Downtime['bypass'], string> = {
  none: 'urgent waits',
  urgent: 'urgent gets through',
  'urgent+input': 'urgent + needs input get through'
};

function endOfDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59).getTime();
}

function atClock(now: number, h: number, dayOffset = 0): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, 0).getTime();
}

export function snoozePresets(now: number): Array<{ label: string; until: number }> {
  return [
    { label: '1 hour', until: now + 3_600_000 },
    { label: 'Rest of today', until: endOfDay(now) },
    { label: '1 week', until: now + 7 * 86_400_000 }
  ];
}

export function pausePresets(now: number): Array<{ label: string; hint?: string; until: number | null }> {
  const fivePm = atClock(now, 17);
  return [
    { label: 'For 30 minutes', until: now + 30 * 60_000 },
    { label: 'For 1 hour', until: now + 3_600_000 },
    ...(now < fivePm ? [{ label: 'Until 17:00', hint: 'end of workday', until: fivePm }] : []),
    { label: 'Until tomorrow 08:00', until: atClock(now, 8, 1) },
    { label: 'Until I turn it back on', until: null }
  ];
}

export function quietLabel(q: QuietState | null): { state: 'notifying' | 'paused' | 'downtime'; text: string; detail: string } {
  if (q?.pause) {
    return { state: 'paused', text: 'Paused', detail: q.pause.until === null ? 'until resumed' : `until ${hhmm(q.pause.until)}` };
  }
  if (q?.activeDowntime) {
    return { state: 'downtime', text: q.activeDowntime.name, detail: `downtime · ${minToHHMM(q.activeDowntime.endMin)}` };
  }
  const next = q?.nextDowntime;
  return { state: 'notifying', text: 'Notifying', detail: next ? `${next.downtime.name} at ${hhmm(next.startsAt)}` : '' };
}

/** Why a notification was held, in words. */
export function heldReasonLabel(reason: string | null, rules: NotifyRule[], downtimes: Downtime[], names: Record<string, string>): string {
  if (!reason) return 'delivered';
  if (reason === 'pause') return 'held: notifications were paused';
  if (reason === 'default-level') return 'held by your default level';
  if (reason.startsWith('downtime:')) {
    const d = downtimes.find((x) => x.id === reason.slice(9));
    return d ? `held: downtime · ${d.name} (${downtimeSummary(d)})` : 'held: downtime';
  }
  if (reason.startsWith('rule:')) {
    const r = rules.find((x) => x.id === reason.slice(5));
    if (!r) return 'held by a rule you removed';
    return `held by rule: ${ruleScopeLabel(r.scopeKind, r.scopeValue, names)} → ${LEVEL_LABELS[r.level]}`;
  }
  return reason;
}

export function ruleScopeLabel(kind: RuleScopeKind, value: string, names: Record<string, string>): string {
  const src = (v: string) => (v === 'user' ? 'You' : v.startsWith('workspace:') ? names[v.slice(10)] ?? 'a workspace' : 'automation');
  if (kind === 'global') return 'Everything';
  if (kind === 'tag') return `#${value}`;
  if (kind === 'source') return src(value);
  const parts = value.split(':');
  const key = parts.slice(parts[0] === 'user' ? 1 : 2).join(':');
  return `${key} · ${src(parts[0] === 'user' ? 'user' : `${parts[0]}:${parts[1]}`)}`;
}

/** The muted-row hint ("off for this item · today"), or null when nothing special applies. */
export function mutedHint(eff: EffectiveRule | undefined, now: number): string | null {
  if (!eff || eff.ruleId === null) return null;
  const where = eff.scopeKind === 'key' ? 'this item' : eff.scopeKind === 'source' ? 'this source' : 'this tag';
  if (eff.snoozeUntil !== null) {
    const sameDay = new Date(eff.snoozeUntil).toDateString() === new Date(now).toDateString();
    return `snoozed for ${where} · until ${sameDay ? hhmm(eff.snoozeUntil) : new Date(eff.snoozeUntil).toLocaleDateString()}`;
  }
  if (eff.level === 'all') return null;
  return `${LEVEL_LABELS[eff.level].toLowerCase()} for ${where}`;
}

export const BELL_POP_WIDTH = 300;
const BELL_POP_HEIGHT = 330;
const MARGIN = 8;

/** Fixed-position placement for the 🔔 popover: under the trigger, right-aligned,
 *  flipped above when it would run off the bottom, clamped to the viewport. */
export function bellPosition(rect: { left: number; right: number; top: number; bottom: number }, innerWidth: number, innerHeight: number): { top: number; left: number } {
  const left = Math.max(MARGIN, Math.min(rect.right - BELL_POP_WIDTH, innerWidth - BELL_POP_WIDTH - MARGIN));
  const below = rect.bottom + 4;
  const top = below + BELL_POP_HEIGHT > innerHeight - MARGIN ? Math.max(MARGIN, rect.top - 4 - BELL_POP_HEIGHT) : below;
  return { top, left };
}
