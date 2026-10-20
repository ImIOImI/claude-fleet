// Pure display helpers for Inbox › Automations (#407 Phase 3).
import type { Automation, ParamDef, RunRow, RunStatus } from '../../preload/inboxTypes';
import { hhmm } from './notifyView';
import { relativeAgo } from './inboxView';

export const RUN_LABELS: Record<RunStatus, string> = {
  queued: 'queued', running: 'running', succeeded: 'succeeded', 'nothing-to-do': 'nothing to do', failed: 'failed',
  'timed-out': 'timed out', skipped: 'skipped', cancelled: 'cancelled', interrupted: 'interrupted'
};

/** Chip colour family for a run status. */
export function runTone(s: RunStatus): 'ok' | 'idle' | 'bad' | 'warn' {
  if (s === 'succeeded') return 'ok';
  if (s === 'failed' || s === 'timed-out') return 'bad';
  if (s === 'interrupted' || s === 'running' || s === 'queued') return 'warn';
  return 'idle';
}

export function nextLabel(a: Automation, now = Date.now()): string {
  if (!a.enabled) return 'disabled';
  if (a.nextFireAt === null) return 'by hand only';
  const mins = Math.round((a.nextFireAt - now) / 60_000);
  if (mins < 60) return `in ${Math.max(mins, 1)}m`;
  const sameDay = new Date(a.nextFireAt).toDateString() === new Date(now).toDateString();
  return sameDay ? hhmm(a.nextFireAt) : `${new Date(a.nextFireAt).toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(a.nextFireAt)}`;
}

export function runDuration(r: RunRow): string {
  if (r.endedAt === null) return '—';
  const ms = r.endedAt - r.startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function runWhen(r: RunRow, now = Date.now()): string {
  return new Date(r.startedAt).toDateString() === new Date(now).toDateString() ? hhmm(r.startedAt) : relativeAgo(r.startedAt, now);
}

export const TRIGGER_LABELS: Record<RunRow['trigger']['kind'], string> = { schedule: 'schedule', manual: 'by hand', 'catch-up': 'catch-up' };

/** Initial form values for the Run-now modal (strings, as the inputs hold them). */
export function initialArgs(params: ParamDef[] | undefined): Record<string, string> {
  return Object.fromEntries((params ?? []).map((p) => [p.name, p.default === undefined ? '' : String(p.default)]));
}
