// End-to-end wiring of the capture pipeline (#483): the real scheduler books a
// run in the real CaptureRunStore, the fork's prompt carries the run token, the
// fake fork records through the real ClaimService with that token, and the
// claim's provenance + the run's bookkeeping come out right.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCaptureSettings, type CaptureSettings } from '../../preload/captureSettings.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { CaptureRunStore } from './captureRunStore.js';
import { CaptureScheduler, type SchedulerDeps } from './captureScheduler.js';
import { ClaimService } from './claimService.js';
import { ClaimStore } from './claimStore.js';

const NOW = 2_000_000_000;
let inbox: InboxStore; let runs: CaptureRunStore; let claims: ClaimService;
beforeEach(() => {
  inbox = InboxStore.memory();
  runs = new CaptureRunStore(inbox.kysely);
  claims = new ClaimService({ claims: new ClaimStore(inbox.kysely), runs, embed: null, workspaceName: async () => 'ws', now: () => NOW });
});
afterEach(() => inbox.close());

function scheduler(settings: Partial<CaptureSettings> = {}): { s: CaptureScheduler; forkArgs: string[][] } {
  const forkArgs: string[][] = [];
  const d: SchedulerDeps = {
    runs,
    signals: () => ({ workspaceId: 'wsA', model: 'claude-sonnet-5', contextTokens: 180_000, userTurns: 12, compactions: 0 }),
    isAutomation: () => false,
    globalEnabled: async () => true,
    settings: async () => ({ ...defaultCaptureSettings(), ...settings }),
    dailyCap: async () => 40,
    target: async (ws) => ({ kind: 'container', workspaceId: ws, cwd: '/workspace' }),
    topTopics: async () => [],
    // The fake fork: read the run token from the prompt, as the real fork does,
    // and record through the MCP handler's ClaimService as the workspace.
    exec: async (_t, args) => {
      forkArgs.push(args);
      const prompt = args[args.indexOf('-p') + 1];
      const token = /capture_run "([^"]+)"/.exec(prompt)?.[1];
      await claims.record('wsA', { text: 'the broker hang was a stale socat bridge', kind: 'root-cause', topics: ['broker'], capture_run: token });
      await claims.record('wsA', { text: 'reconnecting bridges replace one-shot socat', kind: 'decision', topics: ['broker'], capture_run: token });
      return { exitCode: 0, stdout: JSON.stringify({ session_id: args[args.indexOf('--session-id') + 1], is_error: false, total_cost_usd: 0.1 }), stderr: '', timedOut: false };
    },
    fleetToolNames: ['record_claim', 'search_claims', 'get_config'],
    newUuid: () => 'fork-uuid-1',
    now: () => NOW,
    log: () => undefined
  };
  return { s: new CaptureScheduler(d), forkArgs };
}

describe('capture pipeline (scheduler → run store → fork → record_claim)', () => {
  it('stamps the live session as provenance, counts claims, and finishes the run done', async () => {
    const { s, forkArgs } = scheduler();
    s.onIngest({ workspaceId: 'wsA', sessionId: 'live-session' });
    await s.drain();

    expect(forkArgs).toHaveLength(1);
    const run = await runs.lastFor('live-session');
    expect(run).toMatchObject({
      workspace_id: 'wsA', fork_session_id: 'fork-uuid-1', trigger: 'ctx-85', status: 'done',
      claims_recorded: 2, user_turns: 12, visibility: 'fleet', compactions: 0
    });
    const sources = await inbox.kysely.selectFrom('claim_sources').selectAll().orderBy('id').execute();
    expect(sources).toHaveLength(2);
    expect(sources.every((r) => r.session_id === 'live-session' && r.via === 'capture' && r.capture_run === run!.id && r.workspace_id === 'wsA')).toBe(true);
    // The run is no longer running, so its token can't be replayed.
    await expect(claims.record('wsA', { text: 'late', kind: 'fact', topics: ['broker'], capture_run: run!.id })).rejects.toThrow(/capture_run/);
  });

  it('forces private claims for a workspace capturing privately, whatever the fork asked for', async () => {
    const { s } = scheduler({ captureVisibility: 'private' });
    s.onIngest({ workspaceId: 'wsA', sessionId: 'live-session' });
    await s.drain();
    const rows = await inbox.kysely.selectFrom('claims').select(['visibility']).execute();
    expect(rows.map((r) => r.visibility)).toEqual(['private', 'private']);
    expect((await claims.search('wsB', { query: 'broker' })).results).toEqual([]);
  });
});
