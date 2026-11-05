import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDriver, SqliteDriver } from 'kysely';
import { openDb, closeDb, recordError, learnBrokerSessionMapping, recordBrokerSessionMapping, lookupBrokerSession, lookupVerifiedBrokerSession, lookupResumableBrokerSession, listSessions, summaryForBrokerSession, ingestLine, ERRORS_RETENTION, recordUsageEvent, __pendingClaudeIdsForTest } from './db.js';
import { openTestState, queryRows, isPg, type TestState } from './store/testStore.js';

/** The driver whose commitTransaction the store's transactions end in. */
const driverProto: Pick<SqliteDriver, 'commitTransaction'> = isPg ? PostgresDriver.prototype : SqliteDriver.prototype;

// A minimal well-formed transcript line that makes `sessionId` a *real*
// session (any ingested line upserts the sessions row). The `user` string
// content also populates first_user_message so summaries resolve a title.
async function realSession(workspaceId: string, sessionId: string, prompt = 'hello there'): Promise<void> {
  await ingestLine(
    workspaceId,
    sessionId,
    JSON.stringify({
      type: 'user',
      uuid: `u-${sessionId}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: prompt },
    }),
  );
}

let st: TestState | null = null;
async function freshDb(): Promise<string> {
  st = await openTestState('cf-db-');
  return st.dir;
}

// Mirrors db.ts's private `pendingKey` (NUL-separated).
const pendingKeyForTest = (workspaceId: string, claudeSessionId: string): string =>
  `${workspaceId}\0${claudeSessionId}`;

afterEach(async () => {
  await st?.close();
  st = null;
});

describe('recordError', () => {
  it('inserts a row with all fields', async () => {
    const dir = await freshDb();
    try {
      await recordError({ ts: 1000, source: 'main', type: 'pty-attach-failed', message: 'boom',
        level: 'error', workspaceId: 'ws-a', extra: { foo: 1 } });
      const row = (await queryRows('SELECT * FROM errors'))[0] as Record<string, unknown>;
      expect(row.type).toBe('pty-attach-failed');
      expect(row.workspace_id).toBe('ws-a');
      expect(row.level).toBe('error');
      expect(JSON.parse(row.extra as string)).toEqual({ foo: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves session_id from a broker id in extra via the mapping', async () => {
    const dir = await freshDb();
    try {
      await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-uuid-1');
      await recordError({ ts: 1, source: 'main', type: 'x', message: 'm', workspaceId: 'ws-a',
        extra: { brokerSessionId: 'broker-1' } });
      const row = (await queryRows('SELECT session_id FROM errors'))[0] as { session_id: string };
      expect(row.session_id).toBe('claude-uuid-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves session_id NULL when the broker mapping is absent', async () => {
    const dir = await freshDb();
    try {
      await recordError({ ts: 1, source: 'main', type: 'mapping-unresolved', message: 'm',
        level: 'warn', workspaceId: 'ws-a', extra: { brokerSessionId: 'unmapped' } });
      const row = (await queryRows('SELECT session_id FROM errors'))[0] as { session_id: string | null };
      expect(row.session_id).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prunes to the most recent ERRORS_RETENTION rows', async () => {
    const dir = await freshDb();
    try {
      for (let i = 0; i < ERRORS_RETENTION + 5; i++) {
        await recordError({ ts: i, source: 'main', type: 't', message: `m${i}` });
      }
      const count = ((await queryRows('SELECT COUNT(*) AS c FROM errors'))[0] as { c: number }).c;
      expect(count).toBe(ERRORS_RETENTION);
      const oldest = (await queryRows('SELECT MIN(ts) AS m FROM errors'))[0] as { m: number };
      expect(oldest.m).toBe(5); // first 5 pruned
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps exactly the newest ERRORS_RETENTION rows across many inserts (PK-seek prune)', async () => {
    const dir = await freshDb();
    try {
      for (let i = 0; i < ERRORS_RETENTION + 25; i++) {
        await recordError({ ts: i, source: 'main', type: 't', message: `m${i}` });
      }
      const r = (await queryRows('SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM errors'))[0];
      expect(r).toEqual({ n: ERRORS_RETENTION, lo: 25, hi: ERRORS_RETENTION + 24 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects (never throws synchronously) when the DB is closed — the sink swallows it', async () => {
    await closeDb();
    const p = recordError({ ts: 1, source: 'main', type: 't', message: 'm' });
    await expect(p).rejects.toThrow(/db not opened/);
  });
});

describe('learnBrokerSessionMapping remap reporting (#195)', () => {
  it('returns null on first learn, the previous claude id thereafter', async () => {
    const dir = await freshDb();
    try {
      expect(await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1')).toBeNull();
      // Idempotent relearn still reports what was there before.
      expect(await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1')).toBe('claude-1');
      // A remap to a DIFFERENT claude session (the #195 cross-wiring event)
      // must surface the overwritten id so callers can log it.
      expect(await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-2')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('verified resume mappings (poisoned legacy rows)', () => {
  it('new learns are verified; lookupVerifiedBrokerSession returns them', async () => {
    const dir = await freshDb();
    try {
      await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      expect(await lookupVerifiedBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('legacy (unverified) rows resolve for observability but never for resume', async () => {
    const dir = await freshDb();
    try {
      // Simulate a pre-#198 FIFO-guessed row: present, but verified=0.
      (await queryRows(`
        INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
        VALUES ('ws-a', 'broker-legacy', 'claude-guessed', 1, 0)
      `));
      expect(await lookupBrokerSession('ws-a', 'broker-legacy')).toBe('claude-guessed'); // observability OK
      expect(await lookupVerifiedBrokerSession('ws-a', 'broker-legacy')).toBeNull();     // resume refused
      // A deterministic relearn upgrades the row to verified.
      await learnBrokerSessionMapping('ws-a', 'broker-legacy', 'claude-real');
      expect(await lookupVerifiedBrokerSession('ws-a', 'broker-legacy')).toBe('claude-real');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('lookupResumableBrokerSession — cross-restart auto-resume gate', () => {
  it('returns the mapping only once the session has ingested a transcript line', async () => {
    const dir = await freshDb();
    try {
      await learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      // Verified but never produced a transcript: `claude --resume` of it
      // would error visibly in the tab, so refuse and let the attach spawn fresh.
      expect(await lookupResumableBrokerSession('ws-a', 'broker-1')).toBeNull();
      await realSession('ws-a', 'claude-1');
      expect(await lookupResumableBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never resumes an unverified (FIFO-guessed) mapping, even with a real session', async () => {
    const dir = await freshDb();
    try {
      (await queryRows(`
        INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
        VALUES ('ws-a', 'broker-legacy', 'claude-guessed', 1, 0)
      `));
      await realSession('ws-a', 'claude-guessed');
      expect(await lookupResumableBrokerSession('ws-a', 'broker-legacy')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null for an unmapped broker session', async () => {
    const dir = await freshDb();
    try {
      expect(await lookupResumableBrokerSession('ws-a', 'broker-unknown')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('recordBrokerSessionMapping — phantom-safe remaps (#170)', () => {
  it('commits directly for a fresh tab with no prior mapping', async () => {
    const dir = await freshDb();
    try {
      const r = await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      expect(r).toEqual({ mode: 'committed', previous: null });
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('commits immediately when the new claude session already has a transcript', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      const r = await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      expect(r.mode).toBe('committed');
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-real');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('DEFERS a remap to a transcript-less session, keeping the committed real mapping', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real', 'first conversation');
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');

      // /clear reports a brand-new session id that has no transcript yet.
      const r = await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-phantom');
      expect(r).toEqual({ mode: 'deferred', previous: 'claude-real' });

      // The tab must NOT be black-holed onto the phantom: reads still resolve
      // the last real conversation, so the title + Open-list entry survive.
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-real');
      expect((await summaryForBrokerSession('ws-a', 'broker-1'))?.title).toBe('first conversation');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('PROMOTES the pending mapping once its session produces a transcript', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real', 'first conversation');
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-next'); // deferred

      // The cleared session finally writes its first line → the tab follows it.
      await realSession('ws-a', 'claude-next', 'second conversation');
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
      expect((await summaryForBrokerSession('ws-a', 'broker-1'))?.title).toBe('second conversation');
      // Promotion keeps the row resume-grade.
      expect(await lookupVerifiedBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('replaces a phantom committed mapping directly (self-heals a previously-stuck tab)', async () => {
    const dir = await freshDb();
    try {
      // Simulate a tab already stuck on a phantom (written by pre-#170 code).
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-dead'); // commits (nothing better)
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-dead');

      // Next session-start event replaces the phantom rather than deferring
      // behind it — a broken mapping must never win.
      const r = await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-fresh');
      expect(r.mode).toBe('committed');
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-fresh');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-populates pending promotions across a reopen (persisted, not just in-memory)', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      await recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-next'); // deferred (pending persisted)
      await st!.reopen(); // in-memory pending set must rehydrate from the row

      await realSession('ws-a', 'claude-next');
      expect(await lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('concurrent remaps of one tab serialize and leave DB + in-memory pending in agreement', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await learnBrokerSessionMapping('ws-a', 'tab-1', 'claude-real');
      const results = await Promise.all([
        recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-n1'),
        recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-n2'),
      ]);
      expect(results.map((r) => r.mode)).toEqual(['deferred', 'deferred']);
      const { pending_claude_session_id: pending } = (await queryRows('SELECT pending_claude_session_id FROM broker_sessions WHERE broker_session_id = ?', ['tab-1']))[0] as { pending_claude_session_id: string };
      expect(['claude-n1', 'claude-n2']).toContain(pending);
      // The in-memory guard must agree with the DB exactly: only the survivor
      // pending, the loser's key evicted when the second transaction replaced it.
      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', pending)]));
      const loser = pending === 'claude-n1' ? 'claude-n2' : 'claude-n1';
      await realSession('ws-a', loser); // the superseded id must NOT promote
      expect(await lookupBrokerSession('ws-a', 'tab-1')).toBe('claude-real');
      await realSession('ws-a', pending); // the surviving pending id must promote
      expect(await lookupBrokerSession('ws-a', 'tab-1')).toBe(pending);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a failed remap does not evict a pending key that predates it', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await learnBrokerSessionMapping('ws-a', 'tab-1', 'claude-real');
      // Legitimately parks claude-x as pending.
      const first = await recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-x');
      expect(first.mode).toBe('deferred');
      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', 'claude-x')]));

      // Force the transaction's COMMIT to fail — a real post-write failure
      // (a dropped connection, a Postgres serialization error under Part 3)
      // AFTER this call's own write already landed. The pre-existing key must
      // survive: it belongs to the FIRST call's already-committed state, not
      // to this failing one.
      const commitSpy = vi
        .spyOn(driverProto, 'commitTransaction')
        .mockImplementationOnce(() => { throw new Error('injected commit failure'); });
      try {
        await expect(recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-x')).rejects.toThrow(
          'injected commit failure',
        );
      } finally {
        commitSpy.mockRestore();
      }

      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', 'claude-x')]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a key added by a failed transaction is left in place, not deleted', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await learnBrokerSessionMapping('ws-a', 'tab-1', 'claude-real');
      expect(__pendingClaudeIdsForTest()).toEqual(new Set());

      // Same injected post-write commit failure as above, but this time the
      // key being parked is new to this call (not pre-existing). The rollback
      // path must only ever re-add keys it removed, never delete a key it
      // added — so this key survives as a harmless superset.
      const commitSpy = vi
        .spyOn(driverProto, 'commitTransaction')
        .mockImplementationOnce(() => { throw new Error('injected commit failure'); });
      try {
        await expect(recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-y')).rejects.toThrow(
          'injected commit failure',
        );
      } finally {
        commitSpy.mockRestore();
      }

      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', 'claude-y')]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('closeDb', () => {
  it('does not clear in-memory caches if something reopened the db while closing', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-real'); // commits
      const r = await recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-pending'); // defers, parks a pending key
      expect(r.mode).toBe('deferred');
      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', 'claude-pending')]));

      const closing = closeDb();
      // Reopen before closeDb's post-await clears run: rehydrate repopulates
      // the pending set from the row, still committed.
      const reopened = st!.open();
      await closing;
      await reopened;

      expect(__pendingClaudeIdsForTest()).toEqual(new Set([pendingKeyForTest('ws-a', 'claude-pending')]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('usage_events (#207)', () => {
  it('recordUsageEvent appends rows with JSON detail', async () => {
    const dir = await freshDb();
    try {
      await recordUsageEvent({ workspaceId: 'ws-a', sessionId: 's1', kind: 'search-impression', detail: { query: 'broker hang' } });
      await recordUsageEvent({ workspaceId: 'ws-a', kind: 'resumed', sessionId: 's1' });
      const rows = (await queryRows('SELECT kind, session_id, detail FROM usage_events ORDER BY id')) as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.kind)).toEqual(['search-impression', 'resumed']);
      expect(JSON.parse(rows[0].detail as string)).toEqual({ query: 'broker hang' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('listSessions — headless flag', () => {
  it('flags sessions mapped from an automation (auto-*) broker id', async () => {
    const dir = await freshDb();
    try {
      await realSession('ws-a', 'claude-tab');
      await realSession('ws-a', 'claude-auto');
      await realSession('ws-a', 'claude-unmapped');
      await recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-tab');
      await recordBrokerSessionMapping('ws-a', 'auto-run1-step1', 'claude-auto');
      const byId = new Map((await listSessions('ws-a')).map((s) => [s.id, s.headless]));
      expect(byId.get('claude-tab')).toBe(false);
      expect(byId.get('claude-auto')).toBe(true);
      expect(byId.get('claude-unmapped')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
