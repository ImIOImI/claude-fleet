# fleet-host bootstrap and migrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two one-shot `fleet-host` subcommands for Argo PreSync Jobs. `bootstrap` (admin credentials) creates the database, `vector`, the app login role, its `search_path`, and the schema it owns. `migrate` (app role) runs the host's startup migrations ahead of a rollout. Together they replace platform-ops#36's aws-cli + postgres:16 + bash Job.

**Architecture:** `bootstrap.ts` is a list of check/apply steps run over a `pg.Client` as the admin. Each step checks, applies only when the check fails, and every check must pass again afterwards. That makes it idempotent, and a second run prints that nothing changed. The admin credential comes from `adminCreds.ts`: a Secrets Manager ARN with mapped JSON fields (the client is injectable), a file, an env var, or aws-rds-iam. It is held in memory only. `hostMigrate.ts` calls the same functions the host calls at startup: `openHostDb` (host track), then `migratePgStores` (inbox, vector check, state). Both run unfenced under `migratePostgres`'s advisory lock. `dbCli.ts` parses arguments, scrubs every secret it read from each output line, and returns an exit code. `cli.ts` dispatches to it.

**Tech Stack:** TypeScript (Node 22), `pg`, `kysely`, `@aws-sdk/client-secrets-manager` 3.1162.0 (pinned like the other `@aws-sdk` packages), vitest.

## Global Constraints

