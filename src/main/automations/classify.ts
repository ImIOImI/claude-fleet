// Risk classification for automation proposals (#407 Phase 5). Pure.
// Low-risk (a trusted workspace may auto-apply): name, description, tags,
// prompt wording, params, concurrency/timeout, schedule changes no faster than
// every 5 minutes, removing steps or triggers. Everything that widens what an
// automation can touch, or how often, needs the user. Script steps (Phase 7):
// any new or changed script, runIn, shell or secret needs the user, and an
// automation with a host step is never low-risk.
import type { AutomationDef, PromptStepDef, ScriptStepDef, StepDef, TriggerDef } from '../../preload/inboxTypes.js';
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

const isPrompt = (s: StepDef): s is PromptStepDef => 'prompt' in s;
const isScript = (s: StepDef): s is ScriptStepDef => 'script' in s;

/** Flags that start with this are shown in red on approval cards. */
export const HOST_FLAG = 'runs a script on your computer';

function where(s: ScriptStepDef, name: (id: string) => string): string {
  return s.script.runIn === 'host' ? `${HOST_FLAG} (${s.script.shell})` : `runs a script in ${s.script.runIn ? name(s.script.runIn) : 'the automations workspace'}`;
}

function every(ms: number): string {
  return ms < 3_600_000 ? `every ${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `every ${Math.round(ms / 3_600_000)} h` : 'daily or less';
}

/** What the automation will be able to do, for approval cards. */
export function riskFlags(def: AutomationDef, name: (id: string) => string): string[] {
  const flags: string[] = [];
  for (const s of def.steps) {
    if (isScript(s)) {
      flags.push(where(s, name));
      if (s.script.secrets?.length) flags.push(`uses secrets ${s.script.secrets.join(', ')}`);
      if (s.script.ensureRunning) flags.push(`starts ${s.script.runIn ? name(s.script.runIn) : 'the automations workspace'} if needed`);
      continue;
    }
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
  const beforeKeys = new Set(before.steps.filter(isPrompt).map(stepKey));
  for (const s of after.steps) {
    const prev = beforeSteps.get(s.id);
    if (isScript(s)) {
      const o = prev && isScript(prev) ? prev.script : null;
      if (!o) reasons.push(`adds a script step (${s.id})`);
      else {
        if (o.run !== s.script.run) reasons.push(`changes the ${s.id} script`);
        if ((o.runIn ?? '') !== (s.script.runIn ?? '') || (o.shell ?? '') !== (s.script.shell ?? '')) reasons.push(`moves ${s.id} to ${s.script.runIn === 'host' ? 'your computer' : s.script.runIn ? name(s.script.runIn) : 'the automations workspace'}`);
        const had = new Set(o.secrets ?? []);
        const gained = (s.script.secrets ?? []).filter((k) => !had.has(k));
        if (gained.length) reasons.push(`gives ${s.id} secrets ${gained.join(', ')}`);
        if (s.script.ensureRunning && !o.ensureRunning) reasons.push(`${s.id} may start its workspace`);
      }
      continue;
    }
    const old = prev && isPrompt(prev) ? prev : undefined;
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
  if (after.steps.some((s) => isScript(s) && s.script.runIn === 'host') && !reasons.some((r) => r.includes('your computer'))) {
    reasons.push('has a step that runs on your computer');
  }
  return { lowRisk: reasons.length === 0, reasons };
}
