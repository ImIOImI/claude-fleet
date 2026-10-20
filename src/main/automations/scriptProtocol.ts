// Script-step contract (#407 Phase 7). Pure.
// Inputs are env-only: FLEET_RUN_ID, FLEET_AUTOMATION, FLEET_ARGS (JSON),
// ARG_<NAME>, FLEET_STATE (JSON from the last run), FLEET_TRIGGER (JSON), and
// the step's declared secrets. Outputs are stdout JSON lines:
//   {"todo": {title, key?, priority?, body?, tags?}}  → an inbox todo
//   {"notify": {title, body?, priority?, key?}}       → a notification
//   {"state": <any JSON>}                             → saved for the next run
// Other lines are plain output ({{steps.<id>.stdout}}). Exit 0 continues, 10
// stops the run as "nothing to do", anything else fails it.
import type { ParamValue } from '../../preload/inboxTypes.js';

export const EXIT_NOTHING_TO_DO = 10;
export const MAX_EMITS_PER_STEP = 50;
/** Plain output kept for {{steps.<id>.stdout}} and the run detail. */
export const MAX_TEXT_CHARS = 16_000;
export const MAX_STATE_CHARS = 64_000;

export interface ScriptEmits {
  todos: Array<Record<string, unknown>>;
  notifies: Array<Record<string, unknown>>;
  /** undefined = the script didn't write state (keep the old one). */
  state?: unknown;
  text: string;
  warnings: string[];
}

export function parseScriptOutput(stdout: string): ScriptEmits {
  const out: ScriptEmits = { todos: [], notifies: [], text: '', warnings: [] };
  const text: string[] = [];
  let dropped = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      let v: unknown;
      try { v = JSON.parse(t); } catch { out.warnings.push(`not JSON, kept as text: ${t.slice(0, 80)}`); text.push(line); continue; }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && (keys[0] === 'todo' || keys[0] === 'notify')) {
        const body = o[keys[0]];
        if (!body || typeof body !== 'object' || Array.isArray(body)) { out.warnings.push(`${keys[0]} must be an object`); continue; }
        const list = keys[0] === 'todo' ? out.todos : out.notifies;
        if (out.todos.length + out.notifies.length >= MAX_EMITS_PER_STEP) { dropped++; continue; }
        list.push(body as Record<string, unknown>);
        continue;
      }
      if (keys.length === 1 && keys[0] === 'state') {
        const s = JSON.stringify(o.state);
        if (s.length > MAX_STATE_CHARS) out.warnings.push(`state is larger than ${MAX_STATE_CHARS} characters; not saved`);
        else out.state = o.state;
        continue;
      }
    }
    text.push(line);
  }
  if (dropped) out.warnings.push(`only ${MAX_EMITS_PER_STEP} todos/notifications per step; ${dropped} dropped`);
  const joined = text.join('\n').replace(/\s+$/, '');
  out.text = joined.length > MAX_TEXT_CHARS ? joined.slice(joined.length - MAX_TEXT_CHARS) : joined;
  return out;
}

export interface ScriptEnvCtx {
  runId: string;
  automationName: string;
  args: Record<string, ParamValue>;
  state: unknown;
  trigger: { kind: string; workspace?: string; todo?: string };
  secrets: Record<string, string>;
}

/** The env a script sees on top of its runtime's base env. Secrets last, but they can't shadow FLEET_* (validation forbids it). */
export function scriptEnv(ctx: ScriptEnvCtx): Record<string, string> {
  const env: Record<string, string> = {
    FLEET_RUN_ID: ctx.runId,
    FLEET_AUTOMATION: ctx.automationName,
    FLEET_ARGS: JSON.stringify(ctx.args),
    FLEET_STATE: ctx.state === undefined || ctx.state === null ? '{}' : JSON.stringify(ctx.state),
    FLEET_TRIGGER: JSON.stringify(ctx.trigger)
  };
  for (const [k, v] of Object.entries(ctx.args)) env[`ARG_${k.toUpperCase()}`] = String(v);
  return { ...env, ...ctx.secrets };
}

/** The last few lines of a stream, for a failure message. */
export function tail(s: string, lines = 5, chars = 600): string {
  const t = s.replace(/\s+$/, '').split(/\r?\n/).slice(-lines).join('\n');
  return t.length > chars ? t.slice(t.length - chars) : t;
}
