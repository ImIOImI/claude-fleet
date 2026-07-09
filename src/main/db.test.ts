import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, recordError, learnBrokerSessionMapping, ERRORS_RETENTION } from './db.js';

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
