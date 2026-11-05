import { describe, expect, it, vi, type Mock } from 'vitest';
import { defaultCaptureSettings, type CaptureSettings } from '../../preload/captureSettings.js';
import { CaptureScheduler, type SchedulerDeps } from './captureScheduler.js';
import { isCaptureFork, markCaptureFork } from './captureForks.js';
import type { ExecOutcome } from './captureExec.js';
import type { SearchHitEvent } from './searchHits.js';

const NOW = 1_000_000_000;
const OK: ExecOutcome = { exitCode: 0, stdout: JSON.stringify({ session_id: 'x', is_error: false }), stderr: '', timedOut: false };
type Last = { started_at: number; user_turns: number | null } | null;

function setup(o: {
  settingsBy?: Record<string, Partial<CaptureSettings>>; exec?: SchedulerDeps['exec']; last?: (id: string) => Last;
  today?: number; cap?: number; isAutomation?: (id: string) => boolean; globalEnabled?: boolean;
  topTopics?: SchedulerDeps['topTopics']; target?: SchedulerDeps['target']
} = {}) {
  let n = 0;
  const runs = {
    start: vi.fn(async (_o: Record<string, unknown>) => `run${++n}`),
    finish: vi.fn(async (_id: string, _o: Record<string, unknown>) => undefined),
    lastFor: vi.fn(async (id: string) => (o.last ? o.last(id) : null)),
    countSince: vi.fn(async (_ts: number) => o.today ?? 0)
  };
  const exec = vi.fn<SchedulerDeps['exec']>(o.exec ?? (async () => OK));
  const d = {
    runs,
    signals: (id: string) => ({ workspaceId: id.startsWith('b-') ? 'wB' : 'w', model: 'claude-sonnet-5', contextTokens: 175_000, userTurns: 50, compactions: 0 }),
    isAutomation: o.isAutomation ?? (() => false),
    globalEnabled: async () => o.globalEnabled ?? true,
    settings: async (ws: string) => (ws === 'gone' ? null : { ...defaultCaptureSettings(), ...(o.settingsBy?.[ws] ?? {}) }),
    dailyCap: async () => o.cap ?? 40,
    target: o.target ?? (async (ws: string) => ({ kind: 'container' as const, workspaceId: ws, cwd: '/workspace' })),
    topTopics: o.topTopics ?? (async () => []),
    exec,
    fleetToolNames: ['list_sessions', 'record_claim', 'search_claims', 'get_config'],
    newUuid: (() => { let i = 0; return () => `fork-${++i}`; })(),
    now: () => NOW,
    log: () => undefined
  } as unknown as SchedulerDeps;
  return { s: new CaptureScheduler(d), runs, exec };
}
const argsOf = (exec: Mock<SchedulerDeps['exec']>, call = 0): string[] => exec.mock.calls[call][1];
const promptOf = (exec: Mock<SchedulerDeps['exec']>, call = 0): string => { const a = argsOf(exec, call); return a[a.indexOf('-p') + 1]; };
const hit = (over: Partial<SearchHitEvent> = {}): SearchHitEvent => ({
  callerWorkspaceId: 'w', allowedWorkspaces: new Set(['w']), tool: 'search_transcripts', query: 'why did the broker hang', sessionIds: ['s1'], ...over
});

