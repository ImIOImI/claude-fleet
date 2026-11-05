// Knowledge capture (#483 §5): background capture scheduler. Two trigger
// sources: ingest (context bands / periodic turns, via the pure policy) and
// search hits (sessions referenced by search_transcripts / search_claims /
// query results). Queues per session (newest trigger wins), caps concurrency
// at 2 and the day at the global daily cap, and books every run.
import type { CaptureSettings } from '../../preload/captureSettings.js';
import type { CaptureSignals } from '../db.js';
import { captureArgs, capturePrompt, parseCaptureOutput } from './captureCommand.js';
import type { CaptureTarget, ExecOutcome } from './captureExec.js';
import { isCaptureFork, markCaptureFork } from './captureForks.js';
import { CAPTURE_MIN_INTERVAL_MS, decideCapture, policyFromSettings, type SessionCaptureState } from './capturePolicy.js';
import { startOfLocalDay, type CaptureRunStore, type CaptureTrigger } from './captureRunStore.js';
import type { SearchHitEvent } from './searchHits.js';

export const MAX_CONCURRENT_CAPTURES = 2;
export const CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const QUEUE_TTL_MS = 15 * 60_000;

export interface SchedulerDeps {
  runs: Pick<CaptureRunStore, 'start' | 'finish' | 'lastFor' | 'countSince'>;
  signals: (sessionId: string) => CaptureSignals | null;
  isAutomation: (sessionId: string) => boolean;
  globalEnabled: () => Promise<boolean>;
  /** Effective settings for a workspace; null when it has no manifest. */
  settings: (workspaceId: string) => Promise<CaptureSettings | null>;
  dailyCap: () => Promise<number>;
  target: (workspaceId: string) => Promise<CaptureTarget | null>;
  topTopics: (workspaceId: string) => Promise<string[]>;
  exec: (target: CaptureTarget, args: string[], timeoutMs: number) => Promise<ExecOutcome>;
  newUuid: () => string;
  now: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Pending {
  workspaceId: string; sessionId: string; model: string | null; userTurns: number;
  trigger: CaptureTrigger; query: string | null; queuedAt: number;
}

export class CaptureScheduler {
  private readonly state = new Map<string, SessionCaptureState>();
  private readonly priorRun = new Map<string, boolean>();
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
    if (this.d.isAutomation(e.sessionId) || !(await this.d.globalEnabled())) return;
    const settings = await this.d.settings(e.workspaceId);
    if (!settings?.enabled) return;
    const sig = this.d.signals(e.sessionId);
    if (!sig) return;
    const now = this.d.now();
    // A search-hit capture just ran: leave the policy state untouched so a
    // band crossed meanwhile still fires once the interval has passed.
    if (this.recentlyStarted(e.sessionId, now)) return;
    if (!this.priorRun.has(e.sessionId)) this.priorRun.set(e.sessionId, !!(await this.d.runs.lastFor(e.sessionId)));
    const { trigger, next } = decideCapture(sig, this.state.get(e.sessionId), this.priorRun.get(e.sessionId) ?? true,
      policyFromSettings(settings), now);
    this.state.set(e.sessionId, next);
    if (!trigger) return;
    this.priorRun.set(e.sessionId, true);
    this.enqueue({ workspaceId: e.workspaceId, sessionId: e.sessionId, model: this.modelFor(settings, sig), userTurns: sig.userTurns, trigger, query: null, queuedAt: now });
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
      if (isCaptureFork(sessionId) || this.d.isAutomation(sessionId) || this.inFlight.has(sessionId)) continue;
      const sig = this.d.signals(sessionId);
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
      this.priorRun.set(sessionId, true);
      this.enqueue({ workspaceId: sig.workspaceId, sessionId, model: this.modelFor(own, sig), userTurns: sig.userTurns, trigger: 'search', query, queuedAt: now });
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
   *  two concurrent starts can't both squeeze under the cap. */
  private admit(p: Pending, forkSessionId: string): Promise<string | null> {
    const next = this.admitting.then(async () => {
      const now = this.d.now();
      const cap = await this.d.dailyCap();
      if ((await this.d.runs.countSince(startOfLocalDay(now))) >= cap) {
        this.dropped++;
        this.d.log('capture-dropped-daily-cap', { sessionId: p.sessionId, trigger: p.trigger, cap, droppedOverDailyCap: this.dropped });
        return null;
      }
      this.lastStartedAt.set(p.sessionId, now);
      return this.d.runs.start({ workspaceId: p.workspaceId, sessionId: p.sessionId, forkSessionId, trigger: p.trigger, userTurns: p.userTurns, now });
    });
    this.admitting = next.catch(() => undefined);
    return next;
  }

  private async run(p: Pending): Promise<void> {
    if (!(await this.d.globalEnabled())) return;
    const settings = await this.d.settings(p.workspaceId);
    if (!settings?.enabled) return; // switched off while queued
    const target = await this.d.target(p.workspaceId);
    if (!target) return;
    const forkSessionId = this.d.newUuid();
    markCaptureFork(forkSessionId);
    const runId = await this.admit(p, forkSessionId);
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
      // No mcpConfigPath: runCapture appends --mcp-config for local targets itself (Task 8 fix).
      const out = await this.d.exec(target, captureArgs({ prompt, sessionId: p.sessionId, forkSessionId, model: p.model }), CAPTURE_TIMEOUT_MS);
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

  stop(): void { this.stopped = true; this.queue.clear(); }
}
