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
  getTerminalRenderer,
  setTerminalRenderer,
  getCapturePty,
  setCapturePty,
  getCaptureEnabled,
  setCaptureEnabled,
  getEffectiveCaptureDir,
  resolveTerminalRenderer,
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
  getUiPrefs,
  setUiPrefs,
  getPerfTelemetry,
  setPerfTelemetry,
  getPerfOtlp,
  setPerfOtlp,
  _resetConfigCacheForTests
} = await import('./config.js');

const configPath = () => join(userDataDir, 'config.json');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-config-'));
  _resetConfigCacheForTests();
  delete process.env.CLAUDE_FLEET_DISABLE_HWA;
  delete process.env.CLAUDE_FLEET_TERMINAL_RENDERER;
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

  it('survives a settings write after a cold read from disk (regression: read() dropped favorites)', async () => {
    await setFavorite('spec-driven', true);
    // Cold read: the next setter rebuilds the cache from disk before writing.
    _resetConfigCacheForTests();
    await setUiPrefs({ showBudgetBar: false });
    _resetConfigCacheForTests();
    const parsed = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(parsed.favorites).toEqual(['spec-driven']);
  });
});

describe('resolveWorkspaceConfig (#219, #298)', () => {
  it('reports the live app version and build sha alongside the summarizer defaults', () => {
    const out = resolveWorkspaceConfig('ws-1', {}, { version: '9.9.9', sha: 'abc1234' });
    expect(out).toEqual({
      workspaceId: 'ws-1',
      app: { version: '9.9.9', sha: 'abc1234' },
      runnerImage: null,
      summarizer: { model: 'haiku', minNewTurns: 20, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 },
      backfill: { enabled: true, maxPerSweep: 10, delayS: 3 },
      backend: { mode: 'oauth', endpoint: null }
    });
  });

  it('reports app.sha as null when no build sha is known (dev outside git)', () => {
    const out = resolveWorkspaceConfig('ws-1', {}, { version: '9.9.9', sha: null });
    expect(out.app).toEqual({ version: '9.9.9', sha: null });
  });

  it("reports the workspace's configured runner image when the manifest has one", () => {
    const out = resolveWorkspaceConfig('ws-1', {}, { version: '1.0.0', sha: null }, 'ghcr.io/imioimi/claude-fleet-runner:main');
    expect(out.runnerImage).toEqual({ name: 'ghcr.io/imioimi/claude-fleet-runner:main' });
  });

  it('applies CF_SUMMARY_* env overrides, falling back on non-numeric values', () => {
    const out = resolveWorkspaceConfig(
      'ws-1',
      { CF_SUMMARY_MODEL: 'sonnet', CF_SUMMARY_MIN_NEW_TURNS: '5', CF_SUMMARY_WINDOW_CHARS: 'garbage', CF_BACKFILL: '0', CF_BACKFILL_MAX_PER_SWEEP: '4', CF_SUMMARY_MAX_CHAPTERS_PER_RUN: 'garbage' },
      { version: '1.0.0', sha: null }
    );
    expect(out.summarizer).toEqual({ model: 'sonnet', minNewTurns: 5, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 });
    expect(out.backfill).toEqual({ enabled: false, maxPerSweep: 4, delayS: 3 });
  });

  it('reports the backend, never a token', () => {
    const cfg = resolveWorkspaceConfig('ws1', {}, { version: '0.9.0', sha: null }, undefined, {
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
    const cfg = resolveWorkspaceConfig('ws1', {}, { version: '0.9.0', sha: null });
    expect(cfg.backend).toEqual({ mode: 'oauth', endpoint: null });
  });

  it('mode: apikey passes through', () => {
    const cfg = resolveWorkspaceConfig('ws1', {}, { version: '0.9.0', sha: null }, undefined, { mode: 'apikey', endpoint: null });
    expect(cfg.backend.mode).toBe('apikey');
  });

  it('CF_SUMMARY_MODEL env override wins over defaults', () => {
    const cfg = resolveWorkspaceConfig('ws1', { CF_SUMMARY_MODEL: 'user-override' }, { version: '0.9.0', sha: null });
    expect(cfg.summarizer.model).toBe('user-override');
  });
});

describe('get/setUiPrefs', () => {
  it('defaults everything to visible/unlimited when unset', async () => {
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: true,
      showSessionCost: true,
      maxSessions: 0,
      maxSessionAgeDays: 0
    });
  });

  it('merges partial writes — setting one key preserves the others', async () => {
    await setUiPrefs({ showBudgetBar: false });
    await setUiPrefs({ maxSessions: 25 });
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: false,
      showSessionCost: true,
      maxSessions: 25,
      maxSessionAgeDays: 0
    });
  });

  it('an explicit false survives a fresh read from disk', async () => {
    await setUiPrefs({ showSessionCost: false, maxSessionAgeDays: 7 });
    _resetConfigCacheForTests();
    const p = await getUiPrefs();
    expect(p.showSessionCost).toBe(false);
    expect(p.maxSessionAgeDays).toBe(7);
  });

  it('rounds fractional filter values and rejects negatives (keeps prior value)', async () => {
    await setUiPrefs({ maxSessions: 25.7 });
    expect((await getUiPrefs()).maxSessions).toBe(26);
    await setUiPrefs({ maxSessions: -5 });
    expect((await getUiPrefs()).maxSessions).toBe(26); // negative rejected, prior kept
  });

  it('preserves a non-preset value verbatim (hand-edited config.json)', async () => {
    await setUiPrefs({ maxSessions: 42 });
    _resetConfigCacheForTests();
    expect((await getUiPrefs()).maxSessions).toBe(42);
  });

  it('ignores a malformed persisted uiPrefs, falling back to defaults', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ uiPrefs: { showBudgetBar: 'nope', maxSessions: 'many' } }),
      'utf8'
    );
    _resetConfigCacheForTests();
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: true,
      showSessionCost: true,
      maxSessions: 0,
      maxSessionAgeDays: 0
    });
  });

  it('does not clobber the other settings', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setUsageBudget('max5', 9_000_000);
    await setUiPrefs({ showBudgetBar: false });
    expect(await getFleetRoot()).toBe(root);
    expect((await getUsageBudget()).preset).toBe('max5');
    expect((await getUiPrefs()).showBudgetBar).toBe(false);
  });
});

