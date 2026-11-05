import { describe, expect, it } from 'vitest';
import { ConfigJsonError, StoreConfigError } from './storeConfig.js';
import { storeStartupOutcome, storeStartupPrompt } from './startupPrompt.js';

const PATH = '/home/u/.config/claude-fleet/config.json';

describe('storeStartupPrompt', () => {
  it('a malformed config.json offers Quit (default) or Continue without settings, and says Postgres falls back to SQLite', () => {
    const p = storeStartupPrompt(new ConfigJsonError('config.json is not valid JSON'), PATH);
    expect(p.buttons).toEqual(['Quit', 'Continue without settings']);
    expect(p.defaultId).toBe(0);
    expect(p.cancelId).toBe(0);
    expect(p.detail).toContain(PATH);
    expect(p.detail).toMatch(/configured Postgres.*local SQLite store instead/s);
    expect(p.detail).toMatch(/can't be saved/);
    expect(storeStartupOutcome(p, 0)).toBe('quit');
    expect(storeStartupOutcome(p, 1)).toBe('continue-without-settings');
  });

  it('any other store failure only offers Quit, naming the store key', () => {
    for (const e of [new StoreConfigError('store: kind must be "sqlite" or "postgres"'), new Error('connect ECONNREFUSED 10.0.0.5:5432')]) {
      const p = storeStartupPrompt(e, PATH);
      expect(p.buttons).toEqual(['Quit']);
      expect(p.detail).toContain(String(e));
      expect(p.detail).toMatch(/remove its "store" key/);
      expect(storeStartupOutcome(p, 0)).toBe('quit');
      expect(storeStartupOutcome(p, 1)).toBe('quit');
    }
  });

  it('an unexpected response quits', () => {
    const p = storeStartupPrompt(new ConfigJsonError('config.json is not valid JSON'), PATH);
    expect(storeStartupOutcome(p, -1)).toBe('quit');
    expect(storeStartupOutcome(p, 7)).toBe('quit');
  });
});
