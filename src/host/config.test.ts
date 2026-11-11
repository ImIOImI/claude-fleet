import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

  it('trusts no forwarding proxies unless trustedProxyHops is set', () => {
    expect(parseHostConfig(base).trustedProxyHops).toBe(0);
    expect(parseHostConfig({ ...base, trustedProxyHops: 2 }).trustedProxyHops).toBe(2);
  });

  it.each([
    [{ ...base, trustedProxyHops: -1 }, /trustedProxyHops must be an integer from 0 to 10/],
    [{ ...base, trustedProxyHops: 1.5 }, /trustedProxyHops must be an integer from 0 to 10/],
    [{ ...base, trustedProxyHops: '1' }, /trustedProxyHops must be an integer from 0 to 10/],
    [{ ...base, trustedProxyHops: 11 }, /trustedProxyHops must be an integer from 0 to 10/],
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

  it('parses an optional github block: the App, a repositories allowlist and default permissions', () => {
    expect(parseHostConfig(base).github).toBeNull();
    const c = parseHostConfig({
      ...base,
      github: {
        appId: 5612251,
        installationId: '178595648',
        keyFile: '/var/run/secrets/github-app/key.pem',
        repositories: ['fleet-reviews', 'Fleet-Expertise'],
        permissions: { contents: 'write', pull_requests: 'write' }
      }
    });
    expect(c.github).toEqual({
      app: { appId: '5612251', installationId: '178595648', keyFile: '/var/run/secrets/github-app/key.pem' },
      repositories: ['fleet-expertise', 'fleet-reviews'],
      permissions: { contents: 'write', pull_requests: 'write' }
    });
    expect(parseHostConfig({ ...base, github: {} }).github).toEqual({ app: null, repositories: null, permissions: null });
  });

  it('refuses a malformed github block', () => {
    const app = { appId: 1, installationId: 2, keyFile: '/k' };
    expect(() => parseHostConfig({ ...base, github: { repositories: [] } })).toThrow(/github.repositories/);
    expect(() => parseHostConfig({ ...base, github: { repositories: ['SumerSports/x'] } })).toThrow(/github.repositories/);
    expect(() => parseHostConfig({ ...base, github: { permissions: { contents: 'admin' } } })).toThrow(/github.permissions/);
    expect(() => parseHostConfig({ ...base, github: { repos: ['x'] } })).toThrow(/unknown key repos/);
    expect(() => parseHostConfig({ ...base, github: { appId: 1 } })).toThrow(/set together/);
    expect(() => parseHostConfig({ ...base, github: { ...app, appId: 'x' } })).toThrow(/github.appId must be a positive integer/);
    expect(() => parseHostConfig({ ...base, github: { ...app, installationId: 1.5 } })).toThrow(/github.installationId must be a positive integer/);
    expect(() => parseHostConfig({ ...base, github: { ...app, keyFile: 'k' } })).toThrow(/github.keyFile must be an absolute path/);
  });

  it('parses an optional db block as a Postgres store config', () => {
    expect(parseHostConfig(base).db).toBeNull();
    const c = parseHostConfig({
      ...base,
      db: { host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', database: 'fleet', user: 'fleet_agent', password: { kind: 'aws-rds-iam', region: 'us-east-1' }, caFile: '/etc/ssl/certs/rds-global-bundle.pem' }
    });
    expect(c.db).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: {
        host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', port: 5432, database: 'fleet', user: 'fleet_agent',
        password: { kind: 'aws-rds-iam', region: 'us-east-1' }, ssl: 'verify-full', caFile: '/etc/ssl/certs/rds-global-bundle.pem'
      }
    });
    expect(parseHostConfig({ ...base, db: { connectionString: 'postgres://u@localhost/fleet' } }).db?.connection).toEqual({ connectionString: 'postgres://u@localhost/fleet' });
    expect(parseHostConfig({ ...base, db: { env: 'FLEET_DB_URL' } }).db?.connection).toEqual({ env: 'FLEET_DB_URL' });
    expect(parseHostConfig({
      ...base, db: { host: 'db.internal', database: 'fleet', user: 'fleet_agent', password: { kind: 'env', name: 'FLEET_DB_PASSWORD' }, ssl: 'disable' }
    }).db?.connection).toMatchObject({ password: { kind: 'env', name: 'FLEET_DB_PASSWORD' } });
  });

  it('db.queryUser: optional, a plain role name with room for its _raw sibling', () => {
    const db = { host: 'db.internal', database: 'fleet', user: 'fleet_agent', password: { kind: 'env', name: 'P' }, ssl: 'disable' };
    expect(parseHostConfig({ ...base, db }).db).not.toHaveProperty('queryUser');
    expect(parseHostConfig({ ...base, db: { ...db, queryUser: 'fleet_agent_query' } }).db?.queryUser).toBe('fleet_agent_query');
    for (const bad of ['Fleet', 'a-b', '', 'x'.repeat(60), 7]) {
      expect(() => parseHostConfig({ ...base, db: { ...db, queryUser: bad } })).toThrow(/db: queryUser must match/);
    }
  });

  it('refuses a static db password in any form: sessions can read the host config', () => {
    const cases = [
      { host: 'db.internal', database: 'fleet', user: 'fleet_agent', password: { kind: 'static', value: 'hunter2' }, ssl: 'disable' },
      { connectionString: 'postgres://u:hunter2@localhost/fleet' },
      { connectionString: 'postgres://u@localhost/fleet?password=hunter2' }
    ];
    for (const db of cases) {
      let msg = '';
      try { parseHostConfig({ ...base, db }); } catch (err) { msg = (err as Error).message; }
      expect(msg).toMatch(/^db: .*(static|password).*"env" or "aws-rds-iam"/);
      expect(msg).not.toContain('hunter2');
      expect(msg).not.toContain('config.json');
    }
  });

  it('refuses a db block with kind, an unknown key, or no connection', () => {
    expect(() => parseHostConfig({ ...base, db: { kind: 'postgres', connectionString: 'postgres://x' } })).toThrow(/db has unknown key kind/);
    expect(() => parseHostConfig({ ...base, db: { connectionString: 'postgres://x', name: 'fleet' } })).toThrow(/db: unknown key "name"/);
    expect(() => parseHostConfig({ ...base, db: {} })).toThrow(/db: needs exactly one of/);
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
      credSocket: '/run/fleet-host/cred.sock',
      projectsDir: join(homedir(), '.claude', 'projects'),
      brokerSocket: '/run/broker/broker.sock',
      brokerAddr: null,
      mcpSocket: '/run/fleet/mcp.sock',
      mcpSocketGroup: null,
      embedDir: '/usr/local/lib/fleet-host/embed'
    });
  });

  it('reads CLAUDE_FLEET_BROKER_ADDR as host:port', () => {
    expect(readHostEnv({ CLAUDE_FLEET_BROKER_ADDR: 'ws.platform-ops.svc:7070' }).brokerAddr).toEqual({ host: 'ws.platform-ops.svc', port: 7070 });
    expect(() => readHostEnv({ CLAUDE_FLEET_BROKER_ADDR: 'ws:x' })).toThrow('CLAUDE_FLEET_BROKER_ADDR ws:x is not host:port');
  });

  it('honours FLEET_HOST_PORT and FLEET_HOST_CONFIG', () => {
    expect(readHostEnv({ FLEET_HOST_PORT: '9000', FLEET_HOST_CONFIG: '/c.yaml' })).toMatchObject({ port: 9000, configPath: '/c.yaml' });
    expect(() => readHostEnv({ FLEET_HOST_PORT: 'x' })).toThrow(/FLEET_HOST_PORT/);
  });

  it('reads the MCP socket and its group', () => {
    expect(readHostEnv({}).mcpSocket).toBe('/run/fleet/mcp.sock');
    expect(readHostEnv({}).mcpSocketGroup).toBeNull();
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET: '/x/m.sock', FLEET_HOST_MCP_SOCKET_GROUP: '1500' })).toMatchObject({ mcpSocket: '/x/m.sock', mcpSocketGroup: 1500 });
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET_GROUP: '1500' })).toMatchObject({ mcpSocket: '/run/fleet/mcp/mcp.sock', mcpSocketGroup: 1500 });
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET_GROUP: 'staff' })).toThrow(/FLEET_HOST_MCP_SOCKET_GROUP/);
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET: 'run/mcp.sock' })).toThrow(/FLEET_HOST_MCP_SOCKET must be an absolute path/);
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET: '/' + 'a'.repeat(106) }).mcpSocket).toHaveLength(107);
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET: '/' + 'a'.repeat(107) })).toThrow(/FLEET_HOST_MCP_SOCKET is longer than 107 bytes/);
  });
});

