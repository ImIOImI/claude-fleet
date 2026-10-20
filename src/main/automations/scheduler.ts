// What is due (#407 Phase 3). Pure. A schedule fires at most once per tick no
// matter how many slots were missed (a closed app gets ONE catch-up run).
import type { ParamValue, ScheduleTrigger } from '../../preload/inboxTypes.js';
import type { AutomationRecord } from './automationStore.js';
import { nextFire, parseCron } from './cron.js';

export interface Due {
  trigger: ScheduleTrigger['schedule'];
  /** true when more than one slot was missed since the last run (catch-up). */
  catchUp: boolean;
  slot: number;
  args: Record<string, ParamValue>;
}

function scheduleTriggers(a: AutomationRecord): Array<ScheduleTrigger['schedule']> {
  return a.definition.triggers.flatMap((t) => ('schedule' in t ? [t.schedule] : []));
}

export function dueSchedule(a: AutomationRecord, now: number): Due | null {
  if (!a.enabled) return null;
  const since = a.lastScheduledAt ?? a.createdAt;
  let best: Due | null = null;
  for (const s of scheduleTriggers(a)) {
    let spec;
    try { spec = parseCron(s.cron); } catch { continue; }
    const slot = nextFire(spec, since, s.tz);
    if (slot === null || slot > now) continue;
    const following = nextFire(spec, slot, s.tz);
    const catchUp = following !== null && following <= now && now - slot > 120_000;
    if (!best || slot < best.slot) best = { trigger: s, catchUp, slot, args: s.args ?? {} };
  }
  return best;
}

export function nextFireAt(a: AutomationRecord, now: number): number | null {
  if (!a.enabled) return null;
  let best: number | null = null;
  for (const s of scheduleTriggers(a)) {
    try {
      const t = nextFire(parseCron(s.cron), Math.max(now, a.lastScheduledAt ?? 0), s.tz);
      if (t !== null && (best === null || t < best)) best = t;
    } catch { /* invalid cron never saved */ }
  }
  return best;
}
