// Automations service (#407 Phase 3): CRUD from YAML, run orchestration
// (concurrency, rate cap, queueing), the scheduler tick, failure notifications,
// restart recovery, the active-run registry used for todo attribution, and the
// MCP handlers. Pure: Electron/backends are injected (automationIpc.ts).
// Async on the store layer. Concurrency decisions read and write the in-memory
// claims (`claimed`, `queued`) synchronously after the last await, so two
// concurrent starts can't both run (the guarantee the sync store gave for free).
// tick() is serialized so overlapping ticks can't both fire one due slot.
import type { Automation, AutomationDef, EventName, ParamValue, RunRow, RunTriggerKind, TodoSource } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import { AutomationStore, type AutomationRecord } from './automationStore.js';
import { definitionToYaml, parseDefinitionText, parseDuration, stepWorkspaces, validateArgs, validateDefinition, type Validation } from './definition.js';
import { executeRun, type RunnerDeps, type RunOutcome } from './runner.js';
import { dueSchedule, nextFireAt } from './scheduler.js';
import { describeCron } from './cron.js';
import { applyFloor, parseNextRequest } from './reschedule.js';

export interface AutomationDeps extends Omit<RunnerDeps, 'store'> {
  /** Shells this computer offers for host steps (#407); validation checks `shell` against them. */
  hostShells?(): string[] | undefined;
  /** Refusals for this runtime (fleet-host's remoteHostRefusals). */
  checkDefinition?(def: AutomationDef): string[];
  store: AutomationStore;
  /** Resolve a workspace id or name to an id. */
  resolveWorkspace(idOrName: string): string | null;
  notify?: (n: NotifyInput) => unknown;
  changed(): void;
  /** Injected for tests; default setTimeout/clearTimeout (event debounce). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** A timer-started run failed to record (automationIpc logs it). */
  onError?(e: unknown): void;
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

/** A non-manual start of a disabled automation; timer callers skip it quietly. */
class DisabledError extends Error {
  constructor(name: string) { super(`${name} is disabled`); }
}

export function createAutomationService(deps: AutomationDeps) {
  const { store } = deps;
  /** runId → automation + the workspaces its steps target (attribution). */
  const active = new Map<string, { automationId: string; workspaces: Set<string>; next?: { at: number; by: string } }>();
  /** Automation ids with a run starting, running or finishing. */
  const claimed = new Set<string>();
  /** Automation id → its one queued run (the insert's promise). */
  const queued = new Map<string, Promise<RunRow>>();
  const lastStart = new Map<string, number>();
  const inFlight = new Set<Promise<unknown>>();
  const lastEnded = new Map<string, number>();
  const pending = new Map<string, { timer: unknown; event: NonNullable<RunRow['trigger']['event']> }>();
  /** tick() is serialized: two overlapping ticks would both see a slot due and fire it twice. */
  let ticking: Promise<unknown> = Promise.resolve();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v), get hostShells() { return deps.hostShells?.(); }, check: deps.checkDefinition };

  /** Registers a background run for settle(); a failure goes to onError, never an unhandled rejection. */
  function track(p: Promise<unknown>): void {
    const q = p.catch((e) => deps.onError?.(e));
    inFlight.add(q);
    void q.finally(() => inFlight.delete(q));
  }

  async function view(a: AutomationRecord): Promise<Automation> {
    const now = deps.now();
    const [tags, lastRuns, weekStats] = await Promise.all([store.tags(a.id), store.runs(a.id, 1), store.weekStats(a.id, now)]);
    return {
      id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, version: a.version,
      definition: a.definition, tags, createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt,
      lastScheduledAt: a.lastScheduledAt, nextFireAt: nextFireAt(a, now), lastRun: lastRuns[0] ?? null,
      nextSetByRun: a.enabled && a.nextRunAt !== null ? a.nextRunBy : null,
      weekStats,
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

  /** A live run asks to fire next at a time (#437); the last request wins, applied when the run ends. */
  async function requestNext(runId: string, raw: unknown, by: string): Promise<{ requestedAt: number; min: string }> {
    const r = active.get(runId);
    if (!r) throw new Error('that run has ended');
    const a = await store.get(r.automationId);
    const min = a?.definition.reschedule?.min;
    if (!a || !min) throw new Error(`${a?.name ?? 'this automation'} can't set its next run: add reschedule: { min: 30m } to its definition`);
    const p = parseNextRequest(raw, deps.now());
    if (!p.ok) throw new Error(p.error);
    if (active.get(runId) !== r) throw new Error('that run has ended'); // it ended during the await
    r.next = { at: p.at, by };
    return { requestedAt: p.at, min };
  }

  /** At run end: apply the last request if the run went well and the automation is unchanged. */
  async function settleNext(a: AutomationRecord, run: RunRow, outcome: RunOutcome, next: { at: number; by: string } | undefined): Promise<void> {
    if (!next) return;
    const now = deps.now();
    const cur = await store.get(a.id);
    const floorMs = parseDuration(cur?.definition.reschedule?.min);
    const ok = outcome.status === 'succeeded' || outcome.status === 'nothing-to-do';
    const unchanged = cur !== null && cur.enabled && cur.version === a.version && floorMs !== null;
    const drop = (reason: string) => store.setRunReschedule(run.id, { requestedAt: next.at, appliedAt: null, clamped: false, by: next.by, reason });
    const changedReason = 'the automation was changed or disabled during the run';
    if (!ok || !unchanged) {
      await drop(ok ? changedReason : `the run ${outcome.status === 'timed-out' ? 'timed out' : 'failed'}`);
      return;
    }
    const applied = applyFloor(next.at, now, floorMs);
    // Conditional in the store: an edit or disable after the read above wins over this run's request.
    if (!(await store.setNextRun(a.id, applied.at, run.id, { version: a.version, enabled: true }))) {
      await drop(changedReason);
      return;
    }
    await store.setRunReschedule(run.id, { requestedAt: next.at, appliedAt: applied.at, clamped: applied.clamped, by: next.by });
  }

  /** Runs one run to completion. The caller holds claimed[a.id]; it is released here or handed to a promoted queued run. */
  async function execute(a: AutomationRecord, run: RunRow, callerSupplied: boolean): Promise<void> {
    active.set(run.id, { automationId: a.id, workspaces: new Set(stepWorkspaces(a.definition)) });
    deps.changed();
    let outcome: RunOutcome;
    try {
      outcome = await executeRun({ ...deps, requestNext } as RunnerDeps, a, run, { callerSupplied });
    } catch (e) {
      outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    const next = active.get(run.id)?.next;
    active.delete(run.id);
    lastEnded.set(a.id, deps.now());
    let handedOn = false;
    try {
      await store.setRunStatus(run.id, outcome.status, deps.now(), outcome.error);
      await settleNext(a, run, outcome, next);
      if (outcome.status === 'failed' || outcome.status === 'timed-out') failed(a, run, outcome);
      deps.changed();
      // A queued run waits for this one.
      const waiting = queued.get(a.id);
      if (waiting) {
        queued.delete(a.id);
        const q = await waiting;
        const cur = await store.get(a.id);
        if (cur) {
          await store.setRunStatus(q.id, 'running', deps.now());
          const promoted = (await store.getRun(q.id))!;
          handedOn = true;
          track(execute(cur, promoted, q.trigger.by?.kind === 'workspace'));
        }
      }
    } finally {
      if (!handedOn) claimed.delete(a.id);
    }
  }

  async function start(id: string, req: RunRequest): Promise<RunRow> {
    const a = await store.get(id);
    if (!a) throw new Error(`automation ${id} not found`);
    const args = validateArgs(a.definition.params, req.args, req.coerce);
    if (!args.ok) throw new Error(`invalid arguments: ${args.errors.join('; ')}`);
    const trigger = { kind: req.kind, ...(req.by ? { by: req.by } : {}), ...(req.cron ? { cron: req.cron } : {}), ...(req.event ? { event: req.event } : {}) };
    const now = deps.now();
    // --- synchronous from here to each store call: read + claim atomically ---
    // Only a manual run may start a disabled automation (the user's Run now; MCP checks enabled itself).
    if (!a.enabled && req.kind !== 'manual') throw new DisabledError(a.name);
    const running = claimed.has(id);
    const userManual = req.kind === 'manual' && req.by?.kind === 'user';
    const last = lastStart.get(id);
    if (!userManual && last !== undefined && now - last < RATE_MS && !running) {
      return store.startRun(a, trigger, args.value, 'skipped', now, 'rate limit: at most one run per minute');
    }
    if (running) {
      if (a.definition.concurrency === 'queue' && !queued.has(id)) {
        const p = store.startRun(a, trigger, args.value, 'queued', now);
        queued.set(id, p);
        p.catch(() => { if (queued.get(id) === p) queued.delete(id); });
        return p;
      }
      return store.startRun(a, trigger, args.value, 'skipped', now, 'a run was already in progress');
    }
    claimed.add(id);
    lastStart.set(id, now);
    let run: RunRow;
    try {
      run = await store.startRun(a, trigger, args.value, 'running', now);
    } catch (e) {
      claimed.delete(id);
      throw e;
    }
    track(execute(a, run, req.callerSupplied === true));
    return run;
  }

  /** Record a run that failed before starting (bad args, missing automation) and notify. */
  async function failedStart(a: AutomationRecord, trigger: RunRow['trigger'], message: string): Promise<RunRow> {
    const run = await store.startRun(a, trigger, {}, 'failed', deps.now(), message);
    failed(a, run, { status: 'failed', error: message });
    return run;
  }

  async function tickOnce(): Promise<RunRow[]> {
    const now = deps.now();
    const started: RunRow[] = [];
    for (const a of await store.list()) {
      const due = dueSchedule(a, now);
      if (!due) continue;
      // Conditional on the listed snapshot: a disable, edit or fresh run-chosen next fire since the list skips this fire.
      const guard = { version: a.version, enabled: true as const, nextRunAt: a.nextRunAt };
      if (!(await store.setLastScheduled(a.id, now, guard))) continue;
      if (due.kind === 'rescheduled' && !(await store.setNextRun(a.id, null, null, guard))) continue;
      try {
        started.push(await start(a.id, { kind: due.kind, ...(due.cron ? { cron: due.cron } : {}), args: due.args }));
      } catch (e) {
        if (e instanceof DisabledError) continue;
        started.push(await failedStart(a, { kind: due.kind, ...(due.cron ? { cron: due.cron } : {}) }, (e as Error).message));
      }
    }
    if (started.length) deps.changed();
    return started;
  }

  return {
    async list(): Promise<Automation[]> {
      return Promise.all((await store.list()).map(view));
    },
    async get(id: string): Promise<{ automation: Automation; runs: RunRow[]; yaml: string; versions: number[] } | null> {
      const a = await store.get(id);
      if (!a) return null;
      const [automation, runs, versions] = await Promise.all([view(a), store.runs(id, 30), store.versions(id)]);
      return { automation, runs, yaml: definitionToYaml(a.definition), versions: versions.map((v) => v.version) };
    },
    validate(text: string): { ok: boolean; errors: string[] } {
      const r = parse(text);
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors };
    },
    async create(text: string, by: TodoSource): Promise<Automation> {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = await store.create(r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    async update(id: string, text: string, by: TodoSource): Promise<Automation> {
      const r = parse(text);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const a = await store.update(id, r.value, by, deps.now());
      deps.changed();
      return view(a);
    },
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      await store.setEnabled(id, enabled, deps.now());
      deps.changed();
    },
    async remove(id: string): Promise<void> {
      await store.remove(id);
      deps.changed();
    },
    run: start,

    /** Periodic: start whatever schedule is due (one catch-up for missed slots). Serialized. */
    tick(): Promise<RunRow[]> {
      const run = ticking.then(tickOnce);
      ticking = run.catch(() => undefined);
      return run;
    },

    /** A fleet event (#407 Phase 4): start matching event-triggered automations after their debounce. */
    async onEvent(e: FleetEvent): Promise<string[]> {
      const all = await store.list();
      // --- synchronous from here: the pending map is read and written without awaits ---
      const now = deps.now();
      const matched: string[] = [];
      for (const a of all) {
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
          const ended = lastEnded.get(a.id);
          if (claimed.has(a.id) || (ended !== undefined && now - ended < SELF_GUARD_MS)) continue;
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
            const p = (async () => {
              try {
                await start(a.id, { kind: 'event', event: fired.event });
              } catch (err) {
                if (err instanceof DisabledError) return;
                const cur = await store.get(a.id);
                if (cur) await failedStart(cur, { kind: 'event', event: fired.event }, (err as Error).message);
              }
              deps.changed();
            })().catch((err) => deps.onError?.(err));
            track(p);
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
    async recover(): Promise<RunRow[]> {
      const cut = await store.markInterrupted(deps.now());
      if (cut.length) {
        const names = [...new Set(await Promise.all(cut.map(async (r) => (await store.get(r.automationId))?.name ?? 'an automation')))];
        deps.notify?.({
          kind: 'run-failed', title: cut.length === 1 ? `${names[0]} was interrupted` : `${cut.length} automation runs were interrupted`,
          body: `The app quit mid-run (${names.join(', ')}). They are not retried automatically.`, priority: 'normal',
          source: { kind: 'user', id: null }
        });
      }
      await store.pruneRuns(deps.now() - RUN_RETENTION_MS);
      return cut;
    },

    /** A run is starting, running, finishing or queued (the store switch waits for none). */
    hasActiveRuns(): boolean {
      return claimed.size > 0 || queued.size > 0;
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
      async list(callerId: string, privileged = false): Promise<Array<Pick<Automation, 'id' | 'name' | 'description' | 'enabled' | 'nextFireAt'> & { canRun: boolean; params: AutomationDef['params'] }>> {
        return (await store.list())
          .filter((a) => privileged || canRun(a, callerId) || stepWorkspaces(a.definition).includes(callerId))
          .map((a) => ({ id: a.id, name: a.name, description: a.definition.description ?? null, enabled: a.enabled, nextFireAt: nextFireAt(a, deps.now()), canRun: privileged || canRun(a, callerId), params: a.definition.params ?? [] }));
      },
      /** One automation's YAML + recent runs, for workspaces that may see it (all for the automations workspace). */
      async get(callerId: string, args: Record<string, unknown>, privileged = false) {
        const key = typeof args.id === 'string' ? args.id : '';
        const a = (await store.get(key)) ?? (await store.byName(key));
        if (!a || !(privileged || visible(a, callerId))) throw new Error(`automation ${key || '(missing id)'} not found`);
        return { ...(await view(a)), yaml: definitionToYaml(a.definition), runs: await store.runs(a.id, 10) };
      },
      /** Recent runs across the automations a workspace may see, optionally filtered. */
      async listRuns(callerId: string, args: Record<string, unknown>, privileged = false) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);
        const key = typeof args.automation === 'string' ? args.automation : null;
        const status = typeof args.status === 'string' ? args.status : null;
        const since = typeof args.since === 'number' ? args.since : 0;
        const pool = (await store.list()).filter((a) => (privileged || visible(a, callerId)) && (!key || a.id === key || a.name === key));
        const perAutomation = await Promise.all(pool.map(async (a) => (await store.runs(a.id, 100)).map((r) => ({ ...r, automation: a.name }))));
        return perAutomation.flat()
          .filter((r) => (!status || r.status === status) && r.startedAt >= since)
          .sort((x, y) => y.startedAt - x.startedAt)
          .slice(0, limit);
      },
      /** schedule_next (#437): a workspace a live run prompted picks that automation's next fire. */
      async scheduleNext(callerId: string, args: Record<string, unknown>): Promise<{ requestedAt: string; note: string }> {
        const runId = typeof args.run_id === 'string' ? args.run_id : '';
        const r = active.get(runId);
        if (!r || !r.workspaces.has(callerId)) throw new Error('not permitted: run_id must be a live run of an automation that prompted this workspace');
        const raw = { ...(args.in !== undefined ? { in: args.in } : {}), ...(args.at !== undefined ? { at: args.at } : {}) };
        const res = await requestNext(runId, raw, deps.workspaceName(callerId));
        return {
          requestedAt: new Date(res.requestedAt).toISOString(),
          note: `applied when the run ends successfully, never sooner than ${res.min} after it ends; a later request in this run replaces it`
        };
      },
      async run(callerId: string, args: Record<string, unknown>, privileged = false): Promise<{ runId: string; status: string }> {
        const id = typeof args.id === 'string' ? args.id : '';
        const a = (await store.get(id)) ?? (await store.byName(id));
        if (!a) throw new Error(`automation ${id || '(missing id)'} not found`);
        if (!privileged && !canRun(a, callerId)) throw new Error(`not permitted: ${a.name} doesn't list this workspace in manual.allowFrom`);
        if (!a.enabled) throw new Error(`${a.name} is disabled`);
        const r = await start(a.id, { kind: 'manual', by: { kind: 'workspace', id: callerId }, args: (args.args as Record<string, unknown>) ?? {}, callerSupplied: true });
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
