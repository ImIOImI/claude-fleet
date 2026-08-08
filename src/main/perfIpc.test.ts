import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import { initPerf, shutdownPerf } from './perf.js';
import { channelAttrs, instrumentIpcHandle } from './perfIpc.js';

describe('instrumentIpcHandle', () => {
  it('wraps handlers, preserves args/return, and keeps channel registration', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = new Map<string, (...a: any[]) => unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { handle: (ch: string, fn: (...a: any[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:y', (_e: unknown, a: number, b: number) => a + b);
    expect(registered.has('x:y')).toBe(true);
    await expect(registered.get('x:y')!({}, 2, 3)).resolves.toBe(5);
  });

  it('propagates rejections', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = new Map<string, (...a: any[]) => unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { handle: (ch: string, fn: (...a: any[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:err', () => { throw new Error('nope'); });
    await expect(registered.get('x:err')!({})).rejects.toThrow('nope');
  });
});

describe('channelAttrs', () => {
  it('maps workspace/session args for mapped channels', () => {
    expect(channelAttrs('sessions:write', ['ws-1', { sessions: [] }]))
      .toEqual({ workspace_id: 'ws-1' });
    expect(channelAttrs('observability:summaryForBrokerSession', ['ws-1', 'bs-2']))
      .toEqual({ workspace_id: 'ws-1', session_id: 'bs-2' });
    expect(channelAttrs('committee:post', ['ws-caller', 'ws-target', 'hello']))
      .toEqual({ workspace_id: 'ws-caller' });
  });

  it('deliberately excludes session-only channels (globally visible rows would leak cross-workspace)', () => {
    // id-bearing but unmapped: session-only rows would be globally visible in the MCP snapshot
    expect(channelAttrs('observability:eventsForSession', ['sess-uuid', 0, 500])).toBeUndefined();
  });

  it('returns undefined for unmapped channels and non-string args', () => {
    expect(channelAttrs('workspace:list', [])).toBeUndefined();
    expect(channelAttrs('sessions:write', [undefined, {}])).toBeUndefined();
    expect(channelAttrs('sessions:list', [undefined])).toBeUndefined(); // optional arg omitted
  });
});

describe('instrumentIpcHandle + channelAttrs integration', () => {
  it('a mapped channel invoke produces an attributed slow_op row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perfipc-'));
    const db = openDb(dir);
    const store = new PerfStore(db);
    initPerf(store, {
      recording: true, recordingSource: 'settings',
      otlp: { enabled: false, endpoint: null, source: 'settings' }
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registered = new Map<string, (...a: any[]) => unknown>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fake = { handle: (ch: string, fn: (...a: any[]) => unknown) => { registered.set(ch, fn); } };
      instrumentIpcHandle(fake);
      fake.handle('sessions:write', (_e: unknown, _ws: string) => { const end = Date.now() + 30; while (Date.now() < end) { /* busy */ } });
      await registered.get('sessions:write')!({}, 'ws-int', { sessions: [] });
    } finally {
      await shutdownPerf();
    }
    const row = db.prepare(
      `SELECT workspace_id FROM perf_events WHERE kind = 'slow_op' AND name = 'claude_fleet.ipc.sessions:write'`
    ).get() as { workspace_id: string };
    expect(row).toEqual({ workspace_id: 'ws-int' });
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
});
