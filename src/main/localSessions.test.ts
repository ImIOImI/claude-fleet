// Unit tests for the local session manager (#16). Uses a fake PtyProc so the
// in-process-broker behavior (spawn-once, ring replay on reattach, detach
// doesn't kill, exit ends the stream) is verified without node-pty.

import { afterEach, describe, expect, it } from 'vitest';
import type { Duplex } from 'node:stream';
import {
  attachLocalSession,
  killWorkspaceSessions,
  hasLiveSessions,
  _resetForTest,
  type PtyProc,
  type SpawnPty
} from './localSessions.js';

class FakePty implements PtyProc {
  readonly pid = 4242;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: Array<string | undefined> = [];
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<() => void> = [];
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: () => void): void {
    this.exitCbs.push(cb);
  }
  // test drivers
  emit(data: string): void {
    for (const cb of this.dataCbs) cb(data);
  }
  fireExit(): void {
    for (const cb of this.exitCbs) cb();
  }
}

/** Spawn factory that records every spawn and the args/cwd/env used. */
function tracker(): { spawn: SpawnPty; procs: FakePty[]; calls: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> } {
  const procs: FakePty[] = [];
  const calls: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnPty = ({ file, args, cwd, env }) => {
    calls.push({ file, args, cwd, env });
    const p = new FakePty();
    procs.push(p);
    return p;
  };
  return { spawn, procs, calls };
}

function collect(stream: Duplex): () => string {
  let buf = '';
  stream.on('data', (c: Buffer | string) => {
    buf += typeof c === 'string' ? c : c.toString('utf8');
  });
  return () => buf;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const base = { cols: 80, rows: 24, cwd: '/home/troy/proj', env: {}, file: 'claude' };

afterEach(() => _resetForTest());

describe('attachLocalSession', () => {
  it('spawns claude once and streams its output to the subscriber', async () => {
    const t = tracker();
    const h = attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    const text = collect(h.stream);

    expect(t.procs).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ file: 'claude', args: [], cwd: '/home/troy/proj' });

    t.procs[0].emit('hello ');
    t.procs[0].emit('world');
    await tick();
    expect(text()).toBe('hello world');
  });

  it('passes --resume <uuid> when resumeOf is set', () => {
    const t = tracker();
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', resumeOf: 'uuid-9', spawn: t.spawn });
    expect(t.calls[0].args).toEqual(['--resume', 'uuid-9']);
  });

  it('prepends extraArgs before all other flags', () => {
    const t = tracker();
    attachLocalSession({
      ...base,
      workspaceId: 'ws1',
      sessionId: 's1',
      extraArgs: ['/path/to/stub.js'],
      mcpConfigPath: '/state/ws1/mcp-config.json',
      resumeOf: 'uuid-9',
      spawn: t.spawn
    });
    expect(t.calls[0].args).toEqual([
      '/path/to/stub.js',
      '--mcp-config',
      '/state/ws1/mcp-config.json',
      '--resume',
      'uuid-9'
    ]);
  });

  it('prepends --mcp-config before --resume when both are set', () => {
    const t = tracker();
    attachLocalSession({
      ...base,
      workspaceId: 'ws1',
      sessionId: 's1',
      mcpConfigPath: '/state/ws1/mcp-config.json',
      resumeOf: 'uuid-9',
      spawn: t.spawn
    });
    expect(t.calls[0].args).toEqual([
      '--mcp-config',
      '/state/ws1/mcp-config.json',
      '--resume',
      'uuid-9'
    ]);
  });

  it('forwards stream writes to the pty and resize to the proc', async () => {
    const t = tracker();
    const h = attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    h.stream.write('ls\n');
    await h.resize(120, 40);
    await tick();
    expect(t.procs[0].writes).toContain('ls\n');
    expect(t.procs[0].resizes).toEqual([[120, 40]]);
  });

  it('reattach after detach reuses the same proc and replays the ring (no kill)', async () => {
    const t = tracker();
    const h1 = attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    t.procs[0].emit('line-before-detach\n');
    await tick();

    h1.detach();
    // detach must NOT kill the process.
    expect(t.procs[0].kills).toHaveLength(0);
    expect(hasLiveSessions('ws1')).toBe(true);

    // Reattach: same proc (spawn still 1), and the ring is replayed.
    const h2 = attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    const text2 = collect(h2.stream);
    await tick();
    expect(t.procs).toHaveLength(1);
    expect(text2()).toContain('line-before-detach');

    // ...and live output continues to the new subscriber.
    t.procs[0].emit('after-reattach');
    await tick();
    expect(text2()).toContain('after-reattach');
  });

  it('ends the stream when the pty exits and respawns on the next attach', async () => {
    const t = tracker();
    const h = attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    let ended = false;
    h.stream.on('end', () => {
      ended = true;
    });
    h.stream.resume(); // flowing, so 'end' fires after the null push

    t.procs[0].fireExit();
    await tick();
    expect(ended).toBe(true);
    expect(hasLiveSessions('ws1')).toBe(false);

    // Next attach to the same key spawns a fresh process.
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    expect(t.procs).toHaveLength(2);
  });
});

