import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, recordError, learnBrokerSessionMapping, recordBrokerSessionMapping, lookupBrokerSession, lookupVerifiedBrokerSession, lookupResumableBrokerSession, summaryForBrokerSession, ingestLine, ERRORS_RETENTION, recordUsageEvent } from './db.js';

// A minimal well-formed transcript line that makes `sessionId` a *real*
// session (any ingested line upserts the sessions row). The `user` string
// content also populates first_user_message so summaries resolve a title.
function realSession(workspaceId: string, sessionId: string, prompt = 'hello there'): void {
  ingestLine(
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

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cf-db-'));
  openDb(dir);
  return dir;
}

afterEach(() => closeDb());

describe('recordError', () => {
  it('inserts a row with all fields', () => {
    const dir = freshDb();
    try {
      recordError({ ts: 1000, source: 'main', type: 'pty-attach-failed', message: 'boom',
        level: 'error', workspaceId: 'ws-a', extra: { foo: 1 } });
      const db = openDb(dir);
      const row = db.prepare('SELECT * FROM errors').get() as Record<string, unknown>;
      expect(row.type).toBe('pty-attach-failed');
      expect(row.workspace_id).toBe('ws-a');
      expect(row.level).toBe('error');
      expect(JSON.parse(row.extra as string)).toEqual({ foo: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves session_id from a broker id in extra via the mapping', () => {
    const dir = freshDb();
    try {
      learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-uuid-1');
      recordError({ ts: 1, source: 'main', type: 'x', message: 'm', workspaceId: 'ws-a',
        extra: { brokerSessionId: 'broker-1' } });
      const db = openDb(dir);
      const row = db.prepare('SELECT session_id FROM errors').get() as { session_id: string };
      expect(row.session_id).toBe('claude-uuid-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves session_id NULL when the broker mapping is absent', () => {
    const dir = freshDb();
    try {
      recordError({ ts: 1, source: 'main', type: 'mapping-unresolved', message: 'm',
        level: 'warn', workspaceId: 'ws-a', extra: { brokerSessionId: 'unmapped' } });
      const db = openDb(dir);
      const row = db.prepare('SELECT session_id FROM errors').get() as { session_id: string | null };
      expect(row.session_id).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prunes to the most recent ERRORS_RETENTION rows', () => {
    const dir = freshDb();
    try {
      for (let i = 0; i < ERRORS_RETENTION + 5; i++) {
        recordError({ ts: i, source: 'main', type: 't', message: `m${i}` });
      }
      const db = openDb(dir);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM errors').get() as { c: number }).c;
      expect(count).toBe(ERRORS_RETENTION);
      const oldest = db.prepare('SELECT MIN(ts) AS m FROM errors').get() as { m: number };
      expect(oldest.m).toBe(5); // first 5 pruned
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('learnBrokerSessionMapping remap reporting (#195)', () => {
  it('returns null on first learn, the previous claude id thereafter', () => {
    const dir = freshDb();
    try {
      expect(learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1')).toBeNull();
      // Idempotent relearn still reports what was there before.
      expect(learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1')).toBe('claude-1');
      // A remap to a DIFFERENT claude session (the #195 cross-wiring event)
      // must surface the overwritten id so callers can log it.
      expect(learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-2')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('verified resume mappings (poisoned legacy rows)', () => {
  it('new learns are verified; lookupVerifiedBrokerSession returns them', () => {
    const dir = freshDb();
    try {
      learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      expect(lookupVerifiedBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('legacy (unverified) rows resolve for observability but never for resume', () => {
    const dir = freshDb();
    try {
      // Simulate a pre-#198 FIFO-guessed row: present, but verified=0.
      openDb(dir).prepare(`
        INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
        VALUES ('ws-a', 'broker-legacy', 'claude-guessed', 1, 0)
      `).run();
      expect(lookupBrokerSession('ws-a', 'broker-legacy')).toBe('claude-guessed'); // observability OK
      expect(lookupVerifiedBrokerSession('ws-a', 'broker-legacy')).toBeNull();     // resume refused
      // A deterministic relearn upgrades the row to verified.
      learnBrokerSessionMapping('ws-a', 'broker-legacy', 'claude-real');
      expect(lookupVerifiedBrokerSession('ws-a', 'broker-legacy')).toBe('claude-real');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('lookupResumableBrokerSession — cross-restart auto-resume gate', () => {
  it('returns the mapping only once the session has ingested a transcript line', () => {
    const dir = freshDb();
    try {
      learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      // Verified but never produced a transcript: `claude --resume` of it
      // would error visibly in the tab, so refuse and let the attach spawn fresh.
      expect(lookupResumableBrokerSession('ws-a', 'broker-1')).toBeNull();
      realSession('ws-a', 'claude-1');
      expect(lookupResumableBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never resumes an unverified (FIFO-guessed) mapping, even with a real session', () => {
    const dir = freshDb();
    try {
      openDb(dir).prepare(`
        INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
        VALUES ('ws-a', 'broker-legacy', 'claude-guessed', 1, 0)
      `).run();
      realSession('ws-a', 'claude-guessed');
      expect(lookupResumableBrokerSession('ws-a', 'broker-legacy')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null for an unmapped broker session', () => {
    const dir = freshDb();
    try {
      expect(lookupResumableBrokerSession('ws-a', 'broker-unknown')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('recordBrokerSessionMapping — phantom-safe remaps (#170)', () => {
  it('commits directly for a fresh tab with no prior mapping', () => {
    const dir = freshDb();
    try {
      const r = recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-1');
      expect(r).toEqual({ mode: 'committed', previous: null });
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('commits immediately when the new claude session already has a transcript', () => {
    const dir = freshDb();
    try {
      realSession('ws-a', 'claude-real');
      const r = recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      expect(r.mode).toBe('committed');
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-real');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('DEFERS a remap to a transcript-less session, keeping the committed real mapping', () => {
    const dir = freshDb();
    try {
      realSession('ws-a', 'claude-real', 'first conversation');
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');

      // /clear reports a brand-new session id that has no transcript yet.
      const r = recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-phantom');
      expect(r).toEqual({ mode: 'deferred', previous: 'claude-real' });

      // The tab must NOT be black-holed onto the phantom: reads still resolve
      // the last real conversation, so the title + Open-list entry survive.
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-real');
      expect(summaryForBrokerSession('ws-a', 'broker-1')?.title).toBe('first conversation');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('PROMOTES the pending mapping once its session produces a transcript', () => {
    const dir = freshDb();
    try {
      realSession('ws-a', 'claude-real', 'first conversation');
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-next'); // deferred

      // The cleared session finally writes its first line → the tab follows it.
      realSession('ws-a', 'claude-next', 'second conversation');
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
      expect(summaryForBrokerSession('ws-a', 'broker-1')?.title).toBe('second conversation');
      // Promotion keeps the row resume-grade.
      expect(lookupVerifiedBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('replaces a phantom committed mapping directly (self-heals a previously-stuck tab)', () => {
    const dir = freshDb();
    try {
      // Simulate a tab already stuck on a phantom (written by pre-#170 code).
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-dead'); // commits (nothing better)
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-dead');

      // Next session-start event replaces the phantom rather than deferring
      // behind it — a broken mapping must never win.
      const r = recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-fresh');
      expect(r.mode).toBe('committed');
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-fresh');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-populates pending promotions across a reopen (persisted, not just in-memory)', () => {
    const dir = freshDb();
    try {
      realSession('ws-a', 'claude-real');
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-real');
      recordBrokerSessionMapping('ws-a', 'broker-1', 'claude-next'); // deferred (pending persisted)
      closeDb();
      openDb(dir); // reopen — in-memory pending set must rehydrate from the row

      realSession('ws-a', 'claude-next');
      expect(lookupBrokerSession('ws-a', 'broker-1')).toBe('claude-next');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('usage_events (#207)', () => {
  it('recordUsageEvent appends rows with JSON detail', () => {
    const dir = freshDb();
    try {
      recordUsageEvent({ workspaceId: 'ws-a', sessionId: 's1', kind: 'search-impression', detail: { query: 'broker hang' } });
      recordUsageEvent({ workspaceId: 'ws-a', kind: 'resumed', sessionId: 's1' });
      const db = openDb(dir);
      const rows = db.prepare('SELECT kind, session_id, detail FROM usage_events ORDER BY id').all() as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.kind)).toEqual(['search-impression', 'resumed']);
      expect(JSON.parse(rows[0].detail as string)).toEqual({ query: 'broker hang' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