- Admin credential is never stored or printed. Errors name sources and fields, never values (`JSON.parse`'s message quotes its input, so it is never surfaced).
- The app role password reaches the server only as a SCRAM-SHA-256 verifier. DDL can land in server logs.
- TLS: the host config `db:` rules (`pgSsl` / `pgPoolConfig`). The default is verify-full with `/etc/ssl/certs/rds-global-bundle.pem`.
- bootstrap never logs in as the app role; it verifies from the admin session. migrate needs no admin access.
- Works with a host config that has `db:` and no `github:`.
- Comments: terse, per `/workspace/.claude/rules/review-conventions.md`.
- Gates: `npx tsc --noEmit -p tsconfig.node.json`, `-p tsconfig.web.json`, `-p tsconfig.host.json`; `CI=true npx vitest run src`; `CI=true npm run test:unit:pg`; `npm run build:host`.

## File structure

- Create `src/host/scram.ts`: `scramVerifier(password, salt?, iterations?)`.
- Create `src/host/adminCreds.ts`: `AdminSource`, `AdminCredential`, `resolveAdminCredential`, `awsGetSecret`.
- Create `src/host/bootstrap.ts`: `BootstrapTarget`, `bootstrapTarget(cfg, env, appPasswordFile?)`, `bootstrap(target, admin, opts)`.
- Create `src/host/hostMigrate.ts`: `migrateHostStore(cfg, opts)`.
- Create `src/host/dbCli.ts`: `parseBootstrapArgs`, `scrubbingSink`, `runDbCommand`.
- Modify `src/host/cli.ts`: dispatch `bootstrap` / `migrate`; refuse unknown commands.
- Tests: `src/host/scram.test.ts`, `src/host/adminCreds.test.ts`, `src/host/dbCli.test.ts` (default suite) and `src/host/bootstrap.pg.test.ts` (Postgres suite, added to `vitest.pg.config.ts`).
- Docs: `docs/SPEC.md` §*Remote host*. The Dockerfile needs no change: `/usr/local/bin/fleet-host` already wraps the bundle and tini is the entrypoint.

---

### Task 1: SCRAM verifier

**Files:** Create `src/host/scram.ts`, `src/host/scram.test.ts`.

**Interfaces:** Produces `scramVerifier(password: string, salt?: Buffer, iterations?: number): string`.

The reference value is what Postgres 16 stored for `CREATE ROLE … PASSWORD 'pencil'` (read from `pg_authid`).

- [ ] **Step 1: failing test**

File: `src/host/scram.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { scramVerifier } from './scram.js';

describe('scramVerifier', () => {
  it('matches the verifier Postgres stores for the same salt', () => {
    expect(scramVerifier('pencil', Buffer.from('ZaLhsOYt3HI1Xl6W2BIRVQ==', 'base64'))).toBe(
      'SCRAM-SHA-256$4096:ZaLhsOYt3HI1Xl6W2BIRVQ==$/9fm51v0kDRJ29/IqdwV4XKERxRdSHkXS/k5YnjmWP8=:QKeKcn4lxjHfowZWKEhryi3VPCCRQ0+4xGFR7k7gfH0='
    );
  });

  it('salts each call and never contains the password', () => {
    const a = scramVerifier('pencil-secret');
    expect(a).not.toBe(scramVerifier('pencil-secret'));
    expect(a).not.toContain('pencil-secret');
  });

  it('refuses a non-ASCII password (SASLprep is not implemented)', () => {
    expect(() => scramVerifier('pässword')).toThrow(/printable ASCII/);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/host/scram.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: implementation**

File: `src/host/scram.ts`
```ts
// A SCRAM-SHA-256 verifier (RFC 7677, Postgres's rolpassword format), so CREATE ROLE never sends the plaintext.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  // Postgres SASLpreps the password; for printable ASCII that is the identity.
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('the app role password must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (s: string) => createHmac('sha256', salted).update(s).digest();
  const stored = createHash('sha256').update(hmac('Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac('Server Key').toString('base64')}`;
}
```

- [ ] **Step 4:** re-run, expect PASS.
- [ ] **Step 5:** commit `feat(host): SCRAM-SHA-256 verifier for the app role password`.

---

### Task 2: Admin credential sources

**Files:** Create `src/host/adminCreds.ts` and `src/host/adminCreds.test.ts`. Modify `package.json` and `package-lock.json` to add `@aws-sdk/client-secrets-manager@3.1162.0`, exact.

**Interfaces:**
- Consumes: `passwordProvider` (`src/main/store/passwordProvider.ts`).
- Produces:
  - `type AdminSource = { kind: 'secret'; arn; userField; passwordField; region?; user? } | { kind: 'file'; path; user } | { kind: 'env'; name; user } | { kind: 'aws-rds-iam'; user; region? }`
  - `interface AdminCredential { user: string; password: string | (() => Promise<string>); secrets: string[] }`
  - `type GetSecretString = (arn: string, region: string) => Promise<string>`
  - `resolveAdminCredential(src, { env, getSecret, readFile?, target: { host, port } })`
  - `awsGetSecret`
  - `AdminCredentialError`

- [ ] **Step 1: failing test**

File: `src/host/adminCreds.test.ts`
```ts
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
```

- [ ] **Step 2:** `npx vitest run src/host/adminCreds.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: implementation**

File: `src/host/adminCreds.ts`
```ts
// Where `fleet-host bootstrap` gets the admin credential. Memory only; errors name sources and fields, never values.
import { readFile } from 'node:fs/promises';
import { passwordProvider } from '../main/store/passwordProvider.js';

export type AdminSource =
  | { kind: 'secret'; arn: string; userField: string; passwordField: string; region?: string; user?: string }
  | { kind: 'file'; path: string; user: string }
  | { kind: 'env'; name: string; user: string }
  | { kind: 'aws-rds-iam'; user: string; region?: string };

export interface AdminCredential {
  user: string;
  password: string | (() => Promise<string>);
  /** Values to scrub from output; aws-rds-iam tokens are added as they are minted. */
  secrets: string[];
}

export type GetSecretString = (arn: string, region: string) => Promise<string>;

export class AdminCredentialError extends Error {}

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/** The AWS SDK default chain (Pod Identity, IRSA, env, profile). */
export const awsGetSecret: GetSecretString = async (arn, region) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region });
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (typeof out.SecretString !== 'string') throw new AdminCredentialError('admin secret has no SecretString (binary secrets are not supported)');
    return out.SecretString;
  } finally {
    client.destroy();
  }
};

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  getSecret: GetSecretString;
  readFile?: (path: string) => Promise<string>;
  /** The admin connection's endpoint: aws-rds-iam tokens are signed for it. */
  target: { host: string; port: number };
}

export async function resolveAdminCredential(src: AdminSource, d: ResolveDeps): Promise<AdminCredential> {
  switch (src.kind) {
    case 'secret': {
      const m = SECRET_ARN.exec(src.arn);
      if (!m) throw new AdminCredentialError('--admin-secret-arn is not a Secrets Manager secret ARN');
      const raw = await d.getSecret(src.arn, src.region ?? m[1]);
      let obj: unknown = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        // JSON.parse's message quotes the input.
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new AdminCredentialError('admin secret is not a JSON object');
      const field = (f: string): string => {
        const v = (obj as Record<string, unknown>)[f];
        if (typeof v !== 'string' || !v) throw new AdminCredentialError(`admin secret has no non-empty string field "${f}"`);
        return v;
      };
      const password = field(src.passwordField);
      return { user: src.user ?? field(src.userField), password, secrets: [password, raw] };
    }
    case 'file': {
      let text: string;
      try {
        text = await (d.readFile ?? ((p: string) => readFile(p, 'utf8')))(src.path);
      } catch (e) {
        throw new AdminCredentialError(`cannot read --admin-password-file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      }
      const password = text.replace(/\r?\n$/, '');
      if (!password) throw new AdminCredentialError('--admin-password-file is empty');
      return { user: src.user, password, secrets: [password] };
    }
    case 'env': {
      const password = d.env[src.name];
      if (!password) throw new AdminCredentialError(`admin password env var ${src.name} is not set`);
      return { user: src.user, password, secrets: [password] };
    }
    case 'aws-rds-iam': {
      const mint = passwordProvider({ kind: 'aws-rds-iam', region: src.region }, { ...d.target, user: src.user }, d.env);
      const secrets: string[] = [];
      return {
        user: src.user,
        password: async () => {
          const t = await mint();
          secrets.push(t);
          return t;
        },
        secrets
      };
    }
  }
}
```

- [ ] **Step 4:** re-run, expect PASS.
- [ ] **Step 5:** commit `feat(host): admin credential sources for fleet-host bootstrap` (include `package.json` and `package-lock.json`).

---

### Task 3: Bootstrap steps

**Files:** Create `src/host/bootstrap.ts` and `src/host/bootstrap.pg.test.ts`. Modify `vitest.pg.config.ts` to add the test file.

**Interfaces:**
- Consumes: `AdminCredential` (Task 2), `scramVerifier` (Task 1), `pgSsl`, `pgPoolConfig`, `passwordProvider`.
- Produces:
  - `interface BootstrapTarget { host; port; database; user; schema; ssl; iam; appPassword }`
  - `bootstrapTarget(cfg: PostgresStoreConfig, env, appPasswordFile?: string): BootstrapTarget`
  - `bootstrap(t, admin, { log, maintenanceDb?, onSecret?, connectTimeoutMs? }): Promise<string[]>`, where each entry is one change
  - `BootstrapError`

The steps run in this order:
1. On the maintenance DB: database.
2. On the target DB:
   1. the login role (LOGIN, NOCREATEDB, NOCREATEROLE; refuses a superuser; sets a password only on create);
   2. `rds_iam` (IAM only);
   3. role-level `search_path = <schema>, public`;
   4. `vector` ≥ 0.8.0;
   5. the schema, owned by the role;
   6. `CONNECT` on the database;
   7. `USAGE` on `public`.

Under Postgres 16, a non-superuser CREATEROLE admin, such as the RDS master, holds ADMIN on the roles it creates but not SET, and SET is what `CREATE SCHEMA … AUTHORIZATION` needs. The schema step therefore takes `GRANT <role> TO CURRENT_USER WITH INHERIT FALSE, SET TRUE` for one transaction and revokes it before commit.

- [ ] **Step 1: failing pg tests** (run directly through `bootstrap()`; Task 5 adds the CLI-level cases to the same file)

File: `src/host/bootstrap.pg.test.ts`
```ts
// fleet-host bootstrap against a real server. The test superuser stands in for the RDS master; every test makes its
// own database and roles and drops them after.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { isPg } from '../main/store/testStore.js';
import type { AdminCredential } from './adminCreds.js';
import { bootstrap, type BootstrapTarget } from './bootstrap.js';
import { createLogger } from './log.js';
import { scramVerifier } from './scram.js';

