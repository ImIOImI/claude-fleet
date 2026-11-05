import { describe, expect, it } from 'vitest';
import { parseHostConfig, type HostConfig } from './config.js';
import { createReloader } from './configReload.js';
import { createLogger } from './log.js';

describe('reload and db', () => {
  it('refuses a reload that changes db, and keeps the running config', async () => {
    const logs: string[] = [];
    const mk = (db: string): HostConfig => parseHostConfig({ workspace: { name: 'w' }, db: { connectionString: `postgres://u@localhost/${db}` } });
    let next = mk('fleet');
    const r = createReloader({ path: '/x', load: async () => next, apply: async () => undefined, log: createLogger((l) => logs.push(l)) });
    expect(await r.reload('start')).toBe(true);
    next = mk('other');
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(r.current()?.db).toEqual(mk('fleet').db);
    expect(logs.join('\n')).toMatch(/db cannot change on reload/);
  });
});