describe('workspace-level controls', () => {
  it('killWorkspaceSessions kills every session for the workspace only', () => {
    const t = tracker();
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's2', spawn: t.spawn });
    attachLocalSession({ ...base, workspaceId: 'ws2', sessionId: 's1', spawn: t.spawn });

    killWorkspaceSessions('ws1');
    expect(t.procs[0].kills).toHaveLength(1); // ws1:s1
    expect(t.procs[1].kills).toHaveLength(1); // ws1:s2
    expect(t.procs[2].kills).toHaveLength(0); // ws2:s1 untouched
    expect(hasLiveSessions('ws1')).toBe(false);
    expect(hasLiveSessions('ws2')).toBe(true);
  });
});

describe('host-assigned claude session ids (#195)', () => {
  it('passes --session-id on a fresh spawn and reports it via onFreshSpawn', () => {
    const t = tracker();
    const learned: string[] = [];
    attachLocalSession({
      ...base,
      workspaceId: 'ws1',
      sessionId: 's1',
      claudeSessionId: 'uuid-fresh',
      onFreshSpawn: (id) => learned.push(id),
      spawn: t.spawn
    });
    expect(t.calls[0].args).toEqual(['--session-id', 'uuid-fresh']);
    expect(learned).toEqual(['uuid-fresh']);
  });

  it('resume wins: spawns with --resume, reports the resumed id', () => {
    const t = tracker();
    const learned: string[] = [];
    attachLocalSession({
      ...base,
      workspaceId: 'ws1',
      sessionId: 's1',
      resumeOf: 'uuid-old',
      claudeSessionId: 'uuid-fresh',
      onFreshSpawn: (id) => learned.push(id),
      spawn: t.spawn
    });
    expect(t.calls[0].args).toEqual(['--resume', 'uuid-old']);
    expect(learned).toEqual(['uuid-old']);
  });

  it('does NOT fire onFreshSpawn when re-attaching a live session (no spawn, id unknown)', () => {
    const t = tracker();
    const learned: string[] = [];
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    // Same key, claude still running: attach must not respawn nor relearn.
    attachLocalSession({
      ...base,
      workspaceId: 'ws1',
      sessionId: 's1',
      claudeSessionId: 'uuid-second',
      onFreshSpawn: (id) => learned.push(id),
      spawn: t.spawn
    });
    expect(t.procs).toHaveLength(1);
    expect(learned).toEqual([]);
  });

  it('exports CLAUDE_FLEET_BROKER_SESSION_ID to the spawned claude (#207)', () => {
    const t = tracker();
    attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
    expect(t.calls[0].env.CLAUDE_FLEET_BROKER_SESSION_ID).toBe('s1');
  });
});