const url = isPg ? parseConnectionString(process.env.PG_TEST_URL as string) : null;
const HOST = url?.host ?? '';
const PORT = Number(url?.port ?? 5432);
const SUPER = url?.user ?? 'postgres';
const SUPER_PW = url?.password ?? 'trust-auth-ignores-this';
const id = pg.escapeIdentifier;

async function client(user: string, password: string, database = 'postgres'): Promise<pg.Client> {
  const c = new pg.Client({ host: HOST, port: PORT, user, password, database });
  await c.connect();
  return c;
}
async function su<T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> {
  const c = await client(SUPER, SUPER_PW, database);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function names() {
  const s = randomBytes(4).toString('hex');
  const n = { db: `fb_${s}`, app: `fb_app_${s}`, admin: `fb_admin_${s}`, appPw: `app-${randomBytes(9).toString('hex')}` };
  cleanups.push(() =>
    su(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${id(n.db)} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${id(n.app)}`);
      await c.query(`DROP ROLE IF EXISTS ${id(n.admin)}`);
    })
  );
  return n;
}

const superAdmin = (): AdminCredential => ({ user: SUPER, password: SUPER_PW, secrets: [SUPER_PW] });
const target = (n: ReturnType<typeof names>, o: Partial<BootstrapTarget> = {}): BootstrapTarget => ({
  host: HOST, port: PORT, database: n.db, user: n.app, schema: 'fleet', ssl: false, iam: false,
  appPassword: async () => n.appPw, ...o
});
const quiet = { log: createLogger(() => undefined) };

async function state(n: ReturnType<typeof names>) {
  return su(async (c) => {
    const role = (await c.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [n.app])).rows[0];
    const cfg = (await c.query('SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE s.setdatabase = 0 AND r.rolname = $1', [n.app])).rows[0]?.setconfig;
    const owner = (await c.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'fleet'`)).rows[0]?.o;
    const vector = (await c.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)).rowCount;
    return { role, cfg, owner, vector };
  }, n.db);
}

