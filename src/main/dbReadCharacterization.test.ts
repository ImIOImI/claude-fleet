// state.db read characterization (async store part 2b). Recorded on the
// pre-port synchronous reads; every later version of the read path must
// reproduce it unmodified. `await` on a sync return is a no-op, so the same
// file runs on both sides.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from './db.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';
import { WS, S, FIXTURE } from './state/ingestFixture.js';

const WS2 = '01WSREADS2';
const S2 = 'sess-reads-2';
const S2_LINES = [
  JSON.stringify({ type: 'user', uuid: 'r1', timestamp: '2026-07-01T01:00:00.000Z', message: { role: 'user', content: 'second workspace prompt' } }),
  JSON.stringify({ type: 'assistant', uuid: 'r2', timestamp: '2026-07-01T01:00:05.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 4, output_tokens: 9, service_tier: 'priority' }, content: [{ type: 'text', text: 'ok' }] } }),
  // Two tagged chapters: listSessions must report the latest one's tags.
  JSON.stringify({ type: 'session-summary', summary: 'Older chapter.', tags: ['old'], model: 'haiku', fromEventTs: '2026-07-01T01:00:00.000Z', toEventTs: '2026-07-01T01:00:05.000Z', timestamp: '2026-07-01T01:00:06.000Z' }),
  JSON.stringify({ type: 'assistant', uuid: 'r3', timestamp: '2026-07-01T01:00:07.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } }),
  JSON.stringify({ type: 'session-summary', summary: 'Newer chapter.', tags: ['new', 'tags'], model: 'haiku', fromEventTs: '2026-07-01T01:00:00.000Z', toEventTs: '2026-07-01T01:00:07.000Z', timestamp: '2026-07-01T01:00:08.000Z' }),
];

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cf-read-char-'));
  db.openDb(dir);
  for (const line of FIXTURE) await db.ingestLine(WS, S, line);
  for (const line of S2_LINES) await db.ingestLine(WS2, S2, line);
  await db.learnBrokerSessionMapping(WS, 'tab-1', S);
  await db.learnBrokerSessionMapping(WS2, 'auto-run1-step1', S2);
  const [turn] = await db.unembeddedTurnEvents(S, EMBED_MODEL_ID, 1);
  await db.insertEmbedding({
    workspaceId: WS, sessionId: S, kind: 'turn', refEventId: turn.id, ts: turn.ts, text: 'x',
    modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${turn.id}`,
  });
});
afterEach(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

it('every state.db read returns the recorded value', async () => {
  const insideWindow = Date.UTC(2026, 6, 1, 14);
  const reads = {
    eventsForSession: (await db.eventsForSession(S)).map(({ rawJsonl, ...e }) => ({ ...e, rawLen: rawJsonl.length })),
    eventsForSessionPage: (await db.eventsForSession(S, 3, 2)).map((e) => e.id),
    getSession: await db.getSession(S),
    getSessionMissing: await db.getSession('nope'),
    summaryForWorkspace: await db.summaryForWorkspace(WS),
    summaryForWorkspaceEmpty: await db.summaryForWorkspace('01WSNONE'),
    summaryForSessionTop1: await db.summaryForSession(S, 1),
    summaryForBrokerSession: await db.summaryForBrokerSession(WS, 'tab-1'),
    summaryForBrokerSessionUnmapped: await db.summaryForBrokerSession(WS, 'tab-none'),
    recentToolCallsForSession: await db.recentToolCallsForSession(S, 2),
    costSeriesForSession: await db.costSeriesForSession(S, 2),
    tokenSeriesForSession: await db.tokenSeriesForSession(S),
    tokensSpentSince: await db.tokensSpentSince(0),
    tokensSpentSinceLater: await db.tokensSpentSince(Date.UTC(2026, 6, 1, 0, 30)),
    costForSession: await db.costForSession(S),
    costForWorkspace: await db.costForWorkspace(WS2),
    planUsageRows: await db.planUsageRows(0, Date.UTC(2027, 0, 1)),
    latestAnchorCovering: await db.latestAnchorCovering(insideWindow),
    latestAnchorCoveringNone: await db.latestAnchorCovering(0),
    latestLimitHitAnchor: await db.latestLimitHitAnchor(),
    listSessions: await db.listSessions(),
    listSessionsWs2: await db.listSessions(WS2),
    lookupBrokerSession: await db.lookupBrokerSession(WS, 'tab-1'),
    lookupBrokerSessionNone: await db.lookupBrokerSession(WS, 'tab-none'),
    lookupVerifiedBrokerSession: await db.lookupVerifiedBrokerSession(WS2, 'auto-run1-step1'),
    lookupResumableBrokerSession: await db.lookupResumableBrokerSession(WS, 'tab-1'),
    unembeddedTurnEvents: (await db.unembeddedTurnEvents(S, EMBED_MODEL_ID)).map((t) => [t.id, t.workspaceId, t.ts, t.rawJsonl.length]),
    unembeddedSummaries: await db.unembeddedSummaries(EMBED_MODEL_ID),
    maxEventId: await db.maxEventId(S),
    maxEventIdNone: await db.maxEventId('nope'),
  };
  expect(reads).toMatchSnapshot();
});
