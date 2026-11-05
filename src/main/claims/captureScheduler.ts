// Knowledge capture (#483 §5): background capture scheduler. Two trigger
// sources: ingest (context bands / periodic turns, via the pure policy) and
// search hits (sessions referenced by search_transcripts / search_claims /
// query results). Queues per session (newest trigger wins), caps concurrency
// at 2 and the day at the global daily cap, and books every run.
import type { CaptureSettings, CaptureVisibility } from '../../preload/captureSettings.js';
import type { CaptureSignals } from '../db.js';
import { captureArgs, capturePrompt, parseCaptureOutput } from './captureCommand.js';
import type { CaptureTarget, ExecOutcome } from './captureExec.js';
import { isCaptureFork, markCaptureFork } from './captureForks.js';
import { CAPTURE_MIN_INTERVAL_MS, decideCapture, policyFromSettings, seedCaptureState, type SessionCaptureState } from './capturePolicy.js';
import { startOfLocalDay, type CaptureRunStore, type CaptureTrigger } from './captureRunStore.js';
import type { SearchHitEvent } from './searchHits.js';

export const MAX_CONCURRENT_CAPTURES = 2;
export const CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const QUEUE_TTL_MS = 15 * 60_000;

export interface SchedulerDeps {
  runs: Pick<CaptureRunStore, 'start' | 'finish' | 'lastFor' | 'countSince'>;
  /** Async state.db reads (db.ts sessionCaptureSignals / isAutomationSession). */
  signals: (sessionId: string) => Promise<CaptureSignals | null>;
  isAutomation: (sessionId: string) => Promise<boolean>;
  globalEnabled: () => Promise<boolean>;
  /** Effective settings for a workspace; null when it has no manifest. */
  settings: (workspaceId: string) => Promise<CaptureSettings | null>;
  dailyCap: () => Promise<number>;
  target: (workspaceId: string) => Promise<CaptureTarget | null>;
  topTopics: (workspaceId: string) => Promise<string[]>;
  exec: (target: CaptureTarget, args: string[], timeoutMs: number) => Promise<ExecOutcome>;
  /** Every fleet-state MCP tool name (mcpServer TOOLS) — all but the capture
   *  tools are passed to the fork as --disallowedTools. */
  fleetToolNames: readonly string[];
  newUuid: () => string;
  now: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Kill in-flight fork processes (captureExec.ts:killLocalCaptures); called by stop(). */
  killInFlight?: () => void;
}

interface Pending {
  workspaceId: string; sessionId: string; model: string | null; userTurns: number;
  trigger: CaptureTrigger; query: string | null; queuedAt: number; compactions: number;
}

export class CaptureScheduler {
  private readonly state = new Map<string, SessionCaptureState>();
  private readonly lastStartedAt = new Map<string, number>();
  private readonly queue = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  // Refcounted by workspace id (a fork's own workspace can have at most
  // MAX_CONCURRENT_CAPTURES running, but never more than one in practice today).
  // Used to break the cascade where a capture fork's own search_claims call
  // (the prompt tells every fork to search before recording) reports a search
  // hit from its own workspace and would otherwise queue a second capture.
  private readonly inFlightWorkspaces = new Map<string, number>();
  private readonly checking = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private admitting: Promise<unknown> = Promise.resolve();
  private dropped = 0;
  private stopped = false;

  constructor(private readonly d: SchedulerDeps) {}

  /** Triggers dropped by the daily cap since app start. */
  get droppedOverDailyCap(): number { return this.dropped; }

  onIngest(e: { workspaceId: string; sessionId: string }): void {
    if (this.stopped || isCaptureFork(e.sessionId) || this.checking.has(e.sessionId)) return;
    this.checking.add(e.sessionId);
    this.track(this.considerIngest(e).finally(() => this.checking.delete(e.sessionId)), 'capture-consider-failed');
  }

  onSearchHit(e: SearchHitEvent): void {
    if (this.stopped || e.sessionIds.length === 0) return;
    this.track(this.considerSearch(e), 'capture-search-hit-failed');
  }

  private track(p: Promise<void>, failType: string): void {
    const t: Promise<void> = p
      .catch((err) => this.d.log(failType, { error: String(err) }))
      .finally(() => { this.active.delete(t); });
    this.active.add(t);
  }

  private modelFor(s: CaptureSettings, sig: CaptureSignals): string | null {
    return s.model === 'session' ? sig.model : s.model;
  }

  private recentlyStarted(sessionId: string, now: number): boolean {
    const t = this.lastStartedAt.get(sessionId);
    return t !== undefined && now - t < CAPTURE_MIN_INTERVAL_MS;
  }