describe.skipIf(!isPg)('bootstrap', () => {
  it('creates everything on a fresh server, then a second run changes nothing', async () => {
    const n = names();
    const first = await bootstrap(target(n), superAdmin(), quiet);
    expect(first).toEqual([
      `created database ${n.db}`,
      `created role ${n.app} (LOGIN, password set)`,
      `set search_path of ${n.app} to fleet, public`,
      'created extension vector',
      `created schema fleet owned by ${n.app}`
    ]);
    expect(await state(n)).toEqual({
      role: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      cfg: ['search_path=fleet, public'],
      owner: n.app,
      vector: 1
    });
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('stores only a SCRAM verifier the server accepts as its own', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    const stored = await su(async (c) => (await c.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [n.app])).rows[0].rolpassword as string);
    const salt = /^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(stored)?.[1];
    expect(stored).toBe(scramVerifier(n.appPw, Buffer.from(salt as string, 'base64')));
  });

  it('repairs drift: a CREATEDB role, a wrong search_path, a schema owned by someone else', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    await su(async (c) => {
      await c.query(`ALTER ROLE ${id(n.app)} CREATEDB CREATEROLE`);
      await c.query(`ALTER ROLE ${id(n.app)} SET search_path = public`);
      await c.query(`ALTER SCHEMA fleet OWNER TO ${id(SUPER)}`);
    }, n.db);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([
      `altered role ${n.app} to LOGIN NOCREATEDB NOCREATEROLE`,
      `set search_path of ${n.app} to fleet, public`,
      `changed owner of schema fleet to ${n.app}`
    ]);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('refuses a superuser app role', async () => {
    const n = names();
    await su((c) => c.query(`CREATE ROLE ${id(n.app)} LOGIN SUPERUSER`));
    await expect(bootstrap(target(n), superAdmin(), quiet)).rejects.toThrow(/is a superuser/);
  });

  it('aws-rds-iam: grants rds_iam and sets no password', async () => {
    const n = names();
    const made = await su(async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`)).rowCount === 0 && (await c.query('CREATE ROLE rds_iam NOLOGIN'), true));
    if (made) cleanups.unshift(() => su(async (c) => void (await c.query('DROP ROLE IF EXISTS rds_iam'))));
    const t = target(n, { iam: true, appPassword: null });
    expect(await bootstrap(t, superAdmin(), quiet)).toContain(`granted rds_iam to ${n.app}`);
    const row = await su(async (c) => (await c.query(`SELECT rolpassword, pg_has_role(rolname, 'rds_iam', 'MEMBER') AS iam FROM pg_authid WHERE rolname = $1`, [n.app])).rows[0]);
    expect(row).toEqual({ rolpassword: null, iam: true });
    expect(await bootstrap(t, superAdmin(), quiet)).toEqual([]);
  });

  it('aws-rds-iam without an rds_iam role names the problem', async () => {
    const n = names();
    const exists = await su(async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`)).rowCount === 1);
    if (exists) return;
    await expect(bootstrap(target(n, { iam: true, appPassword: null }), superAdmin(), quiet)).rejects.toThrow(/rds_iam does not exist/);
  });

  it('works as a non-superuser CREATEDB CREATEROLE admin (the RDS master) and leaves it no SET on the app role', async () => {
    const n = names();
    const adminPw = `adm-${randomBytes(9).toString('hex')}`;
    await su(async (c) => {
      await c.query(`CREATE ROLE ${id(n.admin)} LOGIN CREATEDB CREATEROLE PASSWORD ${pg.escapeLiteral(adminPw)}`);
      // pgvector is untrusted; on RDS rds_superuser creates it.
      await c.query(`CREATE DATABASE ${id(n.db)} OWNER ${id(n.admin)}`);
    });
    await su((c) => c.query('CREATE EXTENSION vector SCHEMA public'), n.db);
    const admin: AdminCredential = { user: n.admin, password: adminPw, secrets: [adminPw] };
    expect(await bootstrap(target(n), admin, quiet)).toEqual([
      `created role ${n.app} (LOGIN, password set)`,
      `set search_path of ${n.app} to fleet, public`,
      `created schema fleet owned by ${n.app}`
    ]);
    const set = await su(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
         AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2) AND m.set_option`, [n.app, n.admin])).rows[0].n);
    expect(set).toBe(0);
    expect(await bootstrap(target(n), admin, quiet)).toEqual([]);
  });

  it('a wrong admin user fails as an auth error that carries no password', async () => {
    const n = names();
    const err = await bootstrap(target(n), { user: n.admin, password: 'S3cret-never-printed', secrets: [] }, quiet).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/admin login to database "postgres" as "fb_admin_[0-9a-f]+" failed/);
    expect((err as Error).message).not.toContain('S3cret-never-printed');
  });
});
```

- [ ] **Step 2:** add `'src/host/bootstrap.pg.test.ts',` to `vitest.pg.config.ts` `include`. Run `eval "$(scripts/pg-test-server.sh start)"; CI=true npx vitest run -c vitest.pg.config.ts src/host/bootstrap.pg.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: implementation**

File: `src/host/bootstrap.ts`
```ts
// `fleet-host bootstrap`: what the app role can't do for itself, done as an admin. Each step checks, applies only if
// the check fails, and every check must pass afterwards. It never logs in as the app role and never runs migrations.
import { readFile } from 'node:fs/promises';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { passwordProvider } from '../main/store/passwordProvider.js';
import { pgSsl } from '../main/store/pgSsl.js';
import { pgPoolConfig, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import type { AdminCredential } from './adminCreds.js';
import type { Logger } from './log.js';
import { scramVerifier } from './scram.js';

export interface BootstrapTarget {
  host: string;
  port: number;
  database: string;
  /** The app login role. */
  user: string;
  schema: string;
  ssl: false | ConnectionOptions;
  /** GRANT rds_iam; the role gets no password. */
  iam: boolean;
  /** Used only when bootstrap creates the role; null creates it without one. */
  appPassword: (() => Promise<string>) | null;
}

export interface BootstrapOptions {
  log: Logger;
  maintenanceDb?: string;
  /** Each secret bootstrap reads, for output scrubbing. */
  onSecret?: (v: string) => void;
  connectTimeoutMs?: number;
}

export class BootstrapError extends Error {}

interface Step {
  what: string;
  check(): Promise<boolean>;
  /** Returns what it changed. */
  apply(): Promise<string>;
}

const id = pg.escapeIdentifier;

/** Endpoint, role and TLS from the host config `db:` block, under the same rules the host connects with. */
export function bootstrapTarget(cfg: PostgresStoreConfig, env: NodeJS.ProcessEnv, appPasswordFile?: string): BootstrapTarget {
  const fromFile = appPasswordFile
    ? async () => {
        const v = (await readFile(appPasswordFile, 'utf8')).replace(/\r?\n$/, '');
        if (!v) throw new BootstrapError('--app-password-file is empty');
        return v;
      }
    : null;
  const c = cfg.connection;
  if ('host' in c) {
    const iam = c.password.kind === 'aws-rds-iam';
    if (iam && fromFile) throw new BootstrapError('--app-password-file conflicts with db.password kind aws-rds-iam');
    return {
      host: c.host, port: c.port, database: c.database, user: c.user, schema: cfg.schema, ssl: pgSsl(c.ssl, c.caFile), iam,
      appPassword: iam ? null : (fromFile ?? passwordProvider(c.password, c, env))
    };
  }
  const p = pgPoolConfig(cfg, env);
  const u = parseConnectionString(p.connectionString as string);
  if (!u.database || !u.user) throw new BootstrapError('the db connection string must name the database and the user');
  const pw = u.password;
  return {
    host: u.host || env.PGHOST || 'localhost', port: u.port ? Number(u.port) : 5432, database: u.database, user: u.user,
    schema: cfg.schema, ssl: p.ssl as false | ConnectionOptions, iam: false,
    appPassword: fromFile ?? (pw ? async () => pw : null)
  };
}

export async function bootstrap(t: BootstrapTarget, admin: AdminCredential, o: BootstrapOptions): Promise<string[]> {
  const changed: string[] = [];
  const run = async (steps: Step[]) => {
    for (const s of steps) {
      if (await s.check()) continue;
      const done = await s.apply();
      changed.push(done);
      o.log.log('info', `bootstrap: ${done}`);
    }
    for (const s of steps) if (!(await s.check())) throw new BootstrapError(`bootstrap: ${s.what} is still not in place after applying it`);
  };
  const m = await adminClient(t, admin, o.maintenanceDb ?? 'postgres', o);
  try {
    await run(databaseSteps(m, t));
  } finally {
    await m.end().catch(() => undefined);
  }
  const c = await adminClient(t, admin, t.database, o);
  try {
    await run(targetSteps(c, t, o));
  } finally {
    await c.end().catch(() => undefined);
  }
  return changed;
}

async function adminClient(t: BootstrapTarget, admin: AdminCredential, database: string, o: BootstrapOptions): Promise<pg.Client> {
  const c = new pg.Client({
    host: t.host, port: t.port, database, user: admin.user, password: admin.password, ssl: t.ssl,
    connectionTimeoutMillis: o.connectTimeoutMs ?? 10_000, application_name: 'fleet-host bootstrap'
  });
  c.on('error', () => undefined);
  try {
    await c.connect();
  } catch (e) {
    await c.end().catch(() => undefined);
    const code = (e as { code?: unknown }).code;
    if (code === '28P01' || code === '28000') {
      throw new BootstrapError(`admin login to database "${database}" as "${admin.user}" failed (${code}): check the admin credential`);
    }
    throw e;
  }
  return c;
}

async function one<T>(c: pg.Client, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await c.query(text, params)).rows[0] as T | undefined;
}

function databaseSteps(c: pg.Client, t: BootstrapTarget): Step[] {
  return [
    {
      what: `database ${t.database}`,
      check: async () => !!(await one(c, 'SELECT 1 FROM pg_database WHERE datname = $1', [t.database])),
      async apply() {
        await c.query(`CREATE DATABASE ${id(t.database)}`);
        return `created database ${t.database}`;
      }
    }
  ];
}

function targetSteps(c: pg.Client, t: BootstrapTarget, o: BootstrapOptions): Step[] {
  type Role = { login: boolean; super: boolean; createdb: boolean; createrole: boolean };
  const role = () =>
    one<Role>(c, 'SELECT rolcanlogin AS login, rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole FROM pg_roles WHERE rolname = $1', [t.user]);
  const ok = async (text: string, params: unknown[]) => !!(await one<{ ok: boolean }>(c, text, params))?.ok;
  const searchPath = `${t.schema}, public`;
  const steps: Step[] = [
    {
      what: `login role ${t.user}`,
      async check() {
        const r = await role();
        if (r?.super) throw new BootstrapError(`role ${t.user} is a superuser; refusing it as the app role`);
        return !!r && r.login && !r.createdb && !r.createrole;
      },
      async apply() {
        if (await role()) {
          await c.query(`ALTER ROLE ${id(t.user)} LOGIN NOCREATEDB NOCREATEROLE`);
          return `altered role ${t.user} to LOGIN NOCREATEDB NOCREATEROLE`;
        }
        const pw = t.appPassword ? await t.appPassword() : null;
        if (pw) o.onSecret?.(pw);
        await c.query(`CREATE ROLE ${id(t.user)} LOGIN${pw ? ` PASSWORD ${pg.escapeLiteral(scramVerifier(pw))}` : ''}`);
        return `created role ${t.user} (LOGIN, ${pw ? 'password set' : 'no password'})`;
      }
    }
  ];
  if (t.iam) {
    steps.push({
      what: `rds_iam membership of ${t.user}`,
      async check() {
        if (!(await one(c, `SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`))) {
          throw new BootstrapError('role rds_iam does not exist: aws-rds-iam needs an RDS or Aurora database');
        }
        return ok(`SELECT pg_has_role($1, 'rds_iam', 'MEMBER') AS ok`, [t.user]);
      },
      async apply() {
        await c.query(`GRANT rds_iam TO ${id(t.user)}`);
        return `granted rds_iam to ${t.user}`;
      }
    });
  }
  steps.push(
    {
      what: `search_path of ${t.user}`,
      async check() {
        const r = await one<{ cfg: string[] | null }>(
          c,
          'SELECT s.setconfig AS cfg FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE s.setdatabase = 0 AND r.rolname = $1',
          [t.user]
        );
        return (r?.cfg ?? []).some((e) => e.replace(/"/g, '') === `search_path=${searchPath}`);
      },
      async apply() {
        await c.query(`ALTER ROLE ${id(t.user)} SET search_path = ${id(t.schema)}, public`);
        return `set search_path of ${t.user} to ${searchPath}`;
      }
    },
    {
      what: 'extension vector 0.8.0 or later',
      async check() {
        const v = (await one<{ v: string }>(c, `SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`))?.v;
        if (!v) return false;
        const [maj, min] = v.split('.').map(Number);
        return maj > 0 || min >= 8;
      },
      async apply() {
        if (await one(c, `SELECT 1 FROM pg_extension WHERE extname = 'vector'`)) {
          await c.query('ALTER EXTENSION vector UPDATE');
          return 'updated extension vector';
        }
        await c.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
        return 'created extension vector';
      }
    },
    {
      what: `schema ${t.schema} owned by ${t.user}`,
      check: async () => (await one<{ owner: string }>(c, 'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [t.schema]))?.owner === t.user,
      async apply() {
        const exists = !!(await one(c, 'SELECT 1 FROM pg_namespace WHERE nspname = $1', [t.schema]));
        await asRole(c, t.user, () =>
          c.query(exists ? `ALTER SCHEMA ${id(t.schema)} OWNER TO ${id(t.user)}` : `CREATE SCHEMA ${id(t.schema)} AUTHORIZATION ${id(t.user)}`)
        );
        return exists ? `changed owner of schema ${t.schema} to ${t.user}` : `created schema ${t.schema} owned by ${t.user}`;
      }
    },
    {
      what: `CONNECT on database ${t.database} for ${t.user}`,
      check: () => ok(`SELECT has_database_privilege($1, current_database(), 'CONNECT') AS ok`, [t.user]),
      async apply() {
        await c.query(`GRANT CONNECT ON DATABASE ${id(t.database)} TO ${id(t.user)}`);
        return `granted CONNECT on database ${t.database} to ${t.user}`;
      }
    },
    {
      what: `USAGE on schema public for ${t.user}`,
      check: () => ok(`SELECT has_schema_privilege($1, 'public', 'USAGE') AS ok`, [t.user]),
      async apply() {
        await c.query(`GRANT USAGE ON SCHEMA public TO ${id(t.user)}`);
        return `granted USAGE on schema public to ${t.user}`;
      }
    }
  );
  return steps;
}

/** Runs `fn` able to SET ROLE to `role`. A PG16 CREATEROLE admin (the RDS master) holds only ADMIN on roles it
 *  created; the grant it takes here is revoked in the same transaction. */
async function asRole(c: pg.Client, role: string, fn: () => Promise<unknown>): Promise<void> {
  const v16 = (await one<{ v: number }>(c, `SELECT current_setting('server_version_num')::int AS v`))!.v >= 160000;
  const can = (await one<{ ok: boolean }>(c, `SELECT pg_has_role(current_user, $1, '${v16 ? 'SET' : 'MEMBER'}') AS ok`, [role]))!.ok;
  if (can) {
    await fn();
    return;
  }
  await c.query('BEGIN');
  try {
    await c.query(`GRANT ${id(role)} TO CURRENT_USER${v16 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`);
    await fn();
    await c.query(`REVOKE ${id(role)} FROM CURRENT_USER`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
```

- [ ] **Step 4:** re-run the pg test file; expect PASS. Then mutation-check idempotence: make the `search_path` check return `false`. The "second run changes nothing" assertions must fail. Revert.
- [ ] **Step 5:** commit `feat(host): idempotent database bootstrap steps`.

---

### Task 4: migrate

**Files:** Create `src/host/hostMigrate.ts`. Its test lives in `bootstrap.pg.test.ts` (Task 5), where a bootstrapped database supplies a real app role.

**Interfaces:** Produces `migrateHostStore(cfg: PostgresStoreConfig, { env?, log, extraTracks? }): Promise<Record<string, number>>` (track → version).

- [ ] **Step 1: implementation** (it is pure wiring over two tested functions; its behaviour is tested end to end in Task 5)

File: `src/host/hostMigrate.ts`
```ts
// `fleet-host migrate`: exactly the startup migrations (host track, then the stores'), run ahead of a rollout.
import { sql } from 'kysely';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { migratePgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { openHostDb } from './hostDb.js';
import type { Logger } from './log.js';

export async function migrateHostStore(
  cfg: PostgresStoreConfig,
  o: { env?: NodeJS.ProcessEnv; log: Logger; extraTracks?: readonly PgTrack[] }
): Promise<Record<string, number>> {
  const h = await openHostDb(cfg, o);
  try {
    await migratePgStores(h.pool, { state: true, extraTracks: o.extraTracks });
    const r = await sql<{ track: string; version: number }>`SELECT track, version FROM schema_migrations ORDER BY track`.execute(h.k);
    return Object.fromEntries(r.rows.map((x) => [x.track, Number(x.version)]));
  } finally {
    await h.end();
  }
}
```

- [ ] **Step 2:** `npx tsc --noEmit -p tsconfig.host.json`. Expected: clean.
- [ ] **Step 3:** commit together with Task 5. A reviewer can't judge it without its test.

---

### Task 5: CLI wiring and end-to-end tests

**Files:**
- Create `src/host/dbCli.ts` and `src/host/dbCli.test.ts`.
- Modify `src/host/cli.ts`.
- Append to `src/host/bootstrap.pg.test.ts`.

**Interfaces:**
- Consumes everything above.
- Produces:
  - `runDbCommand(argv: string[], { env, sink, getSecret?, extraTracks? }): Promise<number>`, where 0 means OK, 1 means failed, and 2 is a usage error
  - `parseBootstrapArgs(argv): BootstrapArgs`
  - `scrubbingSink(sink, lists): LogSink`

- [ ] **Step 1: failing unit tests**

File: `src/host/dbCli.test.ts`
```ts
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
    const e = (() => { try { parseBootstrapArgs([`--admin-password=${PW}`]); } catch (x) { return x as Error; } })();
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
```

- [ ] **Step 2:** `npx vitest run src/host/dbCli.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: implementation**

File: `src/host/dbCli.ts`
```ts
// `fleet-host bootstrap` and `fleet-host migrate`: one-shot Job commands. JSON lines on stdout; every secret read is
// scrubbed from each line.
import { parseArgs } from 'node:util';
import { awsGetSecret, resolveAdminCredential, type AdminSource, type GetSecretString } from './adminCreds.js';
import { bootstrap, bootstrapTarget } from './bootstrap.js';
import { HostConfigError, loadHostConfig, readHostEnv } from './config.js';
import { migrateHostStore } from './hostMigrate.js';
import { createLogger, type LogSink } from './log.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';

export const USAGE = [
  'fleet-host bootstrap (--admin-secret-arn ARN [--admin-user-field F] [--admin-password-field F] [--region R]',
  '                      | --admin-password-file PATH | --admin-password-env NAME | --admin-iam [--region R])',
  '                     [--admin-user NAME] [--app-password-file PATH] [--maintenance-db NAME]',
  'fleet-host migrate'
].join('\n');

export class UsageError extends Error {}

export interface BootstrapArgs {
  admin: AdminSource;
  appPasswordFile: string | undefined;
  maintenanceDb: string;
}

export interface DbCliDeps {
  env: NodeJS.ProcessEnv;
  sink: LogSink;
  getSecret?: GetSecretString;
  /** Tests: more store migrations, run like the real ones. */
  extraTracks?: readonly PgTrack[];
}

const OPTIONS = {
  'admin-secret-arn': { type: 'string' },
  'admin-user-field': { type: 'string' },
  'admin-password-field': { type: 'string' },
  'admin-password-file': { type: 'string' },
  'admin-password-env': { type: 'string' },
  'admin-iam': { type: 'boolean' },
  'admin-user': { type: 'string' },
  region: { type: 'string' },
  'app-password-file': { type: 'string' },
  'maintenance-db': { type: 'string' }
} as const;

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  let v: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; strict: true }>>['values'];
  try {
    v = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    // parseArgs quotes the offending argument, which may be a value.
    throw new UsageError(`invalid arguments (${(e as { code?: string }).code ?? 'error'})`);
  }
  const arn = v['admin-secret-arn'] || undefined;
  const file = v['admin-password-file'] || undefined;
  const envName = v['admin-password-env'] || undefined;
  const iam = v['admin-iam'] === true;
  if ([arn, file, envName, iam || undefined].filter((x) => x !== undefined).length !== 1) {
    throw new UsageError('pass exactly one of --admin-secret-arn, --admin-password-file, --admin-password-env, --admin-iam');
  }
  if (!arn && (v['admin-user-field'] !== undefined || v['admin-password-field'] !== undefined)) {
    throw new UsageError('--admin-user-field and --admin-password-field need --admin-secret-arn');
  }
  if (v.region !== undefined && !arn && !iam) throw new UsageError('--region applies only to --admin-secret-arn and --admin-iam');
  if (envName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new UsageError('--admin-password-env must be an env var name');
  const user = v['admin-user'] || undefined;
  const rest = { appPasswordFile: v['app-password-file'] || undefined, maintenanceDb: v['maintenance-db'] || 'postgres' };
  if (arn) {
    return {
      admin: { kind: 'secret', arn, userField: v['admin-user-field'] || 'username', passwordField: v['admin-password-field'] || 'password', region: v.region, user },
      ...rest
    };
  }
  if (!user) throw new UsageError('--admin-user is required with --admin-password-file, --admin-password-env and --admin-iam');
  if (file) return { admin: { kind: 'file', path: file, user }, ...rest };
  if (envName) return { admin: { kind: 'env', name: envName, user }, ...rest };
  return { admin: { kind: 'aws-rds-iam', user, region: v.region }, ...rest };
}

/** `lists` may grow after creation (tokens minted mid-run). */
export function scrubbingSink(sink: LogSink, lists: readonly (readonly string[])[]): LogSink {
  return (line) => {
    let out = line;
    for (const s of lists.flat()) {
      if (!s) continue;
      for (const form of new Set([s, JSON.stringify(s).slice(1, -1)])) out = out.split(form).join('[redacted]');
    }
    sink(out);
  };
}

async function dbConfig(path: string): Promise<PostgresStoreConfig> {
  const c = await loadHostConfig(path);
  if (!c.db) throw new HostConfigError(`${path} has no db: block`);
  return c.db;
}

/** 0 ok, 1 failed, 2 usage. */
export async function runDbCommand(argv: string[], d: DbCliDeps): Promise<number> {
  const found: string[] = [];
  const lists: (readonly string[])[] = [found];
  const log = createLogger(scrubbingSink(d.sink, lists));
  const cmd = argv[0];
  try {
    const env = readHostEnv(d.env);
    if (cmd === 'bootstrap') {
      const args = parseBootstrapArgs(argv.slice(1));
      const cfg = await dbConfig(env.configPath);
      const target = bootstrapTarget(cfg, d.env, args.appPasswordFile);
      let src = args.admin;
      const c = cfg.connection;
      if (src.kind === 'aws-rds-iam' && !src.region && 'password' in c && c.password.kind === 'aws-rds-iam') src = { ...src, region: c.password.region };
      const admin = await resolveAdminCredential(src, { env: d.env, getSecret: d.getSecret ?? awsGetSecret, target });
      lists.push(admin.secrets);
      const changed = await bootstrap(target, admin, { log, maintenanceDb: args.maintenanceDb, onSecret: (s) => found.push(s) });
      log.log('info', changed.length ? 'bootstrap complete' : 'bootstrap complete: already in place, nothing changed', {
        database: target.database, role: target.user, schema: target.schema, changed
      });
      return 0;
    }
    if (cmd === 'migrate') {
      if (argv.length > 1) throw new UsageError('migrate takes no arguments');
      const cfg = await dbConfig(env.configPath);
      const versions = await migrateHostStore(cfg, { env: d.env, log, extraTracks: d.extraTracks });
      log.log('info', 'migrate complete', { schema: cfg.schema, versions });
      return 0;
    }
    throw new UsageError('unknown command');
  } catch (err) {
    const usage = err instanceof UsageError;
    log.log('error', `${cmd ?? 'fleet-host'} failed`, { error: (err as Error).message, ...(usage ? { usage: USAGE } : {}) });
    return usage ? 2 : 1;
  }
}
```

- [ ] **Step 4: `cli.ts` dispatch.** Replace the `cli()` function:

File: `src/host/cli.ts` (edit)
```ts
async function cli(argv: string[]): Promise<void> {
  if (argv[0] === 'init') {
    process.stdout.write(JSON.stringify({ workspaceId: await init() }) + '\n');
    return;
  }
  if (argv.length > 0) {
    const code = await runDbCommand(argv, { env: process.env, sink: (l) => process.stdout.write(l + '\n') });
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    process.exit(code);
  }
  await runHost();
}
```
Add `import { runDbCommand } from './dbCli.js';`. Update the header comment to `// Bundle entry: the host, or a one-shot \`init\` / \`bootstrap\` / \`migrate\`.` An unknown argument goes to `runDbCommand`, which exits 2 rather than starting a host inside a Job.

- [ ] **Step 5: end-to-end pg tests.** Append to `src/host/bootstrap.pg.test.ts` (and add the imports `EventEmitter`, `mkdtempSync`/`writeFileSync`, `tmpdir`, `join`, `createServer`/`AddressInfo`, `vi`, `runDbCommand`, `runHost`, `fakeBroker`/`person`/`TOKEN`, `IdentityError`, `* as db`):

File: `src/host/bootstrap.pg.test.ts` (append)
```ts
const ARN = 'arn:aws:secretsmanager:us-east-1:567639518918:secret:fleet-agent-infra-use1-rds--connection-string-glXLj2';

function hostConfig(n: ReturnType<typeof names>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-boot-'));
  const path = join(dir, 'config.yaml');
  const dbBlock = { host: HOST, port: PORT, database: n.db, user: n.app, password: { kind: 'env', name: 'FB_APP_PW' }, ssl: 'disable', poolMax: 2 };
  writeFileSync(path, `workspace: { id: 01JC0000000000000000000000, name: boot }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${JSON.stringify(dbBlock)}\n`);
  return path;
}

async function cmd(argv: string[], env: NodeJS.ProcessEnv, getSecret?: (a: string, r: string) => Promise<string>) {
  const lines: string[] = [];
  const code = await runDbCommand(argv, { env, sink: (l) => lines.push(l), getSecret });
  return { code, out: lines.join('\n'), last: JSON.parse(lines.at(-1) as string) as Record<string, unknown> };
}

describe.skipIf(!isPg)('fleet-host bootstrap / migrate (CLI)', () => {
  it('bootstrap via the secret ARN (DB_USER/DB_PASSWORD), again via env; then the app role migrates and runs the host', async () => {
    const n = names();
    const cfg = hostConfig(n);
    const env = { FLEET_HOST_CONFIG: cfg, FB_APP_PW: n.appPw };
    const secret = JSON.stringify({ DB_USER: SUPER, DB_PASSWORD: SUPER_PW });
    const first = await cmd(['bootstrap', '--admin-secret-arn', ARN, '--admin-user-field', 'DB_USER', '--admin-password-field', 'DB_PASSWORD'], env, async () => secret);
    expect(first.code).toBe(0);
    expect(first.last).toMatchObject({ msg: 'bootstrap complete', database: n.db, role: n.app, schema: 'fleet' });
    expect((first.last.changed as string[]).length).toBe(5);
    expect(first.out).not.toContain(n.appPw);
    if (url?.password) expect(first.out).not.toContain(SUPER_PW);

    const again = await cmd(['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], { ...env, FB_ADMIN_PW: SUPER_PW });
    expect(again.code).toBe(0);
    expect(again.last).toMatchObject({ msg: 'bootstrap complete: already in place, nothing changed', changed: [] });
    expect(again.out.split('\n')).toHaveLength(1);

    const mig = await cmd(['migrate'], env);
    expect(mig.code).toBe(0);
    expect(mig.last).toMatchObject({ msg: 'migrate complete', versions: { host: expect.any(Number), inbox: expect.any(Number), state: expect.any(Number) } });
    expect((await cmd(['migrate'], env)).last.versions).toEqual(mig.last.versions);

    const app = await client(n.app, n.appPw, n.db);
    try {
      await expect(app.query(`CREATE DATABASE ${id(`${n.db}_x`)}`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`CREATE ROLE ${id(`${n.app}_x`)}`)).rejects.toMatchObject({ code: '42501' });
      expect((await app.query('SELECT current_schema() AS s')).rows[0].s).toBe('fleet');
    } finally {
      await app.end();
    }

    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'fh-boot-host-'));
    const host = await runHost({
      env: { ...env, FLEET_HOST_PORT: String(port), FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), FLEET_HOST_PROJECTS: join(dir, 'projects') },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined,
      authFactory: () => ({ id: 'github', verify: async (t) => { if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad', 401); return person('owner', 1, ['acme/platform']); } }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000
    });
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/leader`)).status).toBe(200), { timeout: 10_000 });
      await vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });
    } finally {
      await host.shutdown(0);
    }
  });

  it('missing or wrong admin credentials fail cleanly and echo nothing', async () => {
    const n = names();
    const env = { FLEET_HOST_CONFIG: hostConfig(n), FB_APP_PW: n.appPw };
    const bad = 'Wr0ng-Admin-Secret';
    const cases: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], env, /FB_ADMIN_PW is not set/],
      [['bootstrap', '--admin-password-file', '/nonexistent/pw', '--admin-user', SUPER], env, /cannot read --admin-password-file: ENOENT/],
      [['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', n.admin], { ...env, FB_ADMIN_PW: bad }, /admin login to database "postgres"/]
    ];
    if (await passwordsChecked()) cases.push([['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], { ...env, FB_ADMIN_PW: bad }, /28P01/]);
    for (const [argv, e, re] of cases) {
      const r = await cmd(argv, e);
      expect(r.code).toBe(1);
      expect(String(r.last.error)).toMatch(re);
      expect(r.out).not.toContain(bad);
      expect(r.out).not.toContain(n.appPw);
    }
    expect(await su(async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [n.db])).rowCount)).toBe(0);
  });
});

