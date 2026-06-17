// Unit tests for the hardware-acceleration setting (#13). The `electron`
// module is mocked so `app.getPath()` resolves to a per-test temp dir; the
// rest is plain config.json fs work driven directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      if (which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

const {
  hardwareAccelDisabledAtStartup,
  getHardwareAccelDisabled,
  setHardwareAccelDisabled,
  setFleetRoot,
  getFleetRoot,
  _resetConfigCacheForTests
} = await import('./config.js');

const configPath = () => join(userDataDir, 'config.json');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-config-'));
  _resetConfigCacheForTests();
  delete process.env.CLAUDE_FLEET_DISABLE_HWA;
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('hardwareAccelDisabledAtStartup', () => {
  it('is false when no config file exists', () => {
    expect(hardwareAccelDisabledAtStartup()).toBe(false);
  });

  it('reflects the persisted setting (sync read of config.json)', async () => {
    await writeFile(configPath(), JSON.stringify({ disableHardwareAcceleration: true }), 'utf8');
    expect(hardwareAccelDisabledAtStartup()).toBe(true);
  });

  it('env override forces it on even when persisted false', async () => {
    await writeFile(configPath(), JSON.stringify({ disableHardwareAcceleration: false }), 'utf8');
    process.env.CLAUDE_FLEET_DISABLE_HWA = '1';
    expect(hardwareAccelDisabledAtStartup()).toBe(true);
  });
});

describe('get/setHardwareAccelDisabled', () => {
  it('round-trips through config.json and is visible to the sync startup read', async () => {
    expect(await getHardwareAccelDisabled()).toBe(false);
    await setHardwareAccelDisabled(true);
    expect(await getHardwareAccelDisabled()).toBe(true);
    // The sync startup path reads disk directly, bypassing the cache.
    _resetConfigCacheForTests();
    expect(hardwareAccelDisabledAtStartup()).toBe(true);
  });

  it('does not clobber the fleet root, and vice versa', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setHardwareAccelDisabled(true);
    expect(await getFleetRoot()).toBe(root);
    expect(await getHardwareAccelDisabled()).toBe(true);

    // The on-disk file carries both keys.
    const parsed = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(parsed.fleetRoot).toBe(root);
    expect(parsed.disableHardwareAcceleration).toBe(true);
  });
});
