import { describe, expect, it, vi } from 'vitest';
import { GITHUB_CLIENT_ID_CHANNELS, readGithubClientId, registerGithubClientIdIpc, type GithubClientIdDeps } from './githubClientIdIpc.js';

function harness(o: { env?: string; config?: string | null; builtin?: string } = {}) {
  let config: string | null = o.config ?? null;
  const deps: GithubClientIdDeps = {
    env: () => o.env,
    getConfig: vi.fn(async () => config),
    setConfig: vi.fn(async (v: string | null) => {
      config = v;
    }),
    builtin: o.builtin ?? ''
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerGithubClientIdIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown) }, deps);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { deps, handlers, call, config: () => config };
}

describe('config:*GithubClientId IPC', () => {
  it('registers exactly the two channels', () => {
    expect([...harness().handlers.keys()].sort()).toEqual([...GITHUB_CLIENT_ID_CHANNELS].sort());
    expect(GITHUB_CLIENT_ID_CHANNELS).toEqual(['config:getGithubClientId', 'config:setGithubClientId']);
  });

  it('get reports the value and its source', async () => {
    expect(await harness().call('config:getGithubClientId')).toEqual({ value: null, source: 'none' });
    expect(await harness({ builtin: 'Iv1.bi' }).call('config:getGithubClientId')).toEqual({ value: 'Iv1.bi', source: 'builtin' });
    expect(await harness({ config: 'Iv1.cfg', builtin: 'Iv1.bi' }).call('config:getGithubClientId')).toEqual({ value: 'Iv1.cfg', source: 'config' });
    expect(await harness({ env: 'Iv1.env', config: 'Iv1.cfg' }).call('config:getGithubClientId')).toEqual({ value: 'Iv1.env', source: 'env' });
  });

  it('set trims, saves and returns the new setting', async () => {
    const h = harness();
    expect(await h.call('config:setGithubClientId', '  Ov23liAbc123 ')).toEqual({ value: 'Ov23liAbc123', source: 'config' });
    expect(h.deps.setConfig).toHaveBeenCalledWith('Ov23liAbc123');
  });

  it('clear (null or empty) removes the config value', async () => {
    for (const cleared of [null, '', '   ']) {
      const h = harness({ config: 'Iv1.cfg', builtin: 'Iv1.bi' });
      expect(await h.call('config:setGithubClientId', cleared)).toEqual({ value: 'Iv1.bi', source: 'builtin' });
      expect(h.deps.setConfig).toHaveBeenCalledWith(null);
    }
  });

  it('rejects invalid values without writing', async () => {
    for (const bad of ['has space', 'x'.repeat(101), 'Iv1/abc', 42, {}, ['Iv1.abc'], undefined]) {
      const h = harness({ config: 'Iv1.cfg' });
      await expect(h.call('config:setGithubClientId', bad)).rejects.toThrow(/client ID/);
      expect(h.deps.setConfig).not.toHaveBeenCalled();
      expect(h.config()).toBe('Iv1.cfg');
    }
  });

  it('refuses to set or clear while the env var supplies the id', async () => {
    for (const v of ['Iv1.new', null]) {
      const h = harness({ env: 'Iv1.env', config: 'Iv1.cfg' });
      await expect(h.call('config:setGithubClientId', v)).rejects.toThrow(/CLAUDE_FLEET_GITHUB_CLIENT_ID/);
      expect(h.deps.setConfig).not.toHaveBeenCalled();
    }
  });

  it('an env value that fails validation is ignored, so the field stays editable', async () => {
    const h = harness({ env: 'not valid' });
    expect(await h.call('config:setGithubClientId', 'Iv1.cfg')).toEqual({ value: 'Iv1.cfg', source: 'config' });
  });

  it('readGithubClientId reads config on every call', async () => {
    const h = harness();
    expect((await readGithubClientId(h.deps)).value).toBeNull();
    await h.deps.setConfig('Iv1.later');
    expect((await readGithubClientId(h.deps)).value).toBe('Iv1.later');
  });
});