  private async considerIngest(e: { workspaceId: string; sessionId: string }): Promise<void> {
    if ((await this.d.isAutomation(e.sessionId)) || !(await this.d.globalEnabled())) return;
    const settings = await this.d.settings(e.workspaceId);
    if (!settings?.enabled) return;
    const sig = await this.d.signals(e.sessionId);
    if (!sig) return;
    const now = this.d.now();
    // A search-hit capture just ran: leave the policy state untouched so a
    // band crossed meanwhile still fires once the interval has passed.
    if (this.recentlyStarted(e.sessionId, now)) return;
    const policy = policyFromSettings(settings);
    // First sight of this session in this app run: rebuild its policy state
    // from the last persisted run, so a restart doesn't re-fire a band that
    // already captured (and a never-captured session captures its history once).
    const state = this.state.get(e.sessionId) ?? seedCaptureState(sig, await this.d.runs.lastFor(e.sessionId), policy);
    const { trigger, next } = decideCapture(sig, state, true, policy, now);
    this.state.set(e.sessionId, next);
    if (!trigger) return;
    // The fork id (in run()/admit()) is marked only once the run is actually
    // admitted — a cap-dropped or TTL-expired trigger never ran.
    this.enqueue({ workspaceId: e.workspaceId, sessionId: e.sessionId, model: this.modelFor(settings, sig), userTurns: sig.userTurns, compactions: sig.compactions, trigger, query: null, queuedAt: now });
  }

  private async considerSearch(e: SearchHitEvent): Promise<void> {
    // A capture fork's own search_claims call (every capture prompt tells the
    // fork to search before recording) arrives here as a search hit from its
    // workspace, since MCP identity is per workspace: ignore it entirely while
    // that workspace has a running capture, so it can't cascade into capturing
    // itself again. A hit queued once that capture finishes is a normal hit.
    if (this.inFlightWorkspaces.has(e.callerWorkspaceId)) return;
    if (!(await this.d.globalEnabled())) return;
    const caller = await this.d.settings(e.callerWorkspaceId);
    if (!caller?.enabled || !caller.onSearchHit) return;
    const query = e.tool === 'query' ? `SQL: ${e.query}` : e.query;
    for (const sessionId of [...new Set(e.sessionIds)].slice(0, caller.searchTopSessions)) {
      if (isCaptureFork(sessionId) || this.inFlight.has(sessionId) || (await this.d.isAutomation(sessionId))) continue;
      const sig = await this.d.signals(sessionId);
      if (!sig || !e.allowedWorkspaces.has(sig.workspaceId)) continue;
      const own = sig.workspaceId === e.callerWorkspaceId ? caller : await this.d.settings(sig.workspaceId);
      if (!own?.enabled) continue;
      const now = this.d.now();
      if (this.recentlyStarted(sessionId, now)) continue;
      const last = await this.d.runs.lastFor(sessionId);
      if (last) {
        if (now - last.started_at < CAPTURE_MIN_INTERVAL_MS) continue;
        if (sig.userTurns - (last.user_turns ?? 0) < own.recaptureAfterTurns) continue;
      }
      this.enqueue({ workspaceId: sig.workspaceId, sessionId, model: this.modelFor(own, sig), userTurns: sig.userTurns, compactions: sig.compactions, trigger: 'search', query, queuedAt: now });
    }
  }

