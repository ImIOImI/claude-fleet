// Step executor (#407 Phase 3). Pure: every workspace effect, the clock and
// sleeping are injected. Phase 3 runs **live** prompt steps only.
import type { ParamValue, RunRow, RunStatus } from '../../preload/inboxTypes.js';
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
}

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

export async function executeRun(deps: RunnerDeps, a: AutomationRecord, run: RunRow, opts: { callerSupplied: boolean }): Promise<RunOutcome> {
  const runTimeout = parseDuration(a.definition.timeout) ?? DEFAULT_RUN_TIMEOUT_MS;
  const started = deps.now();
  for (const step of a.definition.steps) {
    const p = step.prompt;
    const stepId = deps.store.startStep(run.id, step.id, 'prompt', p.workspace, deps.now());
    try {
      if (deps.now() - started >= runTimeout) throw new StepError(`the run passed its ${a.definition.timeout ?? '30m'} timeout`, 'timed-out');
      const name = deps.workspaceName(p.workspace);
      const state = await deps.workspaceState(p.workspace);
      if (state === null || state === 'deleted') throw new StepError(`target-not-running: ${name} no longer exists`);
      if (state === 'unreachable') throw new StepError(`docker-unreachable: ${name} can't be reached until Docker is back`);
      if (state !== 'running') {
        if (!p.ensureRunning) throw new StepError(`target-not-running: ${name} is ${state} (set ensureRunning: true to start it)`);
        await deps.ensureRunning(p.workspace);
      }
      const text = renderPrompt(p.message, {
        automationName: a.name, runId: run.id, triggerKind: run.trigger.kind, args: run.args as Record<string, ParamValue>, callerSupplied: opts.callerSupplied
      });
      const res = await deps.post(p.workspace, text);
      if (p.wait) {
        const stepTimeout = Math.min(parseDuration(p.timeout) ?? DEFAULT_STEP_TIMEOUT_MS, runTimeout - (deps.now() - started));
        await waitIdle(deps, p.workspace, stepTimeout);
      }
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
