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
  getAutoReloadLoadouts,
  setAutoReloadLoadouts,
  getUsageBudget,
  setUsageBudget,
  USAGE_BUDGET_PRESETS,
  USAGE_BUDGET_WINDOW_HOURS,
  setFleetRoot,
  getFleetRoot,
  setFavorite,
  resolveWorkspaceConfig,
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

describe('get/setAutoReloadLoadouts', () => {
  it('defaults to on when unset', async () => {
    expect(await getAutoReloadLoadouts()).toBe(true);
  });

  it('round-trips, and an explicit false survives a fresh read from disk', async () => {
    await setAutoReloadLoadouts(false);
    expect(await getAutoReloadLoadouts()).toBe(false);
    // Drop the cache so the next read re-parses config.json — the explicit
    // false must persist (regression: read() used to omit the key, flipping
    // the setting back on after a restart).
    _resetConfigCacheForTests();
    expect(await getAutoReloadLoadouts()).toBe(false);
  });

  it('does not clobber the other settings', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setHardwareAccelDisabled(true);
    await setAutoReloadLoadouts(false);
    expect(await getFleetRoot()).toBe(root);
    expect(await getHardwareAccelDisabled()).toBe(true);
    expect(await getAutoReloadLoadouts()).toBe(false);
  });
});

describe('get/setUsageBudget', () => {
  it('defaults to the Pro preset, resolving to the Pro allowance', async () => {
    const b = await getUsageBudget();
    expect(b.preset).toBe('pro');
    expect(b.allowanceTokens).toBe(USAGE_BUDGET_PRESETS.pro);
    expect(b.windowHours).toBe(USAGE_BUDGET_WINDOW_HOURS);
    expect(b.presets).toEqual(USAGE_BUDGET_PRESETS);
  });

  it('resolves each plan preset to its preset token amount, ignoring customTokens', async () => {
    await setUsageBudget('max20', 123);
    const b = await getUsageBudget();
    expect(b.preset).toBe('max20');
    expect(b.allowanceTokens).toBe(USAGE_BUDGET_PRESETS.max20);
    expect(b.customTokens).toBe(123); // stored, but not the allowance for a plan preset
  });

  it('uses customTokens as the allowance for the custom preset', async () => {
    await setUsageBudget('custom', 7_500_000);
    const b = await getUsageBudget();
    expect(b.preset).toBe('custom');
    expect(b.allowanceTokens).toBe(7_500_000);
  });

  it('rounds and clamps a negative/fractional custom amount to a sane value', async () => {
    await setUsageBudget('custom', -42.7);
    // Negative is rejected → falls back to the default Pro amount, not stored as-is.
    expect((await getUsageBudget()).allowanceTokens).toBe(USAGE_BUDGET_PRESETS.pro);
    await setUsageBudget('custom', 1_234_567.8);
    expect((await getUsageBudget()).allowanceTokens).toBe(1_234_568);
  });

  it('round-trips through config.json and survives a fresh read from disk', async () => {
    await setUsageBudget('max5', 0);
    _resetConfigCacheForTests();
    const b = await getUsageBudget();
    expect(b.preset).toBe('max5');
    expect(b.allowanceTokens).toBe(USAGE_BUDGET_PRESETS.max5);
  });

  it('ignores a malformed persisted usageBudget, falling back to the Pro default', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ usageBudget: { preset: 'bogus', customTokens: 'nope' } }),
      'utf8'
    );
    _resetConfigCacheForTests();
    const b = await getUsageBudget();
    expect(b.preset).toBe('pro');
    expect(b.allowanceTokens).toBe(USAGE_BUDGET_PRESETS.pro);
  });

  it('does not clobber the other settings', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setAutoReloadLoadouts(false);
    await setUsageBudget('max5', 9_000_000);
    expect(await getFleetRoot()).toBe(root);
    expect(await getAutoReloadLoadouts()).toBe(false);
    expect((await getUsageBudget()).preset).toBe('max5');
  });
});

describe('setFavorite', () => {
  it('adds a favorite and returns the new list', async () => {
    expect(await setFavorite('spec-driven', true)).toEqual(['spec-driven']);
  });

  it('persists the favorite so a fresh cache read sees it', async () => {
    await setFavorite('spec-driven', true);
    _resetConfigCacheForTests();
    // After cache reset the on-disk value is authoritative — toggling off
    // should start from ['spec-driven'] and return [].
    expect(await setFavorite('spec-driven', false)).toEqual([]);
  });

  it('removes a favorite and returns the new list', async () => {
    await setFavorite('spec-driven', true);
    expect(await setFavorite('spec-driven', false)).toEqual([]);
  });

  it('does not clobber other settings', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setFavorite('spec-driven', true);
    expect(await getFleetRoot()).toBe(root);
  });
});

describe('resolveWorkspaceConfig (#219)', () => {
  it('reports the live app version alongside the summarizer defaults', () => {
    const out = resolveWorkspaceConfig('ws-1', {}, '9.9.9');
    expect(out).toEqual({
      workspaceId: 'ws-1',
      app: { version: '9.9.9' },
      runnerImage: null,
      summarizer: { model: 'haiku', minNewTurns: 20, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 },
      backfill: { enabled: true, maxPerSweep: 10, delayS: 3 },
      backend: { mode: 'oauth', endpoint: null }
    });
  });

  it("reports the workspace's configured runner image when the manifest has one", () => {
    const out = resolveWorkspaceConfig('ws-1', {}, '1.0.0', 'ghcr.io/imioimi/claude-fleet-runner:main');
    expect(out.runnerImage).toEqual({ name: 'ghcr.io/imioimi/claude-fleet-runner:main' });
  });

  it('applies CF_SUMMARY_* env overrides, falling back on non-numeric values', () => {
    const out = resolveWorkspaceConfig(
      'ws-1',
      { CF_SUMMARY_MODEL: 'sonnet', CF_SUMMARY_MIN_NEW_TURNS: '5', CF_SUMMARY_WINDOW_CHARS: 'garbage', CF_BACKFILL: '0', CF_BACKFILL_MAX_PER_SWEEP: '4', CF_SUMMARY_MAX_CHAPTERS_PER_RUN: 'garbage' },
      '1.0.0'
    );
    expect(out.summarizer).toEqual({ model: 'sonnet', minNewTurns: 5, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 });
    expect(out.backfill).toEqual({ enabled: false, maxPerSweep: 4, delayS: 3 });
  });

  it('reports the backend, never a token', () => {
    const cfg = resolveWorkspaceConfig('ws1', {}, '0.9.0', undefined, {
      mode: 'endpoint',
      endpoint: { name: 'org-vllm', baseUrl: 'http://10.0.0.5:8000', modelId: 'qwen3-32b' }
    });
    expect(cfg.backend).toEqual({
      mode: 'endpoint',
      endpoint: { name: 'org-vllm', baseUrl: 'http://10.0.0.5:8000', modelId: 'qwen3-32b' }
    });
    expect(JSON.stringify(cfg)).not.toContain('AUTH_TOKEN');
  });

  it('defaults backend to oauth with no endpoint', () => {
    const cfg = resolveWorkspaceConfig('ws1', {}, '0.9.0');
    expect(cfg.backend).toEqual({ mode: 'oauth', endpoint: null });
  });
});