describe('perf telemetry config', () => {
  it('getPerfTelemetry defaults true; explicit false persists', async () => {
    expect(await getPerfTelemetry()).toBe(true);
    await setPerfTelemetry(false);
    _resetConfigCacheForTests();
    expect(await getPerfTelemetry()).toBe(false);
  });

  it('getPerfOtlp defaults off/empty; setPerfOtlp round-trips', async () => {
    expect(await getPerfOtlp()).toEqual({ enabled: false, endpoint: '' });
    await setPerfOtlp(true, 'http://localhost:4318');
    _resetConfigCacheForTests();
    expect(await getPerfOtlp()).toEqual({ enabled: true, endpoint: 'http://localhost:4318' });
  });

  it('setPerfOtlp rejects enabling with a non-http endpoint', async () => {
    await expect(setPerfOtlp(true, 'ftp://nope')).rejects.toThrow(/http/i);
    await expect(setPerfOtlp(true, '')).rejects.toThrow(/endpoint/i);
    await expect(setPerfOtlp(false, '')).resolves.toBeUndefined(); // disabling never validates
  });
});

// #268: the terminal renderer choice. `dom` is the safe default — it is the
// only renderer with native per-glyph CSS font fallback — so anything
// unrecognised must resolve to it rather than leaving a pane unable to paint.
describe('get/setTerminalRenderer', () => {
  it('defaults to dom when unset', async () => {
    expect(await getTerminalRenderer()).toBe('dom');
  });

  it('round-trips canvas and webgl through config.json', async () => {
    await setTerminalRenderer('webgl');
    expect(await getTerminalRenderer()).toBe('webgl');
    await setTerminalRenderer('canvas');
    expect(await getTerminalRenderer()).toBe('canvas');
    await setTerminalRenderer('dom');
    expect(await getTerminalRenderer()).toBe('dom');
  });

  it('coerces an unknown persisted value to dom', async () => {
    await writeFile(configPath(), JSON.stringify({ terminalRenderer: 'opengl2' }), 'utf8');
    _resetConfigCacheForTests();
    expect(await getTerminalRenderer()).toBe('dom');
  });

  it('coerces an unknown value on write rather than persisting it', async () => {
    await setTerminalRenderer('nonsense' as unknown as 'dom');
    expect(await getTerminalRenderer()).toBe('dom');
  });

  it('env override wins over the persisted value', async () => {
    await setTerminalRenderer('dom');
    process.env.CLAUDE_FLEET_TERMINAL_RENDERER = 'canvas';
    expect(await getTerminalRenderer()).toBe('canvas');
  });

  it('ignores an unknown env override', async () => {
    await setTerminalRenderer('webgl');
    process.env.CLAUDE_FLEET_TERMINAL_RENDERER = 'vulkan';
    expect(await getTerminalRenderer()).toBe('webgl');
  });
});

// #268: precedence for one pane — env (tests) > workspace override > global.
describe('resolveTerminalRenderer', () => {
  it('falls back to the global setting when the workspace has no override', async () => {
    await setTerminalRenderer('canvas');
    expect(await resolveTerminalRenderer(undefined)).toBe('canvas');
  });

  it('prefers the workspace override over the global setting', async () => {
    await setTerminalRenderer('dom');
    expect(await resolveTerminalRenderer('webgl')).toBe('webgl');
  });

  it('ignores an unrecognised workspace override and uses the global', async () => {
    await setTerminalRenderer('canvas');
    expect(await resolveTerminalRenderer('vulkan' as unknown as 'dom')).toBe('canvas');
  });

  it('env override beats both', async () => {
    await setTerminalRenderer('dom');
    process.env.CLAUDE_FLEET_TERMINAL_RENDERER = 'canvas';
    expect(await resolveTerminalRenderer('webgl')).toBe('canvas');
  });

  it('defaults to dom with nothing set anywhere', async () => {
    expect(await resolveTerminalRenderer(undefined)).toBe('dom');
  });
});

