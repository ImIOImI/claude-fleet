import { describe, expect, it } from 'vitest';
import type { SwitchBackOutcome, SwitchBackPlan } from './firstSwitch.js';
import { applyStoreChoice, switchBackLive, type SwitchBackDeps } from './storeSwitch.js';

type S = { pool: string };

function harness(o: {
  live?: S | null;
  inboxOn?: 'postgres' | 'sqlite' | null;
  plan?: SwitchBackPlan;
  marker?: boolean;
  open?: () => Promise<S>;
  copy?: (commit: () => Promise<void>) => Promise<SwitchBackOutcome>;
} = {}) {
  const calls: string[] = [];
  const deps: SwitchBackDeps<S> = {
    inboxOn: () => o.inboxOn ?? 'postgres',
    exclusive: async (fn) => { calls.push('exclusive'); return fn(o.live === undefined ? { pool: 'live' } : o.live); },
    plan: () => { calls.push('plan'); return o.plan ?? { kind: 'copy' }; },
    postgresInboxLive: () => o.marker ?? true,
    open: o.open ?? (async () => { calls.push('open'); return { pool: 'opened' }; }),
    close: async (s) => { calls.push(`close ${s.pool}`); },
    quiesce: async (s) => { calls.push(`quiesce ${s.pool}`); },
    copy: async (s, commit) => {
      calls.push(`copy ${s.pool}`);
      if (o.copy) return o.copy(commit);
      await commit();
      return { status: 'switched', counts: { todos: 1 } };
    },
    commit: async () => { calls.push('commit'); },
    resume: async (on) => { calls.push(`resume ${on}`); },
    stopBringUp: () => { calls.push('stopBringUp'); },
  };
  return { deps, calls };
}

describe('switchBackLive', () => {
  it('quiesces the writers, copies, and resumes them on SQLite only after the commit', async () => {
    const { deps, calls } = harness();
    expect(await switchBackLive(deps)).toEqual({ switched: true, notice: null });
    expect(calls).toEqual(['exclusive', 'quiesce live', 'copy live', 'commit', 'resume sqlite']);
  });

  it('a failed copy resumes the writers on Postgres and says why', async () => {
    const { deps, calls } = harness({ copy: async () => { throw new Error('the Postgres inbox kept changing during the copy'); } });
    expect(await switchBackLive(deps)).toEqual({
      switched: false, notice: 'Not switched; the app stays on Postgres: the Postgres inbox kept changing during the copy',
    });
    expect(calls).toEqual(['exclusive', 'quiesce live', 'copy live', 'resume postgres']);
  });

  it('a commit that throws inside the copy resumes on Postgres', async () => {
    const { deps, calls } = harness({ copy: async (commit) => { await commit(); throw new Error('config.json could not be written'); } });
    expect((await switchBackLive(deps)).switched).toBe(false);
    expect(calls.at(-1)).toBe('resume postgres');
    expect(calls).not.toContain('resume sqlite');
  });

  it('skipped-nonempty resumes on Postgres and passes its notice on', async () => {
    const { deps, calls } = harness({ copy: async () => ({ status: 'skipped-nonempty', notice: 'inbox.db holds a separate inbox' }) });
    expect(await switchBackLive(deps)).toEqual({ switched: false, notice: 'inbox.db holds a separate inbox' });
    expect(calls).toEqual(['exclusive', 'quiesce live', 'copy live', 'resume postgres']);
  });

  it('kept inbox.db (the copy to Postgres never finished) passes the hot-journal notice on', async () => {
    const { deps } = harness({ copy: async (commit) => { await commit(); return { status: 'switched', counts: {}, kept: true, notice: 'rolls it back' }; } });
    expect(await switchBackLive(deps)).toEqual({ switched: true, notice: 'rolls it back' });
  });

  describe('while the store is not ready', () => {
    it('keep-inbox-db commits without a pool and ends the bring-up', async () => {
      const { deps, calls } = harness({ live: null, plan: { kind: 'keep-inbox-db', notice: null } });
      expect(await switchBackLive(deps)).toEqual({ switched: true, notice: null });
      expect(calls).toEqual(['exclusive', 'plan', 'commit', 'stopBringUp']);
    });

    it('refuse is the notice, with nothing written', async () => {
      const { deps, calls } = harness({ live: null, plan: { kind: 'refuse', notice: 'move inbox.db aside' } });
      expect(await switchBackLive(deps)).toEqual({ switched: false, notice: 'move inbox.db aside' });
      expect(calls).toEqual(['exclusive', 'plan']);
    });

    it('with no inbox ever on Postgres, commits without a pool', async () => {
      const { deps, calls } = harness({ live: null, marker: false });
      expect((await switchBackLive(deps)).switched).toBe(true);
      expect(calls).toEqual(['exclusive', 'plan', 'commit', 'stopBringUp']);
    });

    it('with the inbox on Postgres, opens the store for the copy and closes it after', async () => {
      const { deps, calls } = harness({ live: null });
      expect((await switchBackLive(deps)).switched).toBe(true);
      expect(calls).toEqual(['exclusive', 'plan', 'open', 'copy opened', 'commit', 'stopBringUp', 'close opened']);
    });

    it('an unreachable store with the inbox on it is not switched', async () => {
      const { deps, calls } = harness({ live: null, open: async () => { throw new Error('Docker is not running'); } });
      expect(await switchBackLive(deps)).toEqual({
        switched: false, notice: "Not switched; the app stays on Postgres: the inbox lives in Postgres, which can't be reached (Docker is not running).",
      });
      expect(calls).not.toContain('commit');
    });
  });

  it('a second switch after the inbox already moved only writes the choice', async () => {
    const { deps, calls } = harness({ inboxOn: 'sqlite' });
    expect(await switchBackLive(deps)).toEqual({ switched: true, notice: null });
    expect(calls).toEqual(['commit']);
  });
});

describe('applyStoreChoice', () => {
  const run = (choice: 'sqlite' | 'managed', configured: 'sqlite' | 'managed' | 'external', active: 'sqlite' | 'managed' | 'external', withSwitch = true) => {
    const calls: string[] = [];
    const p = applyStoreChoice(choice, {
      configured, active,
      write: async (c) => { calls.push(`write ${c}`); },
      switchBack: withSwitch ? async () => { calls.push('switchBack'); return { switched: false, notice: 'refused' }; } : null,
    });
    return { p, calls };
  };

  it('the current choice is a no-op', async () => {
    const { p, calls } = run('managed', 'managed', 'managed');
    expect(await p).toBeNull();
    expect(calls).toEqual([]);
  });

  it('SQLite → managed only writes config.json (the copy runs at the next start)', async () => {
    const { p, calls } = run('managed', 'sqlite', 'sqlite');
    await p;
    expect(calls).toEqual(['write managed']);
  });

  it('leaving a running managed store goes through the switch back and returns its notice', async () => {
    const { p, calls } = run('sqlite', 'managed', 'managed');
    expect(await p).toBe('refused');
    expect(calls).toEqual(['switchBack']);
  });

  it('undoing a not-yet-applied managed choice on SQLite only writes config.json', async () => {
    const { p, calls } = run('sqlite', 'managed', 'sqlite');
    await p;
    expect(calls).toEqual(['write sqlite']);
  });

  it('without a switch back (external store) the write decides', async () => {
    const { p, calls } = run('sqlite', 'external', 'external', false);
    await p;
    expect(calls).toEqual(['write sqlite']);
  });
});
