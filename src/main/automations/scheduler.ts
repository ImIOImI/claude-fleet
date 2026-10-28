// What is due (#407 Phase 3). Pure. A schedule fires at most once per tick no
// matter how many slots were missed (a closed app gets ONE catch-up run).
// A next fire chosen by a run (#437) replaces the cron until it fires.
import type { ParamValue, ScheduleTrigger } from '../../preload/inboxTypes.js';
import type { AutomationRecord } from './automationStore.js';
import { nextFire, parseCron } from './cron.js';

export interface Due {
  /** catch-up: more than one cron slot was missed since the last run. rescheduled: a run chose this time. */
  kind: 'schedule' | 'catch-up' | 'rescheduled';
  /** The cron that fired (schedule / catch-up). */
  cron?: string;
  /** The time it was due: the cron slot, or the run-chosen time. */
  slot: number;
  args: Record<string, ParamValue>;
}

function scheduleTriggers(a: AutomationRecord): Array<ScheduleTrigger['schedule']> {
  return a.definition.triggers.flatMap((t) => ('schedule' in t ? [t.schedule] : []));
}

export function dueSchedule(a: AutomationRecord, now: number): Due | null {
  if (!a.enabled) return null;
  if (a.nextRunAt !== null) return now >= a.nextRunAt ? { kind: 'rescheduled', slot: a.nextRunAt, args: {} } : null;
  const since = a.lastScheduledAt ?? a.createdAt;
  let best: Due | null = null;
  for (const s of scheduleTriggers(a)) {
    let spec;
    try { spec = parseCron(s.cron); } catch { continue; }
    const slot = nextFire(spec, since, s.tz);
    if (slot === null || slot > now) continue;
    const following = nextFire(spec, slot, s.tz);
    const catchUp = following !== null && following <= now && now - slot > 120_000;
    if (!best || slot < best.slot) best = { kind: catchUp ? 'catch-up' : 'schedule', cron: s.cron, slot, args: s.args ?? {} };
  }
  return best;
}

export function nextFireAt(a: AutomationRecord, now: number): number | null {
  if (!a.enabled) return null;
  if (a.nextRunAt !== null) return a.nextRunAt;
  let best: number | null = null;
  for (const s of scheduleTriggers(a)) {
    try {
      const t = nextFire(parseCron(s.cron), Math.max(now, a.lastScheduledAt ?? 0), s.tz);
      if (t !== null && (best === null || t < best)) best = t;
    } catch { /* invalid cron never saved */ }
  }
  return best;
}
