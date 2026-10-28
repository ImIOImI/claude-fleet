// Pure display helpers for Inbox › Automations (#407 Phase 3).
import type { Automation, AutomationDef, ParamDef, RunRow, RunStatus, ScriptShell } from '../../preload/inboxTypes';
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
  if (a.nextFireAt === null) return a.definition.reschedule ? 'not scheduled (until a run sets a time)' : 'by hand only';
  const when = clockLabel(a.nextFireAt, now);
  return a.nextSetByRun ? `${when} (set by a run)` : when;
}

function clockLabel(at: number, now: number): string {
  const mins = Math.round((at - now) / 60_000);
  if (mins < 60) return `in ${Math.max(mins, 1)}m`;
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? hhmm(at) : `${new Date(at).toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(at)}`;
}

/** What a run asked for as its next fire and what happened to it (#437). */
export function rescheduleLabel(r: RunRow, now = Date.now()): string | null {
  const x = r.reschedule;
  if (!x) return null;
  const asked = `${x.by} asked for ${clockLabel(x.requestedAt, now)}`;
  if (x.appliedAt === null) return `${asked} · not applied: ${x.reason ?? 'the run did not succeed'}`;
  return x.clamped ? `${asked} · given ${clockLabel(x.appliedAt, now)}, the soonest allowed` : asked;
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

export const TRIGGER_LABELS: Record<RunRow['trigger']['kind'], string> = { schedule: 'schedule', manual: 'by hand', 'catch-up': 'catch-up', event: 'event', rescheduled: 'set by a run' };

/** Initial form values for the Run-now modal (strings, as the inputs hold them). */
export function initialArgs(params: ParamDef[] | undefined): Record<string, string> {
  return Object.fromEntries((params ?? []).map((p) => [p.name, p.default === undefined ? '' : String(p.default)]));
}

/** A copy of the definition with one host step's shell changed (#407). */
export function withShell(def: AutomationDef, stepId: string, shell: ScriptShell): AutomationDef {
  return { ...def, steps: def.steps.map((s) => ('script' in s && s.id === stepId ? { ...s, script: { ...s.script, shell } } : s)) };
}

/** The host steps of a definition, in order. */
export function hostSteps(def: AutomationDef): Array<{ id: string; shell: ScriptShell | undefined }> {
  return def.steps.flatMap((s) => ('script' in s && s.script.runIn === 'host' ? [{ id: s.id, shell: s.script.shell }] : []));
}