describe('automations', () => {
  const base = { workspace: { name: 'w' }, grants: [{ team: 'acme/platform', tier: 'read' }] };
  const def = (name: string) => ({ name, triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'hi' } }] });
  it('defaults to none and keeps entries with enabled defaulting to true', () => {
    expect(parseHostConfig(base).automations).toEqual([]);
    expect(parseHostConfig({ ...base, automations: [{ definition: def('a') }, { definition: def('b'), enabled: false }] }).automations)
      .toEqual([{ definition: def('a'), enabled: true }, { definition: def('b'), enabled: false }]);
  });
  it('refuses bad shapes, duplicate names and unknown keys', () => {
    expect(() => parseHostConfig({ ...base, automations: {} })).toThrow(/automations must be a list/);
    expect(() => parseHostConfig({ ...base, automations: [{ definition: def('a') }, { definition: def('a') }] })).toThrow(/duplicate automation name a/);
    expect(() => parseHostConfig({ ...base, automations: [{ definition: {} }] })).toThrow(/automations\[0\]\.definition\.name/);
    expect(() => parseHostConfig({ ...base, automations: [{ definition: def('a'), on: true }] })).toThrow(/automations\[0\] has unknown key on/);
    expect(() => parseHostConfig({ ...base, automations: [{ definition: def('a'), enabled: 'yes' }] })).toThrow(/automations\[0\]\.enabled must be true or false/);
    expect(() => parseHostConfig({ ...base, automations: ['x'] })).toThrow(/automations\[0\] must be an object/);
    expect(() => parseHostConfig({ ...base, automations: Array.from({ length: 101 }, (_, i) => ({ definition: def(`a${i}`) })) })).toThrow(/at most 100/);
    expect(parseHostConfig({ ...base, automations: Array.from({ length: 100 }, (_, i) => ({ definition: def(`a${i}`) })) }).automations).toHaveLength(100);
  });
});

describe('search', () => {
  it('defaults to the embedder on and accepts false', () => {
    expect(parseHostConfig(base).search).toEqual({ embedder: true });
    expect(parseHostConfig({ ...base, search: {} }).search).toEqual({ embedder: true });
    expect(parseHostConfig({ ...base, search: { embedder: false } }).search).toEqual({ embedder: false });
  });
  it('refuses unknown keys and non-booleans', () => {
    expect(() => parseHostConfig({ ...base, search: { embeder: false } })).toThrow('search has unknown key embeder');
    expect(() => parseHostConfig({ ...base, search: { embedder: 'no' } })).toThrow('search.embedder must be true or false');
    expect(() => parseHostConfig({ ...base, search: true })).toThrow('search must be an object');
  });
});

it('readHostEnv: embedDir defaults and is overridable', () => {
  expect(readHostEnv({}).embedDir).toBe('/usr/local/lib/fleet-host/embed');
  expect(readHostEnv({ FLEET_HOST_EMBED_DIR: '/x' }).embedDir).toBe('/x');
});
