import { describe, expect, it, vi } from 'vitest';
import { AdminCredentialError, resolveAdminCredential, type GetSecretString } from './adminCreds.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:567639518918:secret:fleet-agent-infra-use1-rds--connection-string-glXLj2';
const target = { host: 'db.example.com', port: 5432 };
const PW = 'm4ster-Secret-Value';
const fake = (s: string): GetSecretString => vi.fn(async () => s);
const secret = (o: Partial<{ userField: string; passwordField: string; region: string; user: string }> = {}) =>
  ({ kind: 'secret' as const, arn: ARN, userField: 'username', passwordField: 'password', ...o });

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('resolveAdminCredential: Secrets Manager', () => {
  it('reads username/password by default, in the ARN region', async () => {
    const get = fake(JSON.stringify({ username: 'master', password: PW }));
    const c = await resolveAdminCredential(secret(), { env: {}, getSecret: get, target });
    expect(c).toMatchObject({ user: 'master', password: PW });
    expect(c.secrets).toContain(PW);
    expect(get).toHaveBeenCalledWith(ARN, 'us-east-1');
  });

  it('maps configurable fields (DB_USER / DB_PASSWORD) and honours --region and --admin-user', async () => {
    const raw = JSON.stringify({ DB_USER: 'fleet_master', DB_PASSWORD: PW, username: 'wrong', password: 'wrong' });
    const get = fake(raw);
    const c = await resolveAdminCredential(secret({ userField: 'DB_USER', passwordField: 'DB_PASSWORD', region: 'us-west-2' }), { env: {}, getSecret: get, target });
    expect(c).toMatchObject({ user: 'fleet_master', password: PW });
    expect(get).toHaveBeenCalledWith(ARN, 'us-west-2');
    const o = await resolveAdminCredential(secret({ userField: 'DB_USER', passwordField: 'DB_PASSWORD', user: 'override' }), { env: {}, getSecret: fake(raw), target });
    expect(o.user).toBe('override');
  });

  it('names a missing field, never the secret', async () => {
    const e = await failure(resolveAdminCredential(secret({ passwordField: 'DB_PASSWORD' }), { env: {}, getSecret: fake(JSON.stringify({ username: 'm', password: PW })), target }));
    expect(e).toBeInstanceOf(AdminCredentialError);
    expect(e.message).toMatch(/DB_PASSWORD/);
    expect(e.message).not.toContain(PW);
  });

  it('a secret that is not a JSON object fails without quoting it', async () => {
    for (const raw of [`not json ${PW}`, `["${PW}"]`, `"${PW}"`]) {
      const e = await failure(resolveAdminCredential(secret(), { env: {}, getSecret: fake(raw), target }));
      expect(e.message).toBe('admin secret is not a JSON object');
    }
  });

  it('refuses something that is not a Secrets Manager ARN', async () => {
    const e = await failure(resolveAdminCredential({ ...secret(), arn: 'arn:aws:s3:::bucket' }, { env: {}, getSecret: fake('{}'), target }));
    expect(e.message).toMatch(/not a Secrets Manager secret ARN/);
  });

  it('accepts an RDS-managed secret ARN (rds!cluster-…)', async () => {
    const rds = 'arn:aws:secretsmanager:us-east-1:567639518918:secret:rds!cluster-0a1b2c3d-4e5f-6789-abcd-ef0123456789-AbCdEf';
    const c = await resolveAdminCredential({ ...secret(), arn: rds }, { env: {}, getSecret: fake(JSON.stringify({ username: 'm', password: PW })), target });
    expect(c.user).toBe('m');
  });
});

describe('resolveAdminCredential: file, env, aws-rds-iam', () => {
  it('file: strips one trailing newline; empty or unreadable fails without the path contents', async () => {
    const c = await resolveAdminCredential({ kind: 'file', path: '/x', user: 'm' }, { env: {}, getSecret: fake(''), target, readFile: async () => `${PW}\n` });
    expect(c).toMatchObject({ user: 'm', password: PW, secrets: [PW] });
    const empty = await failure(resolveAdminCredential({ kind: 'file', path: '/x', user: 'm' }, { env: {}, getSecret: fake(''), target, readFile: async () => '\n' }));
    expect(empty.message).toMatch(/empty/);
    const enoent = Object.assign(new Error(`ENOENT ${PW}`), { code: 'ENOENT' });
    const missing = await failure(resolveAdminCredential({ kind: 'file', path: '/x', user: 'm' }, { env: {}, getSecret: fake(''), target, readFile: async () => { throw enoent; } }));
    expect(missing.message).toBe('cannot read --admin-password-file: ENOENT');
  });

  it('env: reads the named variable; unset names only the variable', async () => {
    const c = await resolveAdminCredential({ kind: 'env', name: 'PGADMIN_PW', user: 'm' }, { env: { PGADMIN_PW: PW }, getSecret: fake(''), target });
    expect(c).toMatchObject({ user: 'm', password: PW, secrets: [PW] });
    const e = await failure(resolveAdminCredential({ kind: 'env', name: 'PGADMIN_PW', user: 'm' }, { env: {}, getSecret: fake(''), target }));
    expect(e.message).toBe('admin password env var PGADMIN_PW is not set');
  });

  it('aws-rds-iam: a token provider, signed for the target; needs a region', async () => {
    const c = await resolveAdminCredential({ kind: 'aws-rds-iam', user: 'm', region: 'us-east-1' }, { env: {}, getSecret: fake(''), target });
    expect(typeof c.password).toBe('function');
    await expect(resolveAdminCredential({ kind: 'aws-rds-iam', user: 'm' }, { env: {}, getSecret: fake(''), target })).rejects.toThrow(/region/);
  });
});
