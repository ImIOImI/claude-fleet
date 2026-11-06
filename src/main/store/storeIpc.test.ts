import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  store: { kind: 'managed', poolMax: 4 } as { kind: string; poolMax?: number },
  writes: [] as string[],
  relaunched: 0,
}));
vi.mock('electron', () => ({
  app: { relaunch: () => { h.relaunched++; }, quit: () => undefined },
  ipcMain: { handle: (c: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(c, fn); } },
}));
vi.mock('../config.js', () => ({
  getStoreConfig: async () => h.store,
  setStoreChoice: async (c: string) => {
    h.writes.push(c);
    h.store = c === 'managed' ? { kind: 'managed', poolMax: 4 } : { kind: 'sqlite' };
  },
}));

const { registerStoreIpc, setActiveStore } = await import('./storeIpc.js');
registerStoreIpc();
const call = (c: string, ...a: unknown[]) => h.handlers.get(c)!({}, ...a) as Promise<Record<string, unknown>>;
const down = { choice: 'managed', phase: 'down', detail: 'Docker is not running', progress: null, notice: null } as const;

describe('store IPC', () => {
  beforeEach(() => {
    h.store = { kind: 'managed', poolMax: 4 };
    h.writes.length = 0;
  });

  it('getSettings reports the configured and running store and the live status', async () => {
    setActiveStore('managed', () => down);
    expect(await call('store:getSettings')).toEqual({ configured: 'managed', active: 'managed', restartRequired: false, status: down, notice: null });
  });

  it('setChoice refuses anything but sqlite or managed', () => {
    expect(() => call('store:setChoice', 'external')).toThrow(/sqlite" or "managed/);
  });

  it('leaving a running managed store goes through the switch back, once, and shows its notice', async () => {
    let switches = 0;
    let finish!: () => void;
    setActiveStore('managed', () => down, async () => {
      switches++;
      await new Promise<void>((r) => { finish = r; });
      h.store = { kind: 'sqlite' };
      return { switched: true, notice: 'inbox.db has an unfinished transaction' };
    });
    const first = call('store:setChoice', 'sqlite');
    const second = call('store:setChoice', 'sqlite');
    await new Promise((r) => setTimeout(r, 10));
    finish();
    expect(await first).toMatchObject({ configured: 'sqlite', active: 'managed', restartRequired: true, notice: 'inbox.db has an unfinished transaction' });
    expect(await second).toMatchObject({ configured: 'sqlite', notice: null });
    expect(switches).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it('a refused switch back leaves config.json alone and says why', async () => {
    setActiveStore('managed', () => down, async () => ({ switched: false, notice: 'Not switched; the app stays on Postgres: x' }));
    expect(await call('store:setChoice', 'sqlite')).toMatchObject({ configured: 'managed', restartRequired: false, notice: 'Not switched; the app stays on Postgres: x' });
    expect(h.writes).toEqual([]);
  });

  it('choosing managed on SQLite writes config.json and asks for a restart', async () => {
    h.store = { kind: 'sqlite' };
    setActiveStore('sqlite');
    expect(await call('store:setChoice', 'managed')).toMatchObject({ configured: 'managed', active: 'sqlite', restartRequired: true });
    expect(h.writes).toEqual(['managed']);
  });

  it('app:relaunch relaunches', async () => {
    await call('app:relaunch');
    expect(h.relaunched).toBe(1);
  });
});
