// Automations service (#407 Phase 3): CRUD from YAML, run orchestration
// (concurrency, rate cap, queueing), the scheduler tick, failure notifications,
// restart recovery, the active-run registry used for todo attribution, and the
// MCP handlers. Pure: Electron/backends are injected (automationIpc.ts).
import type { Automation, AutomationDef, EventName, ParamValue, RunRow, RunTriggerKind, TodoSource } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import { AutomationStore, type AutomationRecord } from './automationStore.js';
import { definitionToYaml, parseDefinitionText, parseDuration, stepWorkspaces, validateArgs, validateDefinition, type Validation } from './definition.js';
import { executeRun, type RunnerDeps, type RunOutcome } from './runner.js';
import { dueSchedule, nextFireAt } from './scheduler.js';
import { describeCron } from './cron.js';

export interface AutomationDeps extends Omit<RunnerDeps, 'store'> {
  /** Shells this computer offers for host steps (#407); validation checks `shell` against them. */
  hostShells?(): string[] | undefined;
  store: AutomationStore;
  /** Resolve a workspace id or name to an id. */
  resolveWorkspace(idOrName: string): string | null;
  notify?: (n: NotifyInput) => unknown;
  changed(): void;
  /** Injected for tests; default setTimeout/clearTimeout (event debounce). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
}

export interface FleetEvent {
  on: EventName;
  workspaceId?: string;
  todo?: { id: string; title: string; tags: string[]; source: TodoSource };
}

const DEFAULT_DEBOUNCE_MS = 120_000;
/** After a run ends, ignore events from the workspaces it prompted for this long (loop guard). */
const SELF_GUARD_MS = 120_000;

const RATE_MS = 60_000;
const RUN_RETENTION_MS = 90 * 86_400_000;

export interface RunRequest {
  kind: RunTriggerKind;
  by?: TodoSource;
  cron?: string;
  args?: Record<string, unknown>;
  /** Args came from a workspace (MCP), so prompts quote them as data. */
  callerSupplied?: boolean;
  /** Coerce string args (the Run-now form). */
  coerce?: boolean;
  event?: RunRow['trigger']['event'];
}

export function createAutomationService(deps: AutomationDeps) {
  const { store } = deps;
  /** runId → automation + the workspaces its steps target (attribution). */
  const active = new Map<string, { automationId: string; workspaces: Set<string> }>();
  const lastStart = new Map<string, number>();
  const inFlight = new Set<Promise<unknown>>();
  const lastEnded = new Map<string, number>();
  const pending = new Map<string, { timer: unknown; event: NonNullable<RunRow['trigger']['event']> }>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v), get hostShells() { return deps.hostShells?.(); } };

  function view(a: AutomationRecord): Automation {
    const now = deps.now();
    return {
      id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, version: a.version,
      definition: a.definition, tags: store.tags(a.id), createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt,
      lastScheduledAt: a.lastScheduledAt, nextFireAt: nextFireAt(a, now), lastRun: store.runs(a.id, 1)[0] ?? null,
      weekStats: store.weekStats(a.id, now),
      origin: a.origin && typeof a.origin.loadoutId === 'string'
        ? { loadoutId: a.origin.loadoutId, version: typeof a.origin.version === 'string' ? a.origin.version : null, workspaceId: String(a.origin.workspaceId ?? ''), edited: a.version > Number(a.origin.installedVersion ?? a.version) }
        : null,
      triggerSummaries: a.definition.triggers.map((t) => {
        if ('schedule' in t) return `${describeCron(t.schedule.cron)}${t.schedule.tz ? ` (${t.schedule.tz})` : ''}`;
        if ('manual' in t) {
          return t.manual.allowFrom?.length ? `by hand · also ${t.manual.allowFrom.map((w) => deps.workspaceName(w)).join(', ')}` : 'by hand';
        }
        const e = t.event;
        const ws = e.workspace ? deps.workspaceName(e.workspace) : null;
        const what = e.on === 'session.idle' ? `when ${ws ?? 'any workspace'} goes idle`
          : e.on === 'workspace.started' ? `when ${ws ?? 'a workspace'} starts`
          : `when a todo${e.tag ? ` tagged #${e.tag}` : ''} arrives${ws ? ` from ${ws}` : ''}`;
        return `${what} · debounce ${e.debounce ?? '2m'}`;
      })
    };
  }

  function parse(text: string): Validation<AutomationDef> {
    const p = parseDefinitionText(text);
    if (!p.ok) return p;
    return validateDefinition(p.value, ctx);
  }

  function failed(a: AutomationRecord, run: RunRow, outcome: RunOutcome): void {
    deps.notify?.({
      kind: 'run-failed',
      title: `${a.name} ${outcome.status === 'timed-out' ? 'timed out' : outcome.status === 'interrupted' ? 'was interrupted' : 'failed'}`,
      body: outcome.error ?? undefined, priority: 'high',
      source: { kind: 'automation', id: a.id }, dedupeKey: `run-failed:${a.id}`, tags: a.definition.tags ?? []
    });
    void run;
  }

  async function execute(a: AutomationRecord, run: RunRow, callerSupplied: boolean): Promise<void> {
    active.set(run.id, { automationId: a.id, workspaces: new Set(stepWorkspaces(a.definition)) });
    deps.changed();
    let outcome: RunOutcome;
    try {
      outcome = await executeRun(deps as RunnerDeps, a, run, { callerSupplied });
    } catch (e) {
      outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    active.delete(run.id);
    lastEnded.set(a.id, deps.now());
    store.setRunStatus(run.id, outcome.status, deps.now(), outcome.error);
    if (outcome.status === 'failed' || outcome.status === 'timed-out') failed(a, run, outcome);
    deps.changed();
    // A queued run waits for this one.
    const queued = store.runsWithStatus('queued').find((r) => r.automationId === a.id);
    if (queued) {
      const cur = store.get(a.id);
      if (cur) {
        store.setRunStatus(queued.id, 'running', deps.now());
        const p = execute(cur, store.getRun(queued.id)!, queued.trigger.by?.kind === 'workspace');
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
      }
    }
  }

  function start(id: string, req: RunRequest): RunRow {
    const a = store.get(id);
    if (!a) throw new Error(`automation ${id} not found`);
    const args = validateArgs(a.definition.params, req.args, req.coerce);
    if (!args.ok) throw new Error(`invalid arguments: ${args.errors.join('; ')}`);
    const trigger = { kind: req.kind, ...(req.by ? { by: req.by } : {}), ...(req.cron ? { cron: req.cron } : {}), ...(req.event ? { event: req.event } : {}) };
    const now = deps.now();
    const running = [...active.values()].some((r) => r.automationId === id);
    const userManual = req.kind === 'manual' && req.by?.kind === 'user';
    const last = lastStart.get(id);
    if (!userManual && last !== undefined && now - last < RATE_MS && !running) {
      return store.startRun(a, trigger, args.value, 'skipped', now, 'rate limit: at most one run per minute');
    }
    if (running) {
      if (a.definition.concurrency === 'queue' && !store.runsWithStatus('queued').some((r) => r.automationId === id)) {
        return store.startRun(a, trigger, args.value, 'queued', now);
      }
      return store.startRun(a, trigger, args.value, 'skipped', now, 'a run was already in progress');
    }
    lastStart.set(id, now);
    const run = store.startRun(a, trigger, args.value, 'running', now);
    const p = execute(a, run, req.callerSupplied === true);
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return run;
  }

  return {
    list(): Automation[] {
      return store.list().map(view);
    },
    get(id: string): { automation: Automation; runs: RunRow[]; yaml: string; versions: number[] } | null {
      const a = store.get(id);
      if (!a) return null;
      return { automation: view(a), runs: store.runs(id, 30), yaml: definitionToYaml(a.definition), versions: store.versions(id).map((v) => v.version) };
    },
    validate(text: string): { ok: boolean; errors: string[] } {
      const r = parse(text);
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors };
    },
    create(text: string, by: TodoSource): Automation {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = store.create(r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    update(id: string, text: string, by: TodoSource): Automation {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = store.update(id, r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    setEnabled(id: string, enabled: boolean): void {
      store.setEnabled(id, enabled, deps.now());
      deps.changed();
    },
    remove(id: string): void {
      store.remove(id);
      deps.changed();
    },
    run: start,

    /** Periodic: start whatever schedule is due (one catch-up for missed slots). */
    tick(): RunRow[] {
      const now = deps.now();
      const started: RunRow[] = [];
      for (const a of store.list()) {
        const due = dueSchedule(a, now);
        if (!due) continue;
        store.setLastScheduled(a.id, now);
        try {
          started.push(start(a.id, { kind: due.catchUp ? 'catch-up' : 'schedule', cron: due.trigger.cron, args: due.args }));
        } catch (e) {
          const run = store.startRun(a, { kind: 'schedule', cron: due.trigger.cron }, {}, 'failed', now, (e as Error).message);
          failed(a, run, { status: 'failed', error: (e as Error).message });
          started.push(run);
        }
      }
      if (started.length) deps.changed();
      return started;
    },

    /** A fleet event (#407 Phase 4): start matching event-triggered automations after their debounce. */
    onEvent(e: FleetEvent): string[] {
      const now = deps.now();
      const matched: string[] = [];
      for (const a of store.list()) {
        if (!a.enabled) continue;
        const trig = a.definition.triggers.find((t) =>
          'event' in t && t.event.on === e.on &&
          (!t.event.workspace || t.event.workspace === (e.workspaceId ?? e.todo?.source.id)) &&
          (!t.event.tag || (e.todo?.tags ?? []).includes(t.event.tag)));
        if (!trig || !('event' in trig)) continue;
        // Loop guard: never react to your own output, or to the workspaces you just prompted.
        if (e.todo?.source.kind === 'automation' && e.todo.source.id === a.id) continue;
        const targets = new Set(stepWorkspaces(a.definition));
        const ws = e.workspaceId ?? (e.todo?.source.kind === 'workspace' ? e.todo.source.id ?? undefined : undefined);
        if (ws && targets.has(ws)) {
          const busyHere = [...active.values()].some((r) => r.automationId === a.id);
          const ended = lastEnded.get(a.id);
          if (busyHere || (ended !== undefined && now - ended < SELF_GUARD_MS)) continue;
        }
        matched.push(a.id);
        const p = pending.get(a.id);
        if (p) {
          p.event.count += 1;
          continue;
        }
        const event = { on: e.on, ...(ws ? { workspaceId: ws } : {}), ...(e.todo ? { todoId: e.todo.id, todoTitle: e.todo.title } : {}), count: 1 };
        const ms = parseDuration(trig.event.debounce) ?? DEFAULT_DEBOUNCE_MS;
        pending.set(a.id, {
          event,
          timer: setTimer(() => {
            const fired = pending.get(a.id);
            pending.delete(a.id);
            if (!fired) return;
            try {
              start(a.id, { kind: 'event', event: fired.event });
            } catch (err) {
              const cur = store.get(a.id);
              if (cur) {
                const run = store.startRun(cur, { kind: 'event', event: fired.event }, {}, 'failed', deps.now(), (err as Error).message);
                failed(cur, run, { status: 'failed', error: (err as Error).message });
              }
            }
            deps.changed();
          }, ms)
        });
      }
      return matched;
    },

    /** Cancel pending debounced event runs (quit / tests). */
    cancelPending(): void {
      for (const p of pending.values()) clearTimer(p.timer);
      pending.clear();
    },

    /** Startup: runs cut off by a quit become `interrupted` (one notification). */
    recover(): RunRow[] {
      const cut = store.markInterrupted(deps.now());
      if (cut.length) {
        const names = [...new Set(cut.map((r) => store.get(r.automationId)?.name ?? 'an automation'))];
        deps.notify?.({
          kind: 'run-failed', title: cut.length === 1 ? `${names[0]} was interrupted` : `${cut.length} automation runs were interrupted`,
          body: `The app quit mid-run (${names.join(', ')}). They are not retried automatically.`, priority: 'normal',
          source: { kind: 'user', id: null }
        });
      }
      store.pruneRuns(deps.now() - RUN_RETENTION_MS);
      return cut;
    },

    /** Attribution: a post that names run_id belongs to the automation only if the run is live and targets the caller. */
    attribution(runId: string, callerId: string): { automationId: string } | null {
      const r = active.get(runId);
      return r && r.workspaces.has(callerId) ? { automationId: r.automationId } : null;
    },

    /** Wait for in-flight runs (tests / quit). */
    async settle(): Promise<void> {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    mcp: {
      /** Automations a workspace may see: ones it can run, or whose steps prompt it. */
      list(callerId: string, privileged = false): Array<Pick<Automation, 'id' | 'name' | 'description' | 'enabled' | 'nextFireAt'> & { canRun: boolean; params: AutomationDef['params'] }> {
        return store.list()
          .filter((a) => privileged || canRun(a, callerId) || stepWorkspaces(a.definition).includes(callerId))
          .map((a) => ({ id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, nextFireAt: nextFireAt(a, deps.now()), canRun: privileged || canRun(a, callerId), params: a.definition.params ?? [] }));
      },
      /** One automation's YAML + recent runs, for workspaces that may see it (all for the automations workspace). */
      get(callerId: string, args: Record<string, unknown>, privileged = false) {
        const key = typeof args.id === 'string' ? args.id : '';
        const a = store.get(key) ?? store.byName(key);
        if (!a || !(privileged || visible(a, callerId))) throw new Error(`automation ${key || '(missing id)'} not found`);
        return { ...view(a), yaml: definitionToYaml(a.definition), runs: store.runs(a.id, 10) };
      },
      /** Recent runs across the automations a workspace may see, optionally filtered. */
      listRuns(callerId: string, args: Record<string, unknown>, privileged = false) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);
        const key = typeof args.automation === 'string' ? args.automation : null;
        const status = typeof args.status === 'string' ? args.status : null;
        const since = typeof args.since === 'number' ? args.since : 0;
        const pool = store.list().filter((a) => (privileged || visible(a, callerId)) && (!key || a.id === key || a.name === key));
        return pool
          .flatMap((a) => store.runs(a.id, 100).map((r) => ({ ...r, automation: a.name })))
          .filter((r) => (!status || r.status === status) && r.startedAt >= since)
          .sort((x, y) => y.startedAt - x.startedAt)
          .slice(0, limit);
      },
      run(callerId: string, args: Record<string, unknown>, privileged = false): { runId: string; status: string } {
        const id = typeof args.id === 'string' ? args.id : '';
        const a = store.get(id) ?? store.byName(id);
        if (!a) throw new Error(`automation ${id || '(missing id)'} not found`);
        if (!privileged && !canRun(a, callerId)) throw new Error(`not permitted: ${a.name} doesn't list this workspace in manual.allowFrom`);
        if (!a.enabled) throw new Error(`${a.name} is disabled`);
        const r = start(a.id, { kind: 'manual', by: { kind: 'workspace', id: callerId }, args: (args.args as Record<string, unknown>) ?? {}, callerSupplied: true });
        return { runId: r.id, status: r.status };
      }
    }
  };

  function visible(a: AutomationRecord, callerId: string): boolean {
    return canRun(a, callerId) || stepWorkspaces(a.definition).includes(callerId);
  }

  function canRun(a: AutomationRecord, callerId: string): boolean {
    return a.definition.triggers.some((t) => 'manual' in t && (t.manual.allowFrom ?? []).includes(callerId));
  }
}

export type AutomationService = ReturnType<typeof createAutomationService>;
export type { ParamValue };
