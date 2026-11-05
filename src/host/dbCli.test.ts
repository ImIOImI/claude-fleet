import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBootstrapArgs, runDbCommand, scrubbingSink, UsageError } from './dbCli.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:567639518918:secret:fleet-agent-infra-use1-rds--connection-string-glXLj2';
const PW = 'Adm1n-Secret-"quoted"\\value';

function config(db: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-dbcli-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `workspace: { name: jobs }\n${db ? `db: ${JSON.stringify(db)}\n` : ''}`);
  return path;
}
// Nothing listens on port 1: the connect fails after the credential is resolved.
const closedDb = { host: '127.0.0.1', port: 1, database: 'fleet', user: 'fleet_agent', password: { kind: 'env', name: 'APP_PW' }, ssl: 'disable' };

async function run(argv: string[], env: NodeJS.ProcessEnv, getSecret?: (a: string, r: string) => Promise<string>) {
  const lines: string[] = [];
  const code = await runDbCommand(argv, { env, sink: (l) => lines.push(l), getSecret });
  return { code, out: lines.join('\n'), last: JSON.parse(lines.at(-1) as string) as Record<string, unknown> };
}

describe('parseBootstrapArgs', () => {
  it('secret ARN with infra field names', () => {
    expect(parseBootstrapArgs(['--admin-secret-arn', ARN, '--admin-user-field', 'DB_USER', '--admin-password-field', 'DB_PASSWORD', '--region', 'us-east-1'])).toEqual({
      admin: { kind: 'secret', arn: ARN, userField: 'DB_USER', passwordField: 'DB_PASSWORD', region: 'us-east-1', user: undefined },
      appPasswordFile: undefined,
      maintenanceDb: 'postgres'
    });
    expect(parseBootstrapArgs(['--admin-secret-arn', ARN]).admin).toMatchObject({ userField: 'username', passwordField: 'password' });
  });

  it('file, env and aws-rds-iam need --admin-user', () => {
    expect(parseBootstrapArgs(['--admin-password-file', '/s/pw', '--admin-user', 'm']).admin).toEqual({ kind: 'file', path: '/s/pw', user: 'm' });
    expect(parseBootstrapArgs(['--admin-password-env', 'PW', '--admin-user', 'm']).admin).toEqual({ kind: 'env', name: 'PW', user: 'm' });
    expect(parseBootstrapArgs(['--admin-iam', '--admin-user', 'm', '--region', 'us-east-1']).admin).toEqual({ kind: 'aws-rds-iam', user: 'm', region: 'us-east-1' });
    expect(() => parseBootstrapArgs(['--admin-password-env', 'PW'])).toThrow(/--admin-user is required/);
  });

  it('refuses zero or two sources, stray field flags, bad env names and unknown flags without echoing values', () => {
    expect(() => parseBootstrapArgs([])).toThrow(/exactly one of/);
    expect(() => parseBootstrapArgs(['--admin-password-env', 'A', '--admin-iam', '--admin-user', 'm'])).toThrow(/exactly one of/);
    expect(() => parseBootstrapArgs(['--admin-password-env', 'A', '--admin-user', 'm', '--admin-user-field', 'X'])).toThrow(/need --admin-secret-arn/);
    expect(() => parseBootstrapArgs(['--admin-password-env', 'not-a-name', '--admin-user', 'm'])).toThrow(/env var name/);
    const e = (() => { try { parseBootstrapArgs(['--admin-iam', '--admin-user', 'm', PW]); } catch (x) { return x as Error; } })();
    expect(e).toBeInstanceOf(UsageError);
    expect(e?.message).not.toContain('Secret');
  });
});

describe('scrubbingSink', () => {
  it('removes raw and JSON-escaped secrets, including ones added later', () => {
    const out: string[] = [];
    const later: string[] = [];
    const sink = scrubbingSink((l) => out.push(l), [[PW], later]);
    later.push('tok-123456');
    sink(JSON.stringify({ a: PW, b: `x ${PW} y`, c: 'tok-123456' }));
    sink(`raw ${PW}`);
    expect(out.join('\n')).not.toMatch(/Secret|tok-123456/);
    expect(out[1]).toBe('raw [redacted]');
  });
});

describe('runDbCommand', () => {
  it('bootstrap via the secret ARN: a failed connect prints neither the secret nor the password', async () => {
    const raw = JSON.stringify({ DB_USER: 'master', DB_PASSWORD: PW, host: 'h' });
    const r = await run(['bootstrap', '--admin-secret-arn', ARN, '--admin-user-field', 'DB_USER', '--admin-password-field', 'DB_PASSWORD'],
      { FLEET_HOST_CONFIG: config(closedDb), APP_PW: 'app-Secret-pw' }, async () => raw);
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ level: 'error', msg: 'bootstrap failed' });
    expect(r.out).not.toMatch(/Secret/);
  });

  it('a malformed secret fails without quoting it', async () => {
    const r = await run(['bootstrap', '--admin-secret-arn', ARN], { FLEET_HOST_CONFIG: config(closedDb) }, async () => `{"password": "${PW}`);
    expect(r.code).toBe(1);
    expect(r.last.error).toBe('admin secret is not a JSON object');
    expect(r.out).not.toMatch(/Secret/);
  });

  it('a config without db: fails both commands; one without github: is fine', async () => {
    const noDb = config(null);
    for (const argv of [['migrate'], ['bootstrap', '--admin-password-env', 'PW', '--admin-user', 'm']]) {
      const r = await run(argv, { FLEET_HOST_CONFIG: noDb, PW: PW });
      expect(r.code).toBe(1);
      expect(String(r.last.error)).toMatch(/has no db: block/);
    }
  });

  it('usage errors exit 2 and print the usage', async () => {
    const r = await run(['migrate', '--force'], {});
    expect(r.code).toBe(2);
    expect(String(r.last.usage)).toMatch(/fleet-host bootstrap/);
  });
});