describe('CaptureScheduler — ingest triggers', () => {
  it('captures once when a session crosses the 85% band, registers the fork, books the run', async () => {
    const { s, runs, exec } = setup();
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await s.drain();
    expect(runs.start).toHaveBeenCalledTimes(1);
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', forkSessionId: 'fork-1', trigger: 'ctx-85', userTurns: 50 }));
    expect(isCaptureFork('fork-1')).toBe(true);
    expect(argsOf(exec)).not.toContain('--mcp-config');
    expect(runs.finish).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'done' }));
  });
  it('never captures capture forks, automation sessions, disabled workspaces, or anything when globally off', async () => {
    const a = setup({ isAutomation: (id) => id === 'auto', settingsBy: { off: { enabled: false } } });
    markCaptureFork('forkX');
    a.s.onIngest({ workspaceId: 'w', sessionId: 'auto' });
    a.s.onIngest({ workspaceId: 'off', sessionId: 's2' });
    a.s.onIngest({ workspaceId: 'w', sessionId: 'forkX' });
    await a.s.drain();
    expect(a.runs.start).not.toHaveBeenCalled();
    const b = setup({ globalEnabled: false });
    b.s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await b.s.drain();
    expect(b.runs.start).not.toHaveBeenCalled();
  });
  it('uses the configured model, or the session model for "session", and private visibility', async () => {
    const a = setup({ settingsBy: { w: { model: 'claude-haiku-5', captureVisibility: 'private' } } });
    a.s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await a.s.drain();
    expect(argsOf(a.exec)).toEqual(expect.arrayContaining(['--model', 'claude-haiku-5']));
    expect(promptOf(a.exec)).toContain('visibility "private"');
    const b = setup();
    b.s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await b.s.drain();
    expect(argsOf(b.exec)).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5']));
  });
  it('caps concurrency at 2 and queues the rest', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, exec } = setup({ exec: async () => { await gate; return OK; } });
    for (const id of ['a', 'b', 'c']) s.onIngest({ workspaceId: 'w', sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    expect(exec).toHaveBeenCalledTimes(2);
    release();
    await s.drain();
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it('marks timed-out runs', async () => {
    const { s, runs } = setup({ exec: async () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true }) });
    s.onIngest({ workspaceId: 'w', sessionId: 's9' });
    await s.drain();
    expect(runs.finish).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'timed-out' }));
  });
  it('proceeds with no topics, instead of failing the run, when the topTopics dep throws', async () => {
    const { s, runs, exec } = setup({ topTopics: async () => { throw new Error('embedder unavailable'); } });
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await s.drain();
    expect(promptOf(exec)).not.toMatch(/Prefer existing topic slugs/);
    expect(runs.finish).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'done' }));
  });
});

