import { describe, expect, it } from 'vitest';
import { parseStoreConfig, storeSecretEnvNames } from './storeConfig.js';

const DESKTOP = { allowStaticSecrets: false, allowManaged: true, fileExists: () => false };

describe('the managed store form', () => {
  it('parses { kind: postgres, managed: true } with the poolMax default', () => {
    expect(parseStoreConfig({ kind: 'postgres', managed: true }, DESKTOP)).toEqual({ kind: 'managed', poolMax: 4 });
    expect(parseStoreConfig({ kind: 'postgres', managed: true, poolMax: 8 }, DESKTOP)).toEqual({ kind: 'managed', poolMax: 8 });
  });

  it('refuses connection keys, a non-true managed, and use outside the desktop', () => {
    expect(() => parseStoreConfig({ kind: 'postgres', managed: true, host: 'h' }, DESKTOP)).toThrow(/unknown key "host"/);
    expect(() => parseStoreConfig({ kind: 'postgres', managed: false }, DESKTOP)).toThrow(/managed must be true/);
    expect(() => parseStoreConfig({ kind: 'postgres', managed: true }, { allowStaticSecrets: true })).toThrow(/managed is not allowed here/);
  });

  it('holds no env secret: only the libpq credential vars are stripped from local workspaces', () => {
    expect(storeSecretEnvNames({ kind: 'managed', poolMax: 4 })).toEqual(['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLKEY', 'PGSSLCERT']);
  });
});
