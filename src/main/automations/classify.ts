// Risk classification for automation proposals (#407 Phase 5). Pure.
// Low-risk (a trusted workspace may auto-apply): name, description, tags,
// prompt wording, params, concurrency/timeout, schedule changes no faster than
// every 5 minutes, removing steps or triggers. Everything that widens what an
// automation can touch, or how often, needs the user.
import type { AutomationDef, PromptStepDef, TriggerDef } from '../../preload/inboxTypes.js';
import { nextFire, parseCron } from './cron.js';

export const MIN_LOW_RISK_INTERVAL_MS = 5 * 60_000;

/** Smallest gap between consecutive fires of any schedule trigger (sampled over the next fires), or null. */
export function minScheduleInterval(def: AutomationDef, from = Date.UTC(2026, 0, 5, 0, 0)): number | null {
  let min: number | null = null;
  for (const t of def.triggers) {
    if (!('schedule' in t)) continue;
    let spec;
    try { spec = parseCron(t.schedule.cron); } catch { continue; }
    let prev = nextFire(spec, from, t.schedule.tz);
    for (let i = 0; i < 48 && prev !== null; i++) {
      const next = nextFire(spec, prev, t.schedule.tz);
      if (next === null) break;
      const gap = next - prev;
      if (min === null || gap < min) min = gap;
      prev = next;
    }
  }
  return min;
}

function stepKey(s: PromptStepDef): string {
  return `${s.prompt.workspace}|${s.prompt.mode}`;
}

function every(ms: number): string {
  return ms < 3_600_000 ? `every ${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `every ${Math.round(ms / 3_600_000)} h` : 'daily or less';
}

/** What the automation will be able to do, for approval cards. */
export function riskFlags(def: AutomationDef, name: (id: string) => string): string[] {
  const flags: string[] = [];
  for (const s of def.steps) {
    flags.push(`prompts ${name(s.prompt.workspace)} (${s.prompt.mode === 'fresh' ? 'fresh session' : 'live session'})`);
    if (s.prompt.ensureRunning) flags.push(`starts ${name(s.prompt.workspace)} if needed`);
    if (s.prompt.allowedTools?.length) flags.push(`may use ${s.prompt.allowedTools.join(', ')}`);
  }
  const iv = minScheduleInterval(def);
  if (iv !== null) flags.push(`runs ${every(iv)}`);
  for (const t of def.triggers) if ('event' in t) flags.push(`runs on ${t.event.on}${t.event.tag ? ` #${t.event.tag}` : ''}`);
  for (const t of def.triggers) if ('manual' in t && t.manual.allowFrom?.length) flags.push(`runnable by ${t.manual.allowFrom.map(name).join(', ')}`);
  return [...new Set(flags)];
}

function allowFrom(ts: TriggerDef[]): Set<string> {
  return new Set(ts.flatMap((t) => ('manual' in t ? t.manual.allowFrom ?? [] : [])));
}
function events(ts: TriggerDef[]): Set<string> {
  return new Set(ts.flatMap((t) => ('event' in t ? [`${t.event.on}|${t.event.workspace ?? ''}|${t.event.tag ?? ''}`] : [])));
}

/** Classify a change. `before` null = a new automation, which always needs the user. */
export function classifyChange(before: AutomationDef | null, after: AutomationDef, name: (id: string) => string): { lowRisk: boolean; reasons: string[] } {
  if (!before) return { lowRisk: false, reasons: ['new automation'] };
  const reasons: string[] = [];
  const beforeSteps = new Map(before.steps.map((s) => [s.id, s]));
  const beforeKeys = new Set(before.steps.map(stepKey));
  for (const s of after.steps) {
    const old = beforeSteps.get(s.id);
    if (!beforeKeys.has(stepKey(s)) && (!old || stepKey(old) !== stepKey(s))) {
      reasons.push(old && old.prompt.workspace === s.prompt.workspace
        ? `switches ${s.id} to a ${s.prompt.mode} session`
        : `prompts ${name(s.prompt.workspace)} (${s.prompt.mode})`);
    }
    const oldTools = new Set(old?.prompt.allowedTools ?? []);
    const added = (s.prompt.allowedTools ?? []).filter((t) => !oldTools.has(t));
    if (added.length) reasons.push(`lets ${s.id} use ${added.join(', ')}`);
    if (s.prompt.ensureRunning && !old?.prompt.ensureRunning) reasons.push(`${s.id} may start ${name(s.prompt.workspace)}`);
  }
  const oldAllow = allowFrom(before.triggers);
  const newAllow = [...allowFrom(after.triggers)].filter((w) => !oldAllow.has(w));
  if (newAllow.length) reasons.push(`lets ${newAllow.map(name).join(', ')} run it`);
  const oldEvents = events(before.triggers);
  if ([...events(after.triggers)].some((e) => !oldEvents.has(e))) reasons.push('adds an event trigger');
  const iv = minScheduleInterval(after);
  const oldIv = minScheduleInterval(before);
  if (iv !== null && iv < MIN_LOW_RISK_INTERVAL_MS && (oldIv === null || iv < oldIv)) reasons.push(`runs ${every(iv)} (faster than every 5 min)`);
  if (iv !== null && oldIv === null && !reasons.some((r) => r.startsWith('runs '))) reasons.push(`adds a schedule (${every(iv)})`);
  return { lowRisk: reasons.length === 0, reasons };
}