describe('CaptureScheduler — search hits', () => {
  it("captures the caller's top N distinct sessions with trigger 'search' and the query in the prompt", async () => {
    const { s, runs, exec } = setup({ settingsBy: { w: { searchTopSessions: 2 } } });
    s.onSearchHit(hit({ sessionIds: ['s1', 's1', 's2', 's3'] }));
    await s.drain();
    expect(runs.start.mock.calls.map((c) => [c[0].sessionId, c[0].trigger])).toEqual([['s1', 'search'], ['s2', 'search']]);
    expect(promptOf(exec)).toContain('<<<why did the broker hang>>>');
  });
  it('passes SQL as the query for the query tool', async () => {
    const { s, exec } = setup();
    s.onSearchHit(hit({ tool: 'query', query: 'SELECT 1' }));
    await s.drain();
    expect(promptOf(exec)).toContain('<<<SQL: SELECT 1>>>');
  });
  it("skips sessions outside the caller's read scope and workspaces with capture off", async () => {
    const a = setup();
    a.s.onSearchHit(hit({ sessionIds: ['b-1'] }));
    await a.s.drain();
    expect(a.runs.start).not.toHaveBeenCalled();
    const b = setup({ settingsBy: { wB: { enabled: false } } });
    b.s.onSearchHit(hit({ sessionIds: ['b-1'], allowedWorkspaces: new Set(['w', 'wB']) }));
    await b.s.drain();
    expect(b.runs.start).not.toHaveBeenCalled();
  });
  it('does nothing when the caller has search-hit capture off', async () => {
    const { s, runs } = setup({ settingsBy: { w: { onSearchHit: false } } });
    s.onSearchHit(hit());
    await s.drain();
    expect(runs.start).not.toHaveBeenCalled();
  });
  it("ignores a hit from a workspace with a running capture (a fork's own search_claims can't cascade), then queues normally once it finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, runs, exec } = setup({ exec: async () => { await gate; return OK; } });
    s.onIngest({ workspaceId: 'w', sessionId: 's1' }); // starts a capture for workspace 'w', held open by the gate
    await new Promise((r) => setTimeout(r, 20));
    expect(exec).toHaveBeenCalledTimes(1);
    s.onSearchHit(hit({ callerWorkspaceId: 'w', sessionIds: ['s2'] })); // the fork's own search_claims call
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.start).toHaveBeenCalledTimes(1); // nothing queued for s2
    release();
    await s.drain();
    expect(runs.start).toHaveBeenCalledTimes(1);
    s.onSearchHit(hit({ callerWorkspaceId: 'w', sessionIds: ['s2'] })); // a real hit once 'w' is idle again
    await s.drain();
    expect(runs.start.mock.calls.map((c) => c[0].sessionId)).toEqual(['s1', 's2']);
  });
  it('two overlapping search hits for the same session re-check the interval at admit and result in exactly one capture', async () => {
    // Both hits reach the single-flight/interval pre-checks in considerSearch
    // (await settings + runs.lastFor) before either has enqueued, so without
    // the admit()-time re-check both would be admitted — one right after the
    // other finishes. Gate exec so the first run stays in-flight long enough
    // for the second hit's own pre-checks to run and queue behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, runs, exec } = setup({ exec: async () => { await gate; return OK; } });
    s.onSearchHit(hit({ sessionIds: ['s1'] }));
    s.onSearchHit(hit({ sessionIds: ['s1'] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(exec).toHaveBeenCalledTimes(1); // only the first hit's run actually started
    expect(runs.start).toHaveBeenCalledTimes(1);
    release();
    await s.drain();
    // The second hit's queued trigger is admitted right after the first
    // finishes but dropped at admit (same session, well inside 10 min).
    expect(runs.start).toHaveBeenCalledTimes(1);
  });
  it('drops an ingest band trigger that is admitted right after a search-hit capture for the same session, arriving between pump and admit', async () => {
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>((r) => { releaseTarget = r; });
    let first = true;
    const { s, runs } = setup({
      target: async (ws: string) => {
        if (first) { first = false; await targetGate; }
        return { kind: 'container' as const, workspaceId: ws, cwd: '/workspace' };
      }
    });
    // Starts a capture for s1 via a search hit; pump() has already added s1 to
    // inFlight, but run() is paused awaiting target() — i.e. between pump and admit.
    s.onSearchHit(hit({ sessionIds: ['s1'] }));
    await new Promise((r) => setTimeout(r, 20));
    // First-ever ingest decision for s1 crosses the 85% band and queues behind
    // the in-flight session (pump() skips sessions already in-flight).
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 20));
    releaseTarget();
    await s.drain();
    expect(runs.start).toHaveBeenCalledTimes(1);
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', trigger: 'search' }));
  });
  it('recaptures only after recaptureAfterTurns new user turns and 10 minutes', async () => {
    const recent = setup({ last: () => ({ started_at: NOW - 20 * 60_000, user_turns: 40 }) });
    recent.s.onSearchHit(hit());
    await recent.s.drain();
    expect(recent.runs.start).not.toHaveBeenCalled();
    const grown = setup({ last: () => ({ started_at: NOW - 20 * 60_000, user_turns: 10 }) });
    grown.s.onSearchHit(hit());
    await grown.s.drain();
    expect(grown.runs.start).toHaveBeenCalledTimes(1);
    const tooSoon = setup({ last: () => ({ started_at: NOW - 5 * 60_000, user_turns: 0 }) });
    tooSoon.s.onSearchHit(hit());
    await tooSoon.s.drain();
    expect(tooSoon.runs.start).not.toHaveBeenCalled();
  });
});

describe('CaptureScheduler — daily cap', () => {
  it('drops and counts triggers once the cap is reached; cap 0 means none', async () => {
    const a = setup({ today: 40 });
    a.s.onSearchHit(hit());
    await a.s.drain();
    expect(a.runs.start).not.toHaveBeenCalled();
    expect(a.s.droppedOverDailyCap).toBe(1);
    const b = setup({ cap: 0 });
    b.s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await b.s.drain();
    expect(b.runs.start).not.toHaveBeenCalled();
  });
});
