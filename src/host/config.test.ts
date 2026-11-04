import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConfigError, loadHostConfig, parseHostConfig, readHostEnv } from './config.js';

const base = {
  workspace: { name: 'review-bot', description: 'PR reviewer', color: { hue: 210 } },
  identity: { provider: 'github', org: 'acme' },
  grants: [{ team: 'acme/platform', tier: 'session' }],
  machines: [{ appId: 123456, login: 'acme-reviewer[bot]', tier: 'steer' }]
};

describe('parseHostConfig', () => {
  it('parses workspace, identity and grants', () => {
    const c = parseHostConfig(base);
    expect(c.workspace).toEqual({ id: null, name: 'review-bot', description: 'PR reviewer', color: { hue: 210 } });
    expect(c.identity).toEqual({ provider: 'github', org: 'acme' });
    expect(c.grants.grants).toEqual([{ team: 'acme/platform', tier: 'session' }]);
    expect(c.grants.machines[0]).toMatchObject({ appId: 123456, org: 'acme', tier: 'steer' });
  });

  it('defaults description and color to null', () => {
    const c = parseHostConfig({ workspace: { name: 'w' } });
    expect(c.workspace).toEqual({ id: null, name: 'w', description: null, color: null });
    expect(c.grants).toEqual({ grants: [], machines: [] });
  });

  it('limits workspace.name by its trimmed length', () => {
    expect(parseHostConfig({ workspace: { name: ` ${'a'.repeat(64)} ` } }).workspace.name).toBe('a'.repeat(64));
  });

  it('accepts a ULID workspace.id from the deployment', () => {
    const c = parseHostConfig({ workspace: { id: '01JC0000000000000000000000', name: 'review-agent' } });
    expect(c.workspace.id).toBe('01JC0000000000000000000000');
  });

  it.each([
    [{ ...base, workspace: undefined }, /workspace must be an object/],
    [{ ...base, workspace: { id: 'not-a-ulid', name: 'w' } }, /workspace.id must be a ULID/],
    [{ ...base, workspace: { id: '01JC000000000000000000000I', name: 'w' } }, /workspace.id must be a ULID/],
    [{ ...base, workspace: { id: 12345, name: 'w' } }, /workspace.id must be a ULID/],
    [{ ...base, workspace: { name: ' ' } }, /workspace.name/],
    [{ ...base, workspace: { name: 'w', color: { hue: 400 } } }, /hue/],
    [{ ...base, identity: { provider: 'oidc' } }, /identity.provider/],
    [{ ...base, grants: [{ team: 'acme/x', tier: 'admin' }] }, /tier must be one of/],
    [{ workspace: { name: 'w' }, identity: { provider: 'github', org: 'not an org!' } }, /identity.org must be a GitHub org login/],
    [{ ...base, workspace: { name: 'a'.repeat(65) } }, /workspace.name/],
    [{ ...base, workspace: { name: 'evil\u001b[2Jname' } }, /control characters/],
    [{ ...base, workspace: { name: 'two\nlines' } }, /control characters/],
    [{ ...base, grant: [] }, /host config has unknown key grant/],
    [{ ...base, workspace: { Id: '01JC0000000000000000000000', name: 'w' } }, /workspace has unknown key Id/],
    [{ ...base, identity: { provider: 'github', orgs: 'acme' } }, /identity has unknown key orgs/]
  ])('rejects %#', (raw, msg) => {
    expect(() => parseHostConfig(raw)).toThrow(HostConfigError);
    expect(() => parseHostConfig(raw)).toThrow(msg);
  });
});

describe('loadHostConfig', () => {
  it('reads YAML from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-cfg-'));
    const p = join(dir, 'config.yaml');
    writeFileSync(p, 'workspace: { name: w }\ngrants:\n  - { login: some-contractor, tier: steer }\n');
    expect((await loadHostConfig(p)).grants.grants).toEqual([{ login: 'some-contractor', tier: 'steer' }]);
  });

  it('names the file on a read or YAML error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-cfg-'));
    await expect(loadHostConfig(join(dir, 'missing.yaml'))).rejects.toThrow(/cannot read .*missing.yaml: ENOENT/);
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'workspace: [unclosed');
    await expect(loadHostConfig(bad)).rejects.toThrow(/not valid YAML/);
  });
});

describe('readHostEnv', () => {
  it('applies the deployment contract defaults', () => {
    expect(readHostEnv({})).toEqual({
      port: 8080,
      configPath: '/etc/fleet-host/config.yaml',
      stateDir: '/home/fleet/.claude/fleet-host',
      brokerSocket: '/run/broker/broker.sock'
    });
  });

  it('honours FLEET_HOST_PORT and FLEET_HOST_CONFIG', () => {
    expect(readHostEnv({ FLEET_HOST_PORT: '9000', FLEET_HOST_CONFIG: '/c.yaml' })).toMatchObject({ port: 9000, configPath: '/c.yaml' });
    expect(() => readHostEnv({ FLEET_HOST_PORT: 'x' })).toThrow(/FLEET_HOST_PORT/);
  });
});