async function passwordsChecked(): Promise<boolean> {
  try {
    await (await client(SUPER, `${SUPER_PW}-wrong`)).end();
    return false;
  } catch {
    return true;
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
```

- [ ] **Step 6:** run `npx vitest run src/host/dbCli.test.ts src/host/importGraph.test.ts` and the pg file, expecting PASS. Mutation-check the no-secret tests:
  1. `throw` the `JSON.parse` error instead of swallowing it. The malformed-secret tests must fail.
  2. Make `scrubbingSink` pass lines through. The scrub test must fail.
  3. Drop the `parseArgs` message rewrite. The unknown-flag test must fail.

  Revert each.
- [ ] **Step 7:** commit `feat(host): fleet-host bootstrap and migrate subcommands`.

---

### Task 6: SPEC and bundle

**Files:** Modify `docs/SPEC.md` §*Remote host*, under *Host store*.

- [ ] **Step 1:** Edit SPEC. The *Host store* bullet "the schema and pgvector must exist, the store never creates them" gains "(`fleet-host bootstrap` creates them)". Add a **Bootstrap and migrate** paragraph covering:
  - the flags;
  - the steps and their order;
  - idempotence, with the second-run message;
  - the SCRAM verifier;
  - the PG16 temporary SET grant;
  - secret scrubbing;
  - exit codes 0/1/2;
  - that `migrate` runs `openHostDb` and then `migratePgStores` unfenced under the advisory lock;
  - that startup migration stays.
- [ ] **Step 2:** `npm run build:host` and check that `out/host/fleet-host.mjs` reaches `runDbCommand` (`grep -l "admin-secret-arn" out/host -r`). Also check that the Secrets Manager client is bundled into a chunk (`grep -rl GetSecretValueCommand out/host`).
- [ ] **Step 3:** all gates (see Global Constraints).
- [ ] **Step 4:** commit `docs(spec): fleet-host bootstrap and migrate`.