// #268: the renderer must survive a RESTART, not just an in-process round trip.
// The original tests set-then-got in one process, where the in-memory cache
// masked the fact that read() dropped the field on every load from disk.
describe('terminalRenderer survives a reload from disk', () => {
  it('is read back from an existing config.json', async () => {
    await writeFile(configPath(), JSON.stringify({ terminalRenderer: 'canvas' }), 'utf8');
    _resetConfigCacheForTests();
    expect(await getTerminalRenderer()).toBe('canvas');
  });

  it('survives setTerminalRenderer + cache drop (the restart path)', async () => {
    await setTerminalRenderer('webgl');
    _resetConfigCacheForTests();
    expect(await getTerminalRenderer()).toBe('webgl');
  });

  it('is not erased by writing an unrelated setting', async () => {
    // write() spreads the parsed config, so a dropped field is destroyed on
    // the next save of anything else — silent data loss, not just a bad read.
    await setTerminalRenderer('canvas');
    _resetConfigCacheForTests();
    await setHardwareAccelDisabled(true);
    _resetConfigCacheForTests();
    expect(await getTerminalRenderer()).toBe('canvas');
  });

  it('coerces garbage on disk to dom', async () => {
    await writeFile(configPath(), JSON.stringify({ terminalRenderer: 'opengl' }), 'utf8');
    _resetConfigCacheForTests();
    expect(await getTerminalRenderer()).toBe('dom');
  });
});

// #268: the capture directory is a persisted setting, so it must survive a
// reload from disk — the same field-by-field read() that dropped
// terminalRenderer would drop this too.
describe('get/setCapturePty', () => {
  it('is null when unset', async () => {
    expect(await getCapturePty()).toBeNull();
  });

  it('round-trips through disk, not just the cache', async () => {
    await setCapturePty('/var/tmp/ptycap');
    _resetConfigCacheForTests();
    expect(await getCapturePty()).toBe('/var/tmp/ptycap');
  });

  it('an empty value turns capture off', async () => {
    await setCapturePty('/var/tmp/ptycap');
    await setCapturePty('   ');
    _resetConfigCacheForTests();
    expect(await getCapturePty()).toBeNull();
  });

  it('is not erased by writing an unrelated setting', async () => {
    await setCapturePty('/var/tmp/ptycap');
    _resetConfigCacheForTests();
    await setHardwareAccelDisabled(true);
    _resetConfigCacheForTests();
    expect(await getCapturePty()).toBe('/var/tmp/ptycap');
  });
});

// #268: capture is a toggle plus a remembered directory, so switching it off
// doesn't make you re-pick the folder next time.
describe('capture toggle', () => {
  it('keeps the directory when capture is switched off', async () => {
    await setCapturePty('/var/tmp/ptycap');
    await setCaptureEnabled(false);
    _resetConfigCacheForTests();
    expect(await getCapturePty()).toBe('/var/tmp/ptycap'); // remembered
    expect(await getCaptureEnabled()).toBe(false);
    expect(await getEffectiveCaptureDir()).toBeNull(); // but not capturing
  });

  it('captures once switched back on, without re-picking the folder', async () => {
    await setCapturePty('/var/tmp/ptycap');
    await setCaptureEnabled(false);
    await setCaptureEnabled(true);
    _resetConfigCacheForTests();
    expect(await getEffectiveCaptureDir()).toBe('/var/tmp/ptycap');
  });

  it('stays off when enabled with no directory', async () => {
    await setCaptureEnabled(true);
    _resetConfigCacheForTests();
    expect(await getCaptureEnabled()).toBe(true);
    expect(await getEffectiveCaptureDir()).toBeNull();
  });

  it('infers ON for a pre-toggle config that has a directory', async () => {
    // Installs from before the toggle existed were capturing iff a path was
    // set; they must not silently stop after upgrading.
    await writeFile(configPath(), JSON.stringify({ capturePty: '/var/tmp/old' }), 'utf8');
    _resetConfigCacheForTests();
    expect(await getCaptureEnabled()).toBe(true);
    expect(await getEffectiveCaptureDir()).toBe('/var/tmp/old');
  });

  it('infers OFF for a pre-toggle config with no directory', async () => {
    await writeFile(configPath(), JSON.stringify({}), 'utf8');
    _resetConfigCacheForTests();
    expect(await getCaptureEnabled()).toBe(false);
  });

  it('survives a reload and an unrelated write', async () => {
    await setCapturePty('/var/tmp/ptycap');
    await setCaptureEnabled(false);
    _resetConfigCacheForTests();
    await setHardwareAccelDisabled(true);
    _resetConfigCacheForTests();
    expect(await getCapturePty()).toBe('/var/tmp/ptycap');
    expect(await getCaptureEnabled()).toBe(false);
  });
});
