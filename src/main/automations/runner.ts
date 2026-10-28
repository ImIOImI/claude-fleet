// Step executor (#407 Phases 3, 4, 7). Pure: every workspace effect, the clock
// and sleeping are injected. Prompt steps (live / fresh) and script steps
// (automations workspace container by default, another container, or host).
import type { ParamValue, RunRow, RunStatus, ScriptShell, ScriptStepDef } from '../../preload/inboxTypes.js';
import { EXIT_NOTHING_TO_DO, parseScriptOutput, scriptEnv, tail } from './scriptProtocol.js';
import type { AutomationRecord, AutomationStore } from './automationStore.js';
import { DEFAULT_RUN_TIMEOUT_MS, DEFAULT_STEP_TIMEOUT_MS, parseDuration } from './definition.js';
import { renderPrompt } from './template.js';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';

export interface RunnerDeps {
  store: AutomationStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  workspaceState(id: string): Promise<WorkspaceState | null>;
  workspaceName(id: string): string;
  ensureRunning(id: string): Promise<void>;
  post(id: string, text: string): Promise<{ via: string; brokerSessionId?: string }>;
  busy(id: string): boolean;
  /** Fresh headless sessions (#407 Phase 4). */
  spawnFresh(id: string, sessionId: string, args: string[]): Promise<void>;
  freshState(id: string, sessionId: string): Promise<'alive' | 'ended' | 'missing'>;
  closeFresh(id: string, sessionId: string): Promise<void>;
  /** Script steps (#407 Phase 7). */
  execScript?(
    target: { kind: 'container'; workspaceId: string } | { kind: 'host'; shell: ScriptShell },
    opts: { automationId: string; script: string; env: Record<string, string>; timeoutMs: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** The automations workspace (default home of script steps), if set up. */
  automationsWorkspace?(): string | null;
  secret?(workspaceId: string, key: string): Promise<string | null>;
  /** Post what a script printed. Throws on invalid input (recorded as a step warning). */
  emitTodo?(automationId: string, runId: string, input: Record<string, unknown>): Promise<void>;
  emitNotify?(automationId: string, runId: string, input: Record<string, unknown>): Promise<void>;
  /** A `{"next": …}` request (#437). Throws on invalid input (recorded as a step warning). */
  requestNext?(runId: string, raw: unknown, by: string): unknown;
}

/** Tools an unattended fresh session may always use: posting back to the inbox. */
export const INBOX_TOOLS = ['post_todo', 'update_todo', 'list_todos', 'notify', 'list_automations'].map((t) => `mcp__claude-fleet-state__${t}`);
/** Added for automations that may set their own next run (#437). */
export const SCHEDULE_NEXT_TOOL = 'mcp__claude-fleet-state__schedule_next';
const FRESH_POLL_MS = 2000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60_000;

export interface RunOutcome {
  status: RunStatus;
  error: string | null;
}

const POLL_MS = 1000;
/** A live step's target that never starts working within this window is treated as done. */
const START_GRACE_MS = 30_000;

class StepError extends Error {
  constructor(message: string, readonly status: RunStatus = 'failed') { super(message); }
}

async function waitIdle(deps: RunnerDeps, ws: string, timeoutMs: number): Promise<void> {
  const start = deps.now();
  let sawBusy = deps.busy(ws);
  while (!sawBusy) {
    if (deps.now() - start >= Math.min(START_GRACE_MS, timeoutMs)) return;
    await deps.sleep(POLL_MS);
    sawBusy = deps.busy(ws);
  }
  while (deps.busy(ws)) {
    if (deps.now() - start >= timeoutMs) throw new StepError(`${deps.workspaceName(ws)} was still working after ${Math.round(timeoutMs / 60_000)}m`, 'timed-out');
    await deps.sleep(POLL_MS);
  }
}

async function waitFresh(deps: RunnerDeps, ws: string, sessionId: string, timeoutMs: number): Promise<void> {
  const start = deps.now();
  for (;;) {
    const st = await deps.freshState(ws, sessionId);
    if (st !== 'alive') return;
    if (deps.now() - start >= timeoutMs) {
      throw new StepError(`the fresh session in ${deps.workspaceName(ws)} was still running after ${Math.round(timeoutMs / 60_000)}m`, 'timed-out');
    }
    await deps.sleep(FRESH_POLL_MS);
  }
}

async function prepare(deps: RunnerDeps, ws: string, ensureRunning: boolean | undefined): Promise<void> {
  const name = deps.workspaceName(ws);
  const state = await deps.workspaceState(ws);
  if (state === null) throw new StepError(`target-not-running: ${name} no longer exists`);
  if (state === 'unreachable') throw new StepError(`docker-unreachable: ${name} can't be reached until Docker is back`);
  if (state !== 'running') {
    const what = state === 'deleted' ? 'saved but not running' : state;
    if (!ensureRunning) throw new StepError(`target-not-running: ${name} is ${what} (set ensureRunning: true to start it)`);
    await deps.ensureRunning(ws);
  }
}

/** Run one script step; returns its plain output, or 'stop' for exit 10. */
async function runScriptStep(
  deps: RunnerDeps, a: AutomationRecord, run: RunRow, step: ScriptStepDef, stepRow: number, timeoutMs: number
): Promise<{ text: string; stop: boolean }> {
  const sc = step.script;
  if (!deps.execScript) throw new StepError('script steps are unavailable');
  const host = sc.runIn === 'host';
  const auto = deps.automationsWorkspace?.() ?? null;
  const ws = host ? null : sc.runIn ?? auto;
  if (!host && !ws) throw new StepError('no automations workspace: set one up (Automations tab), or give this step runIn: <workspace>');
  if (ws) await prepare(deps, ws, sc.ensureRunning);
  // Host steps read secrets from the automations workspace's vault.
  const vaultOf = ws ?? auto;
  const secrets: Record<string, string> = {};
  for (const key of sc.secrets ?? []) {
    const v = vaultOf && deps.secret ? await deps.secret(vaultOf, key) : null;
    if (v === null) throw new StepError(`secret ${key} isn't set${vaultOf ? ` in ${deps.workspaceName(vaultOf)}'s secrets` : ' (no automations workspace to hold it)'}`);
    secrets[key] = v;
  }
  const ev = run.trigger.event;
  const env = scriptEnv({
    runId: run.id, automationName: a.name, args: run.args as Record<string, ParamValue>, state: deps.store.getState(a.id),
    trigger: { kind: run.trigger.kind, ...(ev?.workspaceId ? { workspace: deps.workspaceName(ev.workspaceId) } : {}), ...(ev?.todoTitle ? { todo: ev.todoTitle } : {}) },
    secrets
  });
  const res = await deps.execScript(host ? { kind: 'host', shell: sc.shell! } : { kind: 'container', workspaceId: ws! }, { automationId: a.id, script: sc.run, env, timeoutMs });
  const out = parseScriptOutput(res.stdout);
  const warnings = [...out.warnings];
  let todos = 0;
  let notes = 0;
  const failed = res.timedOut || (res.exitCode !== 0 && res.exitCode !== EXIT_NOTHING_TO_DO);
  if (!failed) {
    for (const t of out.todos) {
      try { await deps.emitTodo?.(a.id, run.id, t); todos++; } catch (e) { warnings.push(`todo "${String(t.title ?? '')}": ${(e as Error).message}`); }
    }
    for (const n of out.notifies) {
      try { await deps.emitNotify?.(a.id, run.id, n); notes++; } catch (e) { warnings.push(`notify "${String(n.title ?? '')}": ${(e as Error).message}`); }
    }
    if (out.state !== undefined) deps.store.setState(a.id, out.state);
    if (out.next !== undefined) {
      try { deps.requestNext?.(run.id, out.next, step.id); } catch (e) { warnings.push(`next: ${(e as Error).message}`); }
    }
  }
  const detail = {
    via: host ? `host:${sc.shell}` : 'container', exitCode: res.exitCode, todos, notifications: notes,
    ...(warnings.length ? { warnings: warnings.slice(0, 10) } : {}),
    ...(out.text ? { stdout: tail(out.text, 20, 2000) } : {}),
    ...(res.stderr.trim() ? { stderr: tail(res.stderr, 20, 2000) } : {})
  };
  if (res.timedOut) {
    deps.store.finishStep(stepRow, 'timed-out', { error: `the script was still running after ${Math.round(timeoutMs / 1000)}s`, detail }, deps.now());
    throw new HandledStepError(`the script was still running after ${Math.round(timeoutMs / 1000)}s`, 'timed-out');
  }
  if (failed) {
    const why = `exited ${res.exitCode}${res.stderr.trim() ? `: ${tail(res.stderr, 3, 300)}` : ''}`;
    deps.store.finishStep(stepRow, 'failed', { error: why, detail }, deps.now());
    throw new HandledStepError(why, 'failed');
  }
  const stop = res.exitCode === EXIT_NOTHING_TO_DO;
  deps.store.finishStep(stepRow, stop ? 'nothing-to-do' : 'succeeded', { detail }, deps.now());
  return { text: out.text, stop };
}

/** The step row was already finished with details; just end the run. */
class HandledStepError extends StepError {}

export async function executeRun(deps: RunnerDeps, a: AutomationRecord, run: RunRow, opts: { callerSupplied: boolean }): Promise<RunOutcome> {
  const runTimeout = parseDuration(a.definition.timeout) ?? DEFAULT_RUN_TIMEOUT_MS;
  const started = deps.now();
  const outputs: Record<string, string> = {};
  for (const step of a.definition.steps) {
    if ('script' in step) {
      const sc = step.script;
      const where = sc.runIn === 'host' ? null : sc.runIn ?? deps.automationsWorkspace?.() ?? null;
      const stepRow = deps.store.startStep(run.id, step.id, 'script', where, deps.now());
      try {
        if (deps.now() - started >= runTimeout) throw new StepError(`the run passed its ${a.definition.timeout ?? '30m'} timeout`, 'timed-out');
        const timeout = Math.min(parseDuration(sc.timeout) ?? DEFAULT_SCRIPT_TIMEOUT_MS, runTimeout - (deps.now() - started));
        const r = await runScriptStep(deps, a, run, step, stepRow, timeout);
        outputs[step.id] = r.text;
        if (r.stop) return { status: 'nothing-to-do', error: null };
      } catch (e) {
        const status = e instanceof StepError ? e.status : 'failed';
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof HandledStepError)) deps.store.finishStep(stepRow, status, { error: message }, deps.now());
        return { status, error: `${step.id}: ${message}` };
      }
      continue;
    }
    const p = step.prompt;
    const stepId = deps.store.startStep(run.id, step.id, 'prompt', p.workspace, deps.now());
    try {
      if (deps.now() - started >= runTimeout) throw new StepError(`the run passed its ${a.definition.timeout ?? '30m'} timeout`, 'timed-out');
      await prepare(deps, p.workspace, p.ensureRunning);
      const ev = run.trigger.event;
      const text = renderPrompt(p.message, {
        automationName: a.name, runId: run.id, triggerKind: run.trigger.kind, args: run.args as Record<string, ParamValue>,
        callerSupplied: opts.callerSupplied,
        triggerWorkspace: ev?.workspaceId ? deps.workspaceName(ev.workspaceId) : undefined,
        triggerTodo: ev?.todoTitle,
        stepOutputs: outputs
      });
      const stepTimeout = Math.min(parseDuration(p.timeout) ?? DEFAULT_STEP_TIMEOUT_MS, runTimeout - (deps.now() - started));
      if (p.mode === 'fresh') {
        const sessionId = `auto-${run.id}-${step.id}`;
        const tools = [...INBOX_TOOLS, ...(a.definition.reschedule ? [SCHEDULE_NEXT_TOOL] : []), ...(p.allowedTools ?? [])];
        await deps.spawnFresh(p.workspace, sessionId, ['-p', text, '--allowedTools', tools.join(',')]);
        try {
          await waitFresh(deps, p.workspace, sessionId, stepTimeout);
        } finally {
          await deps.closeFresh(p.workspace, sessionId);
        }
        deps.store.finishStep(stepId, 'succeeded', { brokerSessionId: sessionId, detail: { via: 'fresh' } }, deps.now());
        continue;
      }
      const res = await deps.post(p.workspace, text);
      if (p.wait) await waitIdle(deps, p.workspace, stepTimeout);
      deps.store.finishStep(stepId, 'succeeded', { brokerSessionId: res.brokerSessionId ?? null, detail: { via: res.via } }, deps.now());
    } catch (e) {
      const status = e instanceof StepError ? e.status : 'failed';
      const message = e instanceof Error ? e.message : String(e);
      deps.store.finishStep(stepId, status, { error: message }, deps.now());
      return { status, error: `${step.id}: ${message}` };
    }
  }
  return { status: 'succeeded', error: null };
}