  private enqueue(p: Pending): void {
    this.queue.set(p.sessionId, p); // newest trigger for a session replaces a queued one
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.inFlight.size < MAX_CONCURRENT_CAPTURES) {
      const next = [...this.queue.values()].find((p) => !this.inFlight.has(p.sessionId));
      if (!next) return;
      this.queue.delete(next.sessionId);
      if (this.d.now() - next.queuedAt > QUEUE_TTL_MS) continue;
      this.inFlight.add(next.sessionId);
      this.inFlightWorkspaces.set(next.workspaceId, (this.inFlightWorkspaces.get(next.workspaceId) ?? 0) + 1);
      const p: Promise<void> = this.run(next)
        .catch((err) => this.d.log('capture-run-failed', { sessionId: next.sessionId, error: String(err) }))
        .finally(() => {
          this.inFlight.delete(next.sessionId);
          const n = (this.inFlightWorkspaces.get(next.workspaceId) ?? 1) - 1;
          if (n <= 0) this.inFlightWorkspaces.delete(next.workspaceId); else this.inFlightWorkspaces.set(next.workspaceId, n);
          this.active.delete(p);
          this.pump();
        });
      this.active.add(p);
    }
  }

  /** The daily-cap check and the run insert happen as one serialized step, so
   *  two concurrent starts can't both squeeze under the cap. considerIngest/
   *  considerSearch's single-flight and ≥10-min-interval checks run *before*
   *  this step (they await settings and runs.lastFor), so two overlapping
   *  triggers for the same session can both clear them before either
   *  enqueues — and pump() only skips a session that's already in-flight, so
   *  the second trigger just queues behind the first and gets admitted right
   *  after it finishes. Re-check both guards here, against the in-memory
   *  start time and the persisted run, so a trigger that arrives (or is
   *  merely queued) too soon after another is dropped instead of running
   *  back-to-back. Only a run that actually gets admitted here marks the
   *  fork id and books a run row (which later seeds the policy state) — a
   *  cap- or interval-dropped trigger never ran, so it must not count as one. */
  private admit(p: Pending, forkSessionId: string, visibility: CaptureVisibility): Promise<string | null> {
    const next = this.admitting.then(async () => {
      const now = this.d.now();
      if (this.recentlyStarted(p.sessionId, now)) {
        this.d.log('capture-dropped-recent', { sessionId: p.sessionId, trigger: p.trigger, reason: 'in-memory interval' });
        return null;
      }
      const last = await this.d.runs.lastFor(p.sessionId);
      if (last && now - last.started_at < CAPTURE_MIN_INTERVAL_MS) {
        this.d.log('capture-dropped-recent', { sessionId: p.sessionId, trigger: p.trigger, reason: 'persisted interval' });
        return null;
      }
      const cap = await this.d.dailyCap();
      if ((await this.d.runs.countSince(startOfLocalDay(now))) >= cap) {
        this.dropped++;
        this.d.log('capture-dropped-daily-cap', { sessionId: p.sessionId, trigger: p.trigger, cap, droppedOverDailyCap: this.dropped });
        return null;
      }
      this.lastStartedAt.set(p.sessionId, now);
      markCaptureFork(forkSessionId);
      return this.d.runs.start({
        workspaceId: p.workspaceId, sessionId: p.sessionId, forkSessionId, trigger: p.trigger, userTurns: p.userTurns,
        visibility, compactions: p.compactions, now
      });
    });
    this.admitting = next.catch(() => undefined);
    return next;
  }

  private async run(p: Pending): Promise<void> {
    if (!(await this.d.globalEnabled())) return;
    const settings = await this.d.settings(p.workspaceId);
    if (!settings?.enabled) return; // switched off while queued
    const target = await this.d.target(p.workspaceId);
    if (!target) { this.d.log('capture-skipped-no-target', { sessionId: p.sessionId, workspaceId: p.workspaceId, trigger: p.trigger }); return; }
    const forkSessionId = this.d.newUuid();
    const runId = await this.admit(p, forkSessionId, settings.captureVisibility);
    if (!runId) return;
    try {
      // A topics lookup failure (e.g. the embedder is unavailable) shouldn't
      // fail the whole run — the fork still records useful claims without the
      // "prefer existing topic slugs" hint.
      const topTopics = await this.d.topTopics(p.workspaceId).catch((err) => {
        this.d.log('capture-top-topics-failed', { workspaceId: p.workspaceId, error: String(err) });
        return [] as string[];
      });
      const prompt = capturePrompt({ runToken: runId, topTopics, searchQuery: p.query, visibility: settings.captureVisibility });
      // runCapture appends the backend's fleet-state-only --mcp-config (strict MCP).
      const out = await this.d.exec(target, captureArgs({ prompt, sessionId: p.sessionId, forkSessionId, model: p.model, fleetToolNames: this.d.fleetToolNames }), CAPTURE_TIMEOUT_MS);
      if (out.timedOut) {
        await this.d.runs.finish(runId, { status: 'timed-out', usage: null, error: `timed out after ${CAPTURE_TIMEOUT_MS / 1000}s`, now: this.d.now() });
        return;
      }
      const parsed = parseCaptureOutput(out.stdout);
      await this.d.runs.finish(runId, {
        status: parsed.ok && out.exitCode === 0 ? 'done' : 'failed', usage: parsed.usage,
        error: parsed.error ?? (out.exitCode === 0 ? null : `exit ${out.exitCode}: ${out.stderr.slice(0, 300)}`), now: this.d.now()
      });
    } catch (err) {
      await this.d.runs.finish(runId, { status: 'failed', usage: null, error: String(err), now: this.d.now() });
    }
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  /** Stop scheduling and kill in-flight local/WSL forks (app quit). Their runs
   *  are failed at the next startup (failRunning) if not finished by then. */
  stop(): void { this.stopped = true; this.queue.clear(); this.d.killInFlight?.(); }
}
