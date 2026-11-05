import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostConfig, type HostConfig } from './config.js';
import { createReloader, watchConfigDir } from './configReload.js';
import { createLogger } from './log.js';

const ID_A = '01JC0000000000000000000000';
const ID_B = '01JC0000000000000000000001';

function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fh-reload-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, text);
  return { dir, path };
}

function rig(text: string) {
  const { path } = fixture(text);
  const applied: HostConfig[] = [];
  const logs: string[] = [];
  const r = createReloader({ path, load: loadHostConfig, apply: async (c) => void applied.push(c), log: createLogger((l) => logs.push(l)) });
  return { path, applied, logs, r };
}

describe('createReloader', () => {
  it('applies a valid config and keeps the current one on an invalid file', async () => {
    const { path, applied, logs, r } = rig('workspace: { name: a }\n');
    expect(await r.reload('start')).toBe(true);
    writeFileSync(path, 'workspace: { name: a }\ngrants: [{ team: acme/x, tier: admin }]\n');
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(applied).toHaveLength(1);
    expect(r.current()).toBe(applied[0]);
    expect(logs.some((l) => l.includes('config reload rejected') && l.includes('tier must be one of'))).toBe(true);
  });

  it('serializes overlapping reloads', async () => {
    const { path } = fixture('workspace: { name: a }\n');
    const order: string[] = [];
    let n = 0;
    let name = 'a';
    const r = createReloader({
      path,
      load: async (p) => {
        const c = await loadHostConfig(p);
        return { ...c, workspace: { ...c.workspace, name: (name += 'x') } };
      },
      apply: async () => {
        const me = String(++n);
        order.push(`start${me}`);
        await new Promise((res) => setTimeout(res, 10));
        order.push(`end${me}`);
      },
      log: createLogger(() => undefined)
    });
    await Promise.all([r.reload('a'), r.reload('b')]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('has no baseline until the first valid reload', async () => {
    const { path, applied, r } = rig('workspace: {}\n');
    expect(r.current()).toBeNull();
    expect(await r.reload('start')).toBe(false);
    expect(r.current()).toBeNull();
    writeFileSync(path, `workspace: { id: ${ID_A}, name: a }\n`);
    expect(await r.reload('start')).toBe(true);
    expect(r.current()?.workspace.id).toBe(ID_A);
    expect(applied).toHaveLength(1);
  });

  it('skips apply when the reloaded config is deep-equal to the running one', async () => {
    const { path, applied, logs, r } = rig('workspace: { name: a }\ntrustedProxyHops: 1\n');
    await r.reload('start');
    writeFileSync(path, '# comment only\nworkspace: { name: a }\ntrustedProxyHops: 1\n');
    expect(await r.reload('file change')).toBe(true);
    expect(applied).toHaveLength(1);
    expect(logs.some((l) => l.includes('config unchanged'))).toBe(true);
    writeFileSync(path, 'workspace: { name: a }\ntrustedProxyHops: 2\n');
    expect(await r.reload('file change')).toBe(true);
    expect(applied).toHaveLength(2);
    expect(r.current()?.trustedProxyHops).toBe(2);
  });

  it.each([
    ['null to a value', 'workspace: { name: a }\n', `workspace: { id: ${ID_A}, name: a }\n`],
    ['a value to null', `workspace: { id: ${ID_A}, name: a }\n`, 'workspace: { name: a }\n'],
    ['one value to another', `workspace: { id: ${ID_A}, name: a }\n`, `workspace: { id: ${ID_B}, name: a }\n`]
  ])('refuses a reload that changes workspace.id from %s', async (_label, before, after) => {
    const { path, applied, logs, r } = rig(before);
    expect(await r.reload('start')).toBe(true);
    const baseline = r.current();
    writeFileSync(path, after.replace('name: a', 'name: b'));
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(applied).toHaveLength(1);
    expect(r.current()).toBe(baseline);
    expect(logs.some((l) => l.includes('config reload rejected') && l.includes('workspace.id'))).toBe(true);
    expect(logs.filter((l) => l.includes('config reloaded'))).toHaveLength(1);
  });

  it('refuses a reload that changes the GitHub App, but applies a new allowlist', async () => {
    const app = 'github: { appId: 1, installationId: 2, keyFile: /k, repositories: [a] }\n';
    const { path, applied, logs, r } = rig('workspace: { name: a }\n' + app);
    expect(await r.reload('start')).toBe(true);
    writeFileSync(path, 'workspace: { name: a }\n' + app.replace('/k', '/other'));
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(logs.some((l) => l.includes('config reload rejected') && l.includes('github.appId'))).toBe(true);
    writeFileSync(path, 'workspace: { name: a }\n' + app.replace('[a]', '[a, b]'));
    expect(await r.reload('SIGHUP')).toBe(true);
    expect(applied.at(-1)!.github!.repositories).toEqual(['a', 'b']);
  });

  it('keeps accepting reloads after apply throws, and keeps the old config', async () => {
    const { path } = fixture('workspace: { name: a }\n');
    const logs: string[] = [];
    let fail = false;
    const r = createReloader({
      path,
      load: loadHostConfig,
      apply: async () => {
        if (fail) throw new Error('apply broke');
      },
      log: createLogger((l) => logs.push(l))
    });
    await r.reload('start');
    const baseline = r.current();
    fail = true;
    writeFileSync(path, 'workspace: { name: b }\n');
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(r.current()).toBe(baseline);
    expect(logs.some((l) => l.includes('config apply failed'))).toBe(true);
    fail = false;
    expect(await r.reload('SIGHUP')).toBe(true);
    expect(r.current()?.workspace.name).toBe('b');
  });
});

describe('watchConfigDir', () => {
  it('fires once, debounced, when the file changes', async () => {
    const { path } = fixture('workspace: { name: a }\n');
    const onChange = vi.fn();
    const stop = watchConfigDir(path, onChange, 20);
    writeFileSync(path, 'workspace: { name: b }\n');
    writeFileSync(path, 'workspace: { name: c }\n');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 2000 });
    stop();
  });

  it('ignores unrelated files in the directory', async () => {
    const { dir, path } = fixture('workspace: { name: a }\n');
    const onChange = vi.fn();
    const stop = watchConfigDir(path, onChange, 20);
    writeFileSync(join(dir, 'other.txt'), 'x');
    await new Promise((r) => setTimeout(r, 150));
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('fires on a ConfigMap-style ..data symlink swap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-cm-'));
    mkdirSync(join(dir, 'v1'));
    writeFileSync(join(dir, 'v1', 'config.yaml'), 'workspace: { name: a }\n');
    symlinkSync('v1', join(dir, '..data'));
    symlinkSync('..data/config.yaml', join(dir, 'config.yaml'));
    const onChange = vi.fn();
    const stop = watchConfigDir(join(dir, 'config.yaml'), onChange, 20);
    mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'config.yaml'), 'workspace: { name: b }\n');
    symlinkSync('v2', join(dir, '..data_tmp'));
    renameSync(join(dir, '..data_tmp'), join(dir, '..data'));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 2000 });
    stop();
  });
});
