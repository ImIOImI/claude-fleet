# Remote workspaces (c1): `fleet-host` and the transport endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `fleet-host`, the headless Node process that serves one remote workspace from inside its container: `/healthz`, `/leader`, `/whoami`, `/rpc/<channel>`, `/attach` (viewer fan-out over the broker) and `/events`, with identity verified on every request and tiers checked per route and per frame. Also ship the `runner-host` and `runner-devops-host` images that run it beside the broker.

**Architecture:** `src/host/` is a new, Electron-free entry point bundled by Vite into one `fleet-host.mjs`. It reuses the shipped identity layer (`parseGrantConfig`, `resolveTier`, `createGithubProvider`, `withVerifyCache`) and the broker frame codec from `src/main/broker.ts`. An `AuthContext` (provider plus verify cache plus grants) is built from one config snapshot and swapped whole on every reload. The `/attach` WebSocket carries broker frames. The host terminates each frame, checks its tier and relays it through a single upstream broker attachment per session, fanning output out to every viewer. A fenced `LeaseManager` sits behind a `LeaseStore` seam. c1 ships a process-local store, and c3 plugs Postgres in.

**Tech Stack:** TypeScript (NodeNext for `src/host`), Node 22, `ws@8`, `yaml`, `ulid`, vitest, Vite SSR build, bash + tini, GitHub Actions buildx.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §3 *Remote host*, §5 *Identity and auth*, §6 *Transport*, §9, §11 item (c), §12 (c). `/shared/remote-agent-design/design-state.md` (the fleet-host deployment contract). GitHub issue #479.

**This is part 1 of 3.**
- **c1 (this plan):** fleet-host, the endpoint, the lease seam, and the host images.
  - *Ships:* a deployable `runner-host` image that answers probes on 8080, authenticates every caller with GitHub, and lets granted people watch, steer and start sessions over `/attach`. Any WebSocket client works for that. The desktop UI arrives in c2.
- **c2** (`2026-11-04-remote-c-2-desktop.md`): `kind: 'remote'`, `RemoteClient`, add-remote UX, the chip, watch-only tabs, and the unreachable banner.
  - *Ships:* attach to and work in a remote workspace from the app.
  - Needs c1 merged; c2's tests start c1's server.
- **c3** (`2026-11-04-remote-c-3-host-store.md`): Postgres on the host, the fenced lease row, ingest, the scheduler, store-backed RPC and events, MCP on the host, and the GitHub App credential helper.
  - *Ships:* remote automations run on the host, and the host's history is served over RPC.
  - Gated on async-store part 3, and on part 4's password provider.

## Global Constraints

Copied from the spec and design-state. Every task implicitly includes these.

- **Deployment contract** (design-state, told to the Work workspace on 2026-11-03), verbatim:
  - "port `8080` (`FLEET_HOST_PORT`); uid/gid 1000 (`fleet`); host config at `/etc/fleet-host/config.yaml` (`FLEET_HOST_CONFIG`), mounted read-only from a ConfigMap and hot-reloaded; grants are GitHub team → tier."
- **Auth on every request** (spec §6), verbatim:
  - "Every request carries `Authorization: Bearer <GitHub token>`. WebSockets send it on upgrade."
  - `/healthz` and `/leader` are "Unauthenticated".
  - "Results are cached per token for 5 minutes, so revoking a token or removing someone from a team takes effect within that window." (§5)
  - "A person's tier is the highest tier any matching rule grants. No match means 403. Grants are deployment config, not editable from the desktop." (§5)
- **Per-route and per-frame tiers** (§6), verbatim:
  - "RPC channels are allowlisted with a tier. Unlisted channels (vault, filesystem, config, image or Docker channels) don't exist on the host."
  - "`ATTACH`, `HISTORY`, `LIST` and `LISTPORTS` need `read`; `INPUT`, `RESIZE`, `KILLPORT` and `DIAL` need `steer`; `CREATE` and `CLOSE` need `session`. A `session`-tier user may `CLOSE` only sessions they own; `steer` and above can't close other people's sessions."
  - "The broker allows one writer per session. `fleet-host` holds that single attachment and fans `OUTPUT` out to every viewer. It accepts `INPUT` from any `steer` viewer. A newcomer gets `HISTORY` replay, as on a desktop reattach."
- **Lease** (§3), verbatim:
  - "renews it every 10 s with a 30 s TTL"
  - "Until it holds the lease, the process is **standby**. It runs no scheduler or ingest, serves no RPC or attach, and creates no broker sessions."
  - "**Readiness is not lease state.** The pod is *ready* when the process is healthy (DB reachable, lease loop running), whether it's holder or standby."
  - "**On SIGTERM the holder releases the lease.**"
- **Credentials** (§3): "No person's credentials ever enter the container." The bearer token is verified and never stored, logged or echoed in an error body.
- **TLS** (§6): "Plain `http://` host URLs are **allowed** for now". The design-state adds: "In-pod TLS: not needed for now."
- **Images** (§3): "`tini` supervises both the broker and `fleet-host`." Organisations extend the image `FROM <pinned digest>`.
- **Repo rules:**
  - Comments are terse and necessary (`/workspace/.claude/rules/review-conventions.md`).
  - SPEC.md is updated in the same PR (Task 11).
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Environment:**
  - Never `npm install` into `/workspace/claude-fleet/node_modules`. Work in your own worktree:
    - `npm ci --ignore-scripts --no-audit --no-fund`
    - then `printf 'electron-stub' > node_modules/electron/path.txt`
  - Typecheck the three configs separately: `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, and `npx tsc -p tsconfig.host.json` (which has `noEmit` set).
  - Inside a claude-fleet container, unset `CLAUDE_FLEET_BROKER_TCP_PORT` before running a broker locally. Otherwise it binds `0.0.0.0:7070` and fails.

## Decisions (not settled by the spec; recorded in SPEC.md by Task 11)

- **D1 — Three plans.** The work splits into (c1) host, (c2) desktop and (c3) host store, with the "ships" lines above. c1 and c2 depend on nothing unshipped. c3 is gated on the async store's Postgres dialect (part 3) and its password provider (part 4).
- **D2 — No SQLite on the host; c1 has no DB.**
  - The spec forbids a SQLite host store:
    - "`fleet-host` uses the same store layer, always on Postgres" (§7);
    - "The DB is not on shared file storage" (§3).
  - So c1 needs no DB:
    - The lease goes through a `LeaseStore` seam. c1 uses a process-local `memoryLeaseStore()`, which is correct only for one replica.
    - The workspace ULID is minted once into `$FLEET_HOST_STATE/workspace-id.json` on the shared volume. `link()` makes create-if-absent atomic across pods.
    - c3 adds `postgresLeaseStore` and adopts the file's id into `host_meta`, so the id never changes.
  - c1 runs no scheduler and no ingest, so an overlap of two pods can't fire anything twice. It can only split viewers between pods for the overlap window.
- **D3 — `ws@8` on both ends.**
  - Node has no WebSocket server.
  - The standard `WebSocket` client can't set `Authorization` on the upgrade, and the spec requires the bearer header there.
- **D4 — How `/attach` relays frames.**
  - Each binary WebSocket message carries broker frames. Frames may span messages.
  - Channel numbers are per viewer connection.
  - The host keeps one upstream broker connection per attached session.
  - Newcomers get a 64 KiB replay buffer, the same size as the broker's ring, trimmed with the broker's `trimToSafeStart` rule.
  - The last viewer leaving detaches the upstream and leaves the session alive.
- **D5 — The host rebuilds `CREATE` args.** It accepts only the `claudeCreateArgs` shape: optional `--settings <hooks>`, then `--resume <uuid>` or `--session-id <uuid>`. Anything else is refused, so a viewer can't append claude flags such as `--mcp-config`.
- **D6 — Who owns a session, for `CLOSE`.**
  - The owner is an in-memory map, `broker session id → "<provider>:<account id>"`, set on a successful `CREATE`.
  - A session the process didn't create can't be closed by any viewer. That covers automation sessions and sessions created before a restart.
  - PTYs die with the container, so the map can't outlive its sessions. (f) persists `session_owners`.
- **D7 — `DIAL` is gated at `steer`, then refused** ("port forwarding is not available on remote hosts"). Port preview over a remote host is out of scope for (c).
- **D8 — Long-lived sockets are re-verified every 60 s and on every config reload.**
  - A lowered tier applies to the next frame.
  - A revoked token closes the socket with 4401; a removed grant closes it with 4403.
- **D9 — A standby answers 503 `{"error":"standby"}`** on every authenticated route (`/whoami`, `/rpc`, `/attach`, `/events`).
- **D10 — The RPC body is `{"args":[...]}`**, mirroring `ipcRenderer.invoke`.
  - The reply is `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.
  - Status codes: 404 for an unlisted channel, 403 for too low a tier, 400 for bad args, 500 for a redacted handler error.
  - c1 channels:
    - `sessions:live` (read; broker `LIST`), added because the desktop's "Join…" needs it and no IPC name exists;
    - `ports:list` (read);
    - `ports:kill` (steer).
- **D11 — c1 publishes only `sessions:changed` and `ports:changed`.** The broker is polled every 2 s, and only while the host holds the lease and something subscribes. The other event channels are allowlisted now and published from c3.
- **D12 — The workspace's display fields come from the host config:** `workspace: { name, description?, color?: { hue } }` (`name` is required). The id is minted (D2).
- **D13 — Supervision.**
  - `tini` runs `/usr/local/bin/fleet-host-entry`, which starts the broker and fleet-host side by side. If either exits, the container exits.
  - SIGTERM goes to fleet-host first, so it releases the lease, and then to the broker.
- **D14 — One bundled file.** `vite build --config vite.host.config.ts` emits a self-contained `out/host/fleet-host.mjs`, so the image has no `node_modules`. An import-graph test pins the host's packages to `ws`, `yaml` and `ulid`, plus the pure `src/main` modules it reuses.
- **D15 — #479:**
  - Reload rebuilds the provider and the verify cache together (`buildAuthContext`), so no cached `MachineIdentity` outlives a rule change.
  - The host parses its own `identity: { provider, org }`. These plans add no desktop `identity.*` key, so `parseIdentityConfig` is unchanged.
  - An installation with more than 1000 repositories is now refused with its `total_count` in the message.
- **D16 — `fleet-host init`** prints `{"workspaceId": …}`. This is spec §13 Q1's recommendation, minus the URL: the pod can't know its external address.
- **D17 — PTY size follows the most recent `steer` viewer's `RESIZE`.** This is §13 Q2's recommendation. The "sized for @login" hint is deferred.
- **D18 — The GitHub App credential helper (§3) moves to c3.** It isn't gated there. In c1, sessions use whatever credentials the deployment's env provides.

## File Structure

| File | Responsibility |
|---|---|
| `tsconfig.host.json` (new) | NodeNext typecheck of `src/host/**` (the shipped graph). |
| `vite.host.config.ts` (new) | Bundles `src/host/cli.ts` into `out/host/fleet-host.mjs`. |
| `src/host/config.ts` | Host config YAML and the env contract. |
| `src/host/log.ts` | JSON-line logger; every string is redacted. |
| `src/host/auth.ts` | `AuthContext` (provider + cache + grants) and `authenticate()`. |
| `src/host/lease.ts` | `LeaseStore` seam, `memoryLeaseStore`, `LeaseManager`. |
| `src/host/hostState.ts` | Mint or read the workspace ULID. |
| `src/host/frameGate.ts` | Frame → tier table, response map, CREATE-args rebuild. |
| `src/host/brokerOps.ts` | The host's broker access (one upstream per session). |
| `src/host/attachHub.ts` | Viewer fan-out, replay, per-frame gating, CLOSE ownership. |
| `src/host/rpc.ts` | RPC registry, dispatch, broker-backed channels. |
| `src/host/events.ts` | `/events` hub and broker polling. |
| `src/host/server.ts` | HTTP + WebSocket endpoint, standby gate, re-verify. |
| `src/host/configReload.ts` | Serialized reload; ConfigMap directory watch. |
| `src/host/main.ts`, `src/host/cli.ts` | Wiring, signals, `init`. |
| `src/host/testFakes.ts` | Test doubles, imported only by tests. |
| `src/main/broker.ts` | Export the frame codec (no behaviour change). |
| `src/main/identity/githubProvider.ts` | #479 `total_count` message. |
| `docker/host/Dockerfile`, `docker/host/fleet-host-entry`, `docker/host/smoke.test.sh` (new) | The host image layer. |
| `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/build-app.yml`, `package.json`, `tsconfig.node.json` | Build and CI. |

---

### Task 1: Host scaffold and config

**Files:**
- Create: `tsconfig.host.json`, `src/host/config.ts`, `src/host/config.test.ts`
- Modify: `package.json`, `tsconfig.node.json`

**Interfaces:**
- Produces:
  - `parseHostConfig(raw: unknown): HostConfig`
  - `loadHostConfig(path: string): Promise<HostConfig>`
  - `readHostEnv(env): HostEnv`
  - `HostConfigError`
  - `HostConfig = { workspace: HostWorkspaceInfo; identity: { provider: 'github'; org: string | null }; grants: GrantConfig }`
  - `HostWorkspaceInfo = { name: string; description: string | null; color: { hue: number } | null }`
  - `HostEnv = { port; configPath; stateDir; brokerSocket }`
  - `DEFAULT_CONFIG_PATH`, `DEFAULT_PORT`

- [ ] **Step 1: Add the dependencies and scripts**

```bash
W=<your worktree>
npm --prefix "$W" install --ignore-scripts --no-audit --no-fund ws@^8.18.3
npm --prefix "$W" install --ignore-scripts --no-audit --no-fund -D @types/ws@^8.18.1
```

In `package.json` `scripts`:
- replace `"typecheck": "npm run typecheck:node && npm run typecheck:web",`
- add `typecheck:host` and `build:host`:

```json
    "typecheck:host": "tsc -p tsconfig.host.json",
    "typecheck": "npm run typecheck:node && npm run typecheck:web && npm run typecheck:host",
    "build:host": "vite build --config vite.host.config.ts",
```

Create `tsconfig.host.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/host/**/*.ts"]
}
```

In `tsconfig.node.json` `include`, add `"src/host/**/*.ts",` after `"src/main/**/*.ts",`. c2's main-process tests import the host server, so the node config must see it too.

- [ ] **Step 2: Write the failing test** — `src/host/config.test.ts`:

```ts
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
    expect(c.workspace).toEqual({ name: 'review-bot', description: 'PR reviewer', color: { hue: 210 } });
    expect(c.identity).toEqual({ provider: 'github', org: 'acme' });
    expect(c.grants.grants).toEqual([{ team: 'acme/platform', tier: 'session' }]);
    expect(c.grants.machines[0]).toMatchObject({ appId: 123456, org: 'acme', tier: 'steer' });
  });

  it('defaults description and color to null', () => {
    const c = parseHostConfig({ workspace: { name: 'w' } });
    expect(c.workspace).toEqual({ name: 'w', description: null, color: null });
    expect(c.grants).toEqual({ grants: [], machines: [] });
  });

  it.each([
    [{ ...base, workspace: undefined }, /workspace must be an object/],
    [{ ...base, workspace: { name: ' ' } }, /workspace.name/],
    [{ ...base, workspace: { name: 'w', color: { hue: 400 } } }, /hue/],
    [{ ...base, identity: { provider: 'oidc' } }, /identity.provider/],
    [{ ...base, grants: [{ team: 'acme/x', tier: 'admin' }] }, /tier must be one of/]
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/host/config.test.ts`
Expected: FAIL, `Failed to resolve import "./config.js"`.

- [ ] **Step 4: Implement** — `src/host/config.ts`:

```ts
// fleet-host deployment config (/etc/fleet-host/config.yaml). Read at start and
// on every reload; grants are validated by the shared identity layer.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { parseGrantConfig, type GrantConfig } from '../main/identity/grants.js';

export const DEFAULT_CONFIG_PATH = '/etc/fleet-host/config.yaml';
export const DEFAULT_PORT = 8080;

export interface HostWorkspaceInfo {
  name: string;
  description: string | null;
  color: { hue: number } | null;
}

export interface HostConfig {
  workspace: HostWorkspaceInfo;
  identity: { provider: 'github'; org: string | null };
  grants: GrantConfig;
}

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostConfigError(`${path} must be an object`);
  return v as Record<string, unknown>;
}

function parseWorkspace(v: unknown): HostWorkspaceInfo {
  const w = record(v, 'workspace');
  if (typeof w.name !== 'string' || !w.name.trim() || w.name.length > 64) {
    throw new HostConfigError('workspace.name must be a non-empty string of at most 64 characters');
  }
  if (w.description !== undefined && typeof w.description !== 'string') {
    throw new HostConfigError('workspace.description must be a string');
  }
  let color: { hue: number } | null = null;
  if (w.color !== undefined) {
    const hue = record(w.color, 'workspace.color').hue;
    if (typeof hue !== 'number' || !Number.isFinite(hue) || hue < 0 || hue >= 360) {
      throw new HostConfigError('workspace.color.hue must be a number in [0, 360)');
    }
    color = { hue };
  }
  return { name: w.name.trim(), description: typeof w.description === 'string' ? w.description : null, color };
}

export function parseHostConfig(raw: unknown): HostConfig {
  const o = record(raw, 'host config');
  const id = o.identity === undefined ? {} : record(o.identity, 'identity');
  if (id.provider !== undefined && id.provider !== 'github') {
    throw new HostConfigError('identity.provider must be github');
  }
  if (id.org !== undefined && typeof id.org !== 'string') throw new HostConfigError('identity.org must be a string');
  let grants: GrantConfig;
  try {
    grants = parseGrantConfig(o);
  } catch (err) {
    throw new HostConfigError((err as Error).message);
  }
  return {
    workspace: parseWorkspace(o.workspace),
    identity: { provider: 'github', org: typeof id.org === 'string' ? id.org : null },
    grants
  };
}

export async function loadHostConfig(path: string): Promise<HostConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new HostConfigError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new HostConfigError(`${path} is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  return parseHostConfig(raw);
}

export interface HostEnv {
  port: number;
  configPath: string;
  stateDir: string;
  brokerSocket: string;
}

export function readHostEnv(env: NodeJS.ProcessEnv): HostEnv {
  const portText = env.FLEET_HOST_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostConfigError(`FLEET_HOST_PORT ${portText} is not a port`);
  return {
    port,
    configPath: env.FLEET_HOST_CONFIG || DEFAULT_CONFIG_PATH,
    stateDir: env.FLEET_HOST_STATE || '/home/fleet/.claude/fleet-host',
    brokerSocket: env.CLAUDE_FLEET_BROKER_SOCKET || '/run/broker/broker.sock'
  };
}
```

- [ ] **Step 5: Run the tests and the typechecks**

Run: `npx vitest run src/host/config.test.ts && npx tsc -p tsconfig.host.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS (11 tests), then no tsc output.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.host.json tsconfig.node.json src/host/config.ts src/host/config.test.ts
git commit -m "feat(host): fleet-host config and env contract

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Identity on every request (auth, redacting logger, #479)

**Files:**
- Create: `src/host/log.ts`, `src/host/log.test.ts`, `src/host/auth.ts`, `src/host/auth.test.ts`
- Modify: `src/main/identity/githubProvider.ts` (in `assertInstallationInOrg`), `src/main/identity/githubProvider.test.ts`

**Interfaces:**
- Consumes:
  - `HostConfig` (Task 1);
  - `createGithubProvider`, `withVerifyCache`, `resolveTier`, `IdentityError` (shipped).
- Produces:
  - `redactSecrets(s): string`
  - `createLogger(sink?, now?): Logger`, where `Logger.log(level, msg, fields?)`
  - `AuthContext { provider; grants }`
  - `buildAuthContext(config, factory?): AuthContext`
  - `ProviderFactory = (machines: readonly MachineRule[]) => IdentityProvider`
  - `bearerToken(header): string | null`
  - `authenticate(header, ctx): Promise<AuthResult>`
  - `AuthResult = { ok: true; identity; tier } | { ok: false; status: 401|403|502|503; error }`

- [ ] **Step 1: Write the failing tests**

`src/host/log.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLogger, redactSecrets } from './log.js';

const GHO = 'gho_' + 'a'.repeat(36);

describe('redactSecrets', () => {
  it.each([
    `Authorization: Bearer ${GHO}`,
    `token=${GHO}`,
    'ghp_' + 'b'.repeat(36),
    'ghs_' + 'c'.repeat(36),
    'github_pat_' + 'd'.repeat(40),
    'sk-ant-api03-' + 'e'.repeat(20)
  ])('redacts %s', (s) => {
    expect(redactSecrets(s)).toContain('[redacted]');
    expect(redactSecrets(s)).not.toMatch(/[a-e]{16}/);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('GET /whoami 200 @alice')).toBe('GET /whoami 200 @alice');
  });
});

describe('createLogger', () => {
  it('redacts the message and every string field', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('warn', `failed with ${GHO}`, { error: `Bearer ${GHO}`, n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(GHO);
    expect(JSON.parse(lines[0])).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'warn', msg: 'failed with [redacted]', error: '[redacted]', n: 1 });
  });
});
```

`src/host/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { authenticate, bearerToken, buildAuthContext, type AuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';

const TOKEN = 'gho_' + 'A'.repeat(36);

const alice: Identity = {
  provider: 'github', kind: 'user', login: 'alice', id: 1, name: 'Alice', avatarUrl: null, teams: ['acme/platform']
};

function ctxWith(verify: IdentityProvider['verify'], grants = [{ team: 'acme/platform', tier: 'steer' }]): AuthContext {
  const config = parseHostConfig({ workspace: { name: 'w' }, grants });
  return buildAuthContext(config, () => ({ id: 'github', verify }));
}

describe('bearerToken', () => {
  it('accepts only "Bearer <token>"', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull();
    expect(bearerToken(`token ${TOKEN}`)).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('authenticate', () => {
  it('resolves the tier from the grant config', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => alice));
    expect(r).toEqual({ ok: true, identity: alice, tier: 'steer' });
  });

  it('401s with no token and never calls the provider', async () => {
    const verify = vi.fn(async () => alice);
    expect(await authenticate(undefined, ctxWith(verify))).toMatchObject({ ok: false, status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });

  it('403s a verified identity with no matching grant', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => ({ ...alice, teams: ['acme/other'] })));
    expect(r).toEqual({ ok: false, status: 403, error: 'no grant for @alice' });
  });

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['machine-unknown', 403],
    ['network', 503],
    ['upstream', 502]
  ] as const)('maps IdentityError %s to %d', async (kind, status) => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async () => { throw new IdentityError(kind, 'nope'); }));
    expect(r).toMatchObject({ ok: false, status });
  });

  it('never echoes a non-IdentityError message (it may carry the token)', async () => {
    const r = await authenticate(`Bearer ${TOKEN}`, ctxWith(async (t) => { throw new Error(`fetch failed for ${t}`); }));
    expect(r).toEqual({ ok: false, status: 502, error: 'identity check failed' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('caches verification per context, and a new context re-verifies', async () => {
    const verify = vi.fn(async () => alice);
    const config = parseHostConfig({ workspace: { name: 'w' }, grants: [{ login: 'alice', tier: 'read' }] });
    const factory = () => ({ id: 'github', verify });
    const a = buildAuthContext(config, factory);
    await authenticate(`Bearer ${TOKEN}`, a);
    await authenticate(`Bearer ${TOKEN}`, a);
    expect(verify).toHaveBeenCalledTimes(1);
    await authenticate(`Bearer ${TOKEN}`, buildAuthContext(config, factory));
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

describe('config reload (#479)', () => {
  it('a new AuthContext re-proves a machine against the new rule, never reusing the old cache', async () => {
    const machine: Identity = { provider: 'github', kind: 'machine', appId: 123456, login: 'acme-reviewer[bot]', id: 9, name: null, avatarUrl: null, teams: [] };
    const seen: string[][] = [];
    const factory = (machines: readonly { org: string }[]) => {
      seen.push(machines.map((m) => m.org));
      return { id: 'github', verify: vi.fn(async () => machine) };
    };
    const cfg = (org: string) =>
      parseHostConfig({ workspace: { name: 'w' }, machines: [{ appId: 123456, login: 'acme-reviewer[bot]', org, tier: 'steer' }] });
    const before = buildAuthContext(cfg('acme'), factory);
    await authenticate(`Bearer ${TOKEN}`, before);
    const after = buildAuthContext(cfg('other-org'), factory);
    await authenticate(`Bearer ${TOKEN}`, after);
    expect(seen).toEqual([['acme'], ['other-org']]);
    expect(after.provider).not.toBe(before.provider);
  });
});
```

In `src/main/identity/githubProvider.test.ts`, inside `describe('installation must belong to the rule\'s org', …)`, insert before `it('refuses an installation with one foreign repo', …)`:

```ts
    it('refuses an installation larger than the org check covers, saying how large', async () => {
      const f = stubGithub({ ...base, [`GET ${INSTALL_REPOS}`]: () => json({ ...repos('acme'), total_count: 1500 }) });
      const err = await createGithubProvider({ machines: MACHINES }).verify(TOKEN).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'forbidden', message: expect.stringContaining('reaches 1500 repositories; the org check covers at most 1000') });
      expect(f.mock.calls.filter(([u]) => String(u).startsWith(INSTALL_REPOS))).toHaveLength(1);
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/host/log.test.ts src/host/auth.test.ts src/main/identity/githubProvider.test.ts`
Expected:
- the host files fail to resolve `./log.js` and `./auth.js`;
- the provider test fails, because without the check the installation is accepted.

- [ ] **Step 3: Implement**

`src/host/log.ts`:

```ts
// One JSON line per event on stdout. Every string field passes through
// redactSecrets, and nothing logs request headers.

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9_.~+/=-]+/gi,
  /\bgh[opsu]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(l + '\n'), now: () => number = Date.now): Logger {
  return {
    log(level, msg, fields = {}) {
      const rec: Record<string, unknown> = { ts: new Date(now()).toISOString(), level, msg: redactSecrets(msg) };
      for (const [k, v] of Object.entries(fields)) rec[k] = typeof v === 'string' ? redactSecrets(v) : v;
      sink(JSON.stringify(rec));
    }
  };
}
```

`src/host/auth.ts`:

```ts
// Per-request identity: Bearer token → verified Identity → tier. The provider
// and its verify cache are built together from one config snapshot, so a
// reload never pairs a new grant list with identities cached under the old
// one (#479).
import { createGithubProvider } from '../main/identity/githubProvider.js';
import { resolveTier, type GrantConfig, type MachineRule, type Tier } from '../main/identity/grants.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';
import { withVerifyCache } from '../main/identity/verifyCache.js';
import type { HostConfig } from './config.js';

export interface AuthContext {
  readonly provider: IdentityProvider;
  readonly grants: GrantConfig;
}

export type ProviderFactory = (machines: readonly MachineRule[]) => IdentityProvider;

export const githubProviderFactory: ProviderFactory = (machines) => createGithubProvider({ machines });

export function buildAuthContext(config: HostConfig, factory: ProviderFactory = githubProviderFactory): AuthContext {
  return { provider: withVerifyCache(factory(config.grants.machines)), grants: config.grants };
}

export type AuthResult =
  | { ok: true; identity: Identity; tier: Tier }
  | { ok: false; status: 401 | 403 | 502 | 503; error: string };

const BEARER_RE = /^Bearer ([A-Za-z0-9_.~+/=-]{1,4096})$/;

export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = BEARER_RE.exec(header);
  return m ? m[1] : null;
}

export async function authenticate(header: string | string[] | undefined, ctx: AuthContext): Promise<AuthResult> {
  const token = bearerToken(header);
  if (!token) return { ok: false, status: 401, error: 'missing or malformed bearer token' };
  let identity: Identity;
  try {
    identity = await ctx.provider.verify(token);
  } catch (err) {
    if (!(err instanceof IdentityError)) return { ok: false, status: 502, error: 'identity check failed' };
    switch (err.kind) {
      case 'unauthorized':
        return { ok: false, status: 401, error: 'token rejected by GitHub' };
      case 'forbidden':
      case 'machine-unknown':
        return { ok: false, status: 403, error: err.message };
      case 'network':
        return { ok: false, status: 503, error: 'GitHub unreachable' };
      default:
        return { ok: false, status: 502, error: 'GitHub identity check failed' };
    }
  }
  const tier = resolveTier(identity, ctx.grants);
  if (!tier) return { ok: false, status: 403, error: `no grant for @${identity.login}` };
  return { ok: true, identity, tier };
}
```

In `src/main/identity/githubProvider.ts` `assertInstallationInOrg`, replace:

```ts
    const body = (await readJson(res)) as { repositories?: unknown } | null;
    const list = body?.repositories;
```

with:

```ts
    const body = (await readJson(res)) as { repositories?: unknown; total_count?: unknown } | null;
    const total = body?.total_count;
    if (page === 0 && typeof total === 'number' && total > MAX_REPO_PAGES * 100) {
      throw refuse(`it reaches ${total} repositories; the org check covers at most ${MAX_REPO_PAGES * 100}`);
    }
    const list = body?.repositories;
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/host/log.test.ts src/host/auth.test.ts src/main/identity/githubProvider.test.ts`
Expected: PASS (log 8, auth 12, provider 37).

- [ ] **Step 5: Mutation-check the security properties**

Apply each mutation alone. Run the named test file. Confirm it FAILS, then revert with `git checkout -- <file>`.

| Mutation | File | Test that must fail |
|---|---|---|
| In `authenticate`, replace `error: 'identity check failed'` with `error: (err as Error).message` | `src/host/auth.ts` | `auth.test.ts` "never echoes a non-IdentityError message" |
| Replace `if (!tier) return { ok: false, status: 403, …` with `if (!tier) return { ok: true, identity, tier: 'read' };` | `src/host/auth.ts` | `auth.test.ts` "403s a verified identity with no matching grant" |
| In `buildAuthContext`, cache the provider in a module-level variable and reuse it | `src/host/auth.ts` | `auth.test.ts` "config reload (#479)" |
| In `createLogger`, replace `rec[k] = typeof v === 'string' ? redactSecrets(v) : v;` with `rec[k] = v;` | `src/host/log.ts` | `log.test.ts` "redacts the message and every string field" |

- [ ] **Step 6: Commit**

```bash
git add src/host/log.ts src/host/log.test.ts src/host/auth.ts src/host/auth.test.ts src/main/identity/githubProvider.ts src/main/identity/githubProvider.test.ts
git commit -m "feat(host): per-request GitHub identity, tier resolution and redacting logger

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The fenced lease

**Files:**
- Create: `src/host/lease.ts`, `src/host/lease.test.ts`

**Interfaces:**
- Produces:
  - `LEASE_RENEW_MS = 10_000`, `LEASE_TTL_MS = 30_000`
  - `LeaseStore { tryAcquire(holder, now, ttlMs): Promise<number|null>; renew(holder, epoch, now, ttlMs): Promise<boolean>; release(holder, epoch): Promise<void> }`
  - `memoryLeaseStore(): LeaseStore`
  - `LeaseManager`:
    - constructor options `{ holder, store, now?, renewMs?, ttlMs?, onError? }`;
    - getters `.state: 'standby'|'holder'`, `.epoch`, `.running`;
    - methods `.start()`, `.tick()`, `.stop()` (which releases);
    - events `'acquired'(epoch)` and `'lost'()`.
  - `LeaseState`
- c3 implements `LeaseStore` on the `host_lease` row. Every write transaction also checks `epoch` (spec §3). That check isn't part of this interface.

- [ ] **Step 1: Write the failing test** — `src/host/lease.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('memoryLeaseStore', () => {
  it('admits one holder until expiry, bumping the epoch on each take', async () => {
    const s = memoryLeaseStore();
    expect(await s.tryAcquire('a', 0, 30)).toBe(1);
    expect(await s.tryAcquire('b', 10, 30)).toBeNull();
    expect(await s.tryAcquire('b', 30, 30)).toBe(2);
    expect(await s.renew('a', 1, 31, 30)).toBe(false);
    expect(await s.renew('b', 2, 31, 30)).toBe(true);
  });

  it('release frees the lease only for the current holder and epoch', async () => {
    const s = memoryLeaseStore();
    await s.tryAcquire('a', 0, 30);
    await s.release('a', 99);
    expect(await s.tryAcquire('b', 1, 30)).toBeNull();
    await s.release('a', 1);
    expect(await s.tryAcquire('b', 1, 30)).toBe(2);
  });
});

describe('LeaseManager', () => {
  it('starts standby and becomes holder on the first tick', async () => {
    const c = clock();
    const m = new LeaseManager({ holder: 'a', store: memoryLeaseStore(), now: c.now });
    const acquired = vi.fn();
    m.on('acquired', acquired);
    expect(m.state).toBe('standby');
    await m.tick();
    expect(m.state).toBe('holder');
    expect(acquired).toHaveBeenCalledWith(1);
  });

  it('a second manager stays standby while the first renews', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now });
    const b = new LeaseManager({ holder: 'b', store, now: c.now });
    await a.tick();
    for (let i = 0; i < 5; i++) {
      c.advance(10_000);
      await a.tick();
      await b.tick();
    }
    expect(a.state).toBe('holder');
    expect(b.state).toBe('standby');
  });

  it('takes over within one tick after the holder releases', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now });
    const b = new LeaseManager({ holder: 'b', store, now: c.now });
    await a.tick();
    await a.stop();
    await b.tick();
    expect(b.state).toBe('holder');
    expect(b.epoch).toBe(2);
  });

  it('emits lost and halts when a renew is refused', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now });
    const lost = vi.fn();
    a.on('lost', lost);
    await a.tick();
    c.advance(31_000);
    expect(await store.tryAcquire('b', c.now(), 30_000)).toBe(2);
    await a.tick();
    expect(lost).toHaveBeenCalledOnce();
    expect(a.state).toBe('standby');
    await a.tick();
    expect(a.state).toBe('standby');
  });

  it('survives store errors until its own TTL runs out, then loses', async () => {
    const c = clock();
    const inner = memoryLeaseStore();
    let failing = false;
    const store: LeaseStore = {
      tryAcquire: (...a) => inner.tryAcquire(...a),
      renew: async (...a) => {
        if (failing) throw new Error('db down');
        return inner.renew(...a);
      },
      release: (...a) => inner.release(...a)
    };
    const onError = vi.fn();
    const m = new LeaseManager({ holder: 'a', store, now: c.now, onError });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    failing = true;
    c.advance(10_000);
    await m.tick();
    expect(m.state).toBe('holder');
    c.advance(20_000);
    await m.tick();
    expect(lost).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/host/lease.test.ts`
Expected: FAIL, cannot resolve `./lease.js`.

- [ ] **Step 3: Implement** — `src/host/lease.ts`:

```ts
// Fenced singleton lease (remote-workspaces §3). Standby until acquired; the
// holder renews every 10 s with a 30 s TTL. Losing it is fatal: the caller
// exits so a stale holder never keeps serving.
import { EventEmitter } from 'node:events';

export const LEASE_RENEW_MS = 10_000;
export const LEASE_TTL_MS = 30_000;

export interface LeaseStore {
  /** Take the lease if free or expired; returns the new epoch, or null if another holder has it. */
  tryAcquire(holder: string, now: number, ttlMs: number): Promise<number | null>;
  /** Extend the lease; false when `holder`/`epoch` no longer own it. */
  renew(holder: string, epoch: number, now: number, ttlMs: number): Promise<boolean>;
  /** Clear the holder if `holder`/`epoch` still own it. */
  release(holder: string, epoch: number): Promise<void>;
}

/** Process-local lease: correct only for a single replica (c1). */
export function memoryLeaseStore(): LeaseStore {
  let row = { holder: null as string | null, epoch: 0, expiresAt: 0 };
  return {
    async tryAcquire(holder, now, ttlMs) {
      if (row.holder !== null && row.expiresAt > now) return null;
      row = { holder, epoch: row.epoch + 1, expiresAt: now + ttlMs };
      return row.epoch;
    },
    async renew(holder, epoch, now, ttlMs) {
      if (row.holder !== holder || row.epoch !== epoch) return false;
      row = { ...row, expiresAt: now + ttlMs };
      return true;
    },
    async release(holder, epoch) {
      if (row.holder === holder && row.epoch === epoch) row = { ...row, holder: null, expiresAt: 0 };
    }
  };
}

export type LeaseState = 'standby' | 'holder';

export interface LeaseOptions {
  holder: string;
  store: LeaseStore;
  now?: () => number;
  renewMs?: number;
  ttlMs?: number;
  onError?: (err: Error) => void;
}

/** Events: 'acquired' (epoch), 'lost' (). */
export class LeaseManager extends EventEmitter {
  private _state: LeaseState = 'standby';
  private _epoch = 0;
  private validUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly renewMs: number;
  private readonly ttlMs: number;

  constructor(private readonly opts: LeaseOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.renewMs = opts.renewMs ?? LEASE_RENEW_MS;
    this.ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  }

  get state(): LeaseState {
    return this._state;
  }

  get epoch(): number {
    return this._epoch;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.renewMs);
    void this.tick();
  }

  /** One acquire-or-renew step. Concurrent calls share one in-flight step. */
  tick(): Promise<void> {
    this.ticking ??= this.step().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async step(): Promise<void> {
    if (this.stopped) return;
    const { store, holder } = this.opts;
    const t = this.now();
    try {
      if (this._state === 'standby') {
        const epoch = await store.tryAcquire(holder, t, this.ttlMs);
        if (epoch !== null && !this.stopped) {
          this._state = 'holder';
          this._epoch = epoch;
          this.validUntil = t + this.ttlMs;
          this.emit('acquired', epoch);
        }
        return;
      }
      if (await store.renew(holder, this._epoch, t, this.ttlMs)) {
        this.validUntil = t + this.ttlMs;
        return;
      }
      this.lose();
    } catch (err) {
      this.opts.onError?.(err as Error);
      if (this._state === 'holder' && this.now() >= this.validUntil) this.lose();
    }
  }

  private lose(): void {
    this._state = 'standby';
    this.halt();
    this.emit('lost');
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop renewing and release the lease if held (SIGTERM path). */
  async stop(): Promise<void> {
    await this.ticking;
    const wasHolder = this._state === 'holder';
    this.halt();
    this._state = 'standby';
    if (wasHolder) await this.opts.store.release(this.opts.holder, this._epoch);
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/host/lease.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/host/lease.ts src/host/lease.test.ts
git commit -m "feat(host): fenced lease manager behind a LeaseStore seam

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The hosted workspace id

**Files:**
- Create: `src/host/hostState.ts`, `src/host/hostState.test.ts`

**Interfaces:**
- Produces:
  - `loadOrMintWorkspaceId(stateDir: string, mint?: () => string): Promise<string>`
  - `WORKSPACE_ID_FILE = 'workspace-id.json'`
- c3 reads this file once to seed `host_meta.workspace_id`.

- [ ] **Step 1: Write the failing test** — `src/host/hostState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrMintWorkspaceId, WORKSPACE_ID_FILE } from './hostState.js';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';

describe('loadOrMintWorkspaceId', () => {
  it('mints once and returns the same id afterwards', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'fh-state-')), 'nested');
    expect(await loadOrMintWorkspaceId(dir, () => A)).toBe(A);
    expect(await loadOrMintWorkspaceId(dir, () => B)).toBe(A);
    expect(readdirSync(dir)).toEqual([WORKSPACE_ID_FILE]);
  });

  it('concurrent mints agree on one id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    const ids = await Promise.all([loadOrMintWorkspaceId(dir, () => A), loadOrMintWorkspaceId(dir, () => B)]);
    expect(ids[0]).toBe(ids[1]);
  });

  it('refuses a corrupt id file rather than minting over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-state-'));
    writeFileSync(join(dir, WORKSPACE_ID_FILE), JSON.stringify({ id: 'not-a-ulid' }));
    await expect(loadOrMintWorkspaceId(dir, () => A)).rejects.toThrow(/no valid workspace id/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/host/hostState.test.ts`
Expected: FAIL, cannot resolve `./hostState.js`.

- [ ] **Step 3: Implement** — `src/host/hostState.ts`:

```ts
// The hosted workspace's ULID, minted once and kept on shared storage so every
// pod (and, from c3, the host DB) reports the same id.
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const WORKSPACE_ID_FILE = 'workspace-id.json';

async function readId(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const id = (JSON.parse(text) as { id?: unknown }).id;
  if (typeof id !== 'string' || !ULID_RE.test(id)) throw new Error(`${path} holds no valid workspace id`);
  return id;
}

export async function loadOrMintWorkspaceId(stateDir: string, mint: () => string = ulid): Promise<string> {
  const path = join(stateDir, WORKSPACE_ID_FILE);
  const existing = await readId(path);
  if (existing) return existing;
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `.${WORKSPACE_ID_FILE}.${randomUUID()}`);
  await writeFile(tmp, JSON.stringify({ id: mint(), createdAt: Date.now() }) + '\n', { mode: 0o644 });
  try {
    // link() fails with EEXIST if another pod minted first; its id wins.
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const id = await readId(path);
  if (!id) throw new Error(`${path} vanished after mint`);
  return id;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/host/hostState.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/host/hostState.ts src/host/hostState.test.ts
git commit -m "feat(host): mint the hosted workspace ULID once on shared storage

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/attach` fan-out with per-frame tier gating

**Files:**
- Create: `src/host/frameGate.ts`, `src/host/brokerOps.ts`, `src/host/attachHub.ts`, `src/host/testFakes.ts`, `src/host/attachHub.test.ts`
- Modify: `src/main/broker.ts` (exports only; no behaviour change)

**Interfaces:**
- Consumes:
  - `FrameType`, `FrameReader`, `encodeFrame`, `encodeJSONFrame`, `encodeChannelData`, `decodeChannelData`, `BrokerClient` (`src/main/broker.ts`);
  - `claudeCreateArgs`, `RUNNER_HOOK_SETTINGS` (`src/main/claudeArgs.ts`);
  - `tierAtLeast`.
- Produces:
  - from `frameGate.ts`:
    - `CLIENT_FRAME_TIER: ReadonlyMap<FrameType, Tier>`
    - `RESPONSE_OF: ReadonlyMap<FrameType, FrameType>`
    - `decodeResize(payload)`, `validSessionId(id)`, `hostCreateArgs(args): string[] | null`
  - from `brokerOps.ts`:
    - `BrokerOps { attach(id, handlers); create(id, cols, rows, args); list(); listPorts(); killPort(port) }`
    - `Upstream { input; resize; closeSession; detach }`
    - `UpstreamHandlers { onHistory; onOutput; onEnded; onGone }`
    - `brokerOps(socketPath): BrokerOps`
    - `UPSTREAM_CHANNEL = 1`
  - from `attachHub.ts`:
    - `AttachHub(ops)`, with `.viewer(principal, sink): Viewer`, `.owners: Map<string,string>`, `.liveTaps`, `.shutdown()`
    - `Viewer`, with `.receive(chunk): Promise<void>`, `.dispose()`, `.principal` (mutable), `.denied`
    - `Principal { identity: Identity; tier: Tier }`
    - `ViewerSink { send(frame: Buffer); close(code, reason) }`
    - `ownerKey(identity)`, `ReplayBuffer`, `trimToSafeStart`, `REPLAY_BYTES`
  - from `testFakes.ts` (used by later tests): `TOKEN`, `person`, `fakeBroker`, `sinkRecorder`, `decodeAll`, `jsonFrame`, `inputFrame`, `resizeFrame`

- [ ] **Step 1: Export the broker frame codec**

In `src/main/broker.ts`, prefix these existing declarations with `export ` and change nothing else:
- `const MAX_FRAME_PAYLOAD`
- `class FrameReader`
- `function encodeFrame`
- `function encodeJSONFrame`
- `function encodeChannelData`
- `function decodeChannelData`
- `function encodeResize`

Run: `npx vitest run src/main/broker.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 2: Add the test doubles** — `src/host/testFakes.ts`:

```ts
// Test doubles shared by the host's unit tests (not shipped: only *.test.ts import it).
import { FrameReader, FrameType, decodeChannelData, encodeChannelData, encodeFrame, encodeJSONFrame } from '../main/broker.js';
import type { Identity } from '../main/identity/types.js';
import type { BrokerOps, Upstream, UpstreamHandlers } from './brokerOps.js';
import type { ViewerSink } from './attachHub.js';

export const TOKEN = 'gho_' + 'T'.repeat(36);

export function person(login: string, id: number, teams: string[] = []): Identity {
  return { provider: 'github', kind: 'user', login, id, name: null, avatarUrl: null, teams };
}

export interface FakeSession {
  handlers: UpstreamHandlers | null;
  inputs: Buffer[];
  resizes: Array<[number, number]>;
  closed: boolean;
  detached: number;
}

export function fakeBroker(initial: string[] = []) {
  const sessions = new Map<string, FakeSession>();
  const created: Array<{ id: string; args: string[] }> = [];
  const killed: number[] = [];
  const add = (id: string): FakeSession => {
    const s: FakeSession = { handlers: null, inputs: [], resizes: [], closed: false, detached: 0 };
    sessions.set(id, s);
    return s;
  };
  for (const id of initial) add(id);
  let attachCalls = 0;
  const ops: BrokerOps = {
    async attach(id, h) {
      attachCalls++;
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'no such session' };
      if (s.handlers) return { ok: false, error: 'already attached' };
      s.handlers = h;
      const upstream: Upstream = {
        input: (d) => s.inputs.push(d),
        resize: (c, r) => s.resizes.push([c, r]),
        async closeSession() {
          s.closed = true;
          s.handlers = null;
        },
        async detach() {
          s.detached++;
          s.handlers = null;
        }
      };
      return { ok: true, upstream };
    },
    async create(id, _c, _r, args) {
      if (sessions.has(id)) return { ok: false, error: 'session id in use' };
      add(id);
      created.push({ id, args });
      return { ok: true };
    },
    async list() {
      return [...sessions.keys()].map((id) => ({ id, alive: !sessions.get(id)!.closed }));
    },
    async listPorts() {
      return [{ port: 3000 }];
    },
    async killPort(port) {
      killed.push(port);
      return { ok: true };
    }
  };
  return { ops, sessions, created, killed, attachCalls: () => attachCalls };
}

export interface Received {
  type: FrameType;
  json?: Record<string, unknown>;
  channel?: number;
  body?: Buffer;
}

const DATA_FRAMES = new Set([FrameType.OUTPUT, FrameType.HISTORY, FrameType.INPUT]);

export function decodeAll(buf: Buffer): Received[] {
  const r = new FrameReader();
  r.push(buf);
  const out: Received[] = [];
  for (const f of r.consume()) {
    if (DATA_FRAMES.has(f.type)) {
      const { channel, body } = decodeChannelData(f.payload);
      out.push({ type: f.type, channel, body });
    } else {
      out.push({ type: f.type, json: JSON.parse(f.payload.toString('utf8')) as Record<string, unknown> });
    }
  }
  return out;
}

export function sinkRecorder() {
  const frames: Received[] = [];
  const closes: Array<[number, string]> = [];
  const sink: ViewerSink = {
    send: (f) => frames.push(...decodeAll(f)),
    close: (code, reason) => closes.push([code, reason])
  };
  return { sink, frames, closes };
}

export const jsonFrame = encodeJSONFrame;
export const inputFrame = (channel: number, s: string): Buffer =>
  encodeFrame(FrameType.INPUT, encodeChannelData(channel, Buffer.from(s)));
export function resizeFrame(channel: number, cols: number, rows: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeUInt32BE(channel, 0);
  p.writeUInt16BE(cols, 4);
  p.writeUInt16BE(rows, 6);
  return encodeFrame(FrameType.RESIZE, p);
}
```

- [ ] **Step 3: Write the failing test** — `src/host/attachHub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FrameType, encodeFrame } from '../main/broker.js';
import type { Tier } from '../main/identity/grants.js';
import { AttachHub, ReplayBuffer, trimToSafeStart } from './attachHub.js';
import { RUNNER_HOOK_SETTINGS } from '../main/claudeArgs.js';
import { fakeBroker, inputFrame, jsonFrame, person, resizeFrame, sinkRecorder } from './testFakes.js';

const alice = person('alice', 1);
const bob = person('bob', 2);
const UUID = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';

function setup(tier: Tier, sessions = ['s1'], who = alice) {
  const broker = fakeBroker(sessions);
  const hub = new AttachHub(broker.ops);
  const rec = sinkRecorder();
  const v = hub.viewer({ identity: who, tier }, rec.sink);
  return { broker, hub, rec, v };
}

const last = (rec: ReturnType<typeof sinkRecorder>) => rec.frames[rec.frames.length - 1];

describe('per-frame tier gating', () => {
  // Each row: frame, the tier it needs, the response type a denial is answered with (null = silently dropped).
  const rows: Array<[string, () => Buffer, Tier, FrameType | null]> = [
    ['ATTACH', () => jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }), 'read', FrameType.ATTACHED],
    ['LIST', () => encodeFrame(FrameType.LIST, Buffer.alloc(0)), 'read', FrameType.SESSIONS],
    ['LISTPORTS', () => encodeFrame(FrameType.LISTPORTS, Buffer.alloc(0)), 'read', FrameType.PORTS],
    ['KILLPORT', () => jsonFrame(FrameType.KILLPORT, { port: 3000 }), 'steer', FrameType.KILLED],
    ['DIAL', () => jsonFrame(FrameType.DIAL, { channel: 9, port: 3000 }), 'steer', FrameType.DIALED],
    ['CREATE', () => jsonFrame(FrameType.CREATE, { id: 'new1', cols: 80, rows: 24 }), 'session', FrameType.CREATED]
  ];
  const tiers: Tier[] = ['read', 'steer', 'session'];
  const rank = (t: Tier) => tiers.indexOf(t);

  for (const [name, frame, need, resp] of rows) {
    for (const have of tiers) {
      const allowed = rank(have) >= rank(need);
      it(`${name} as ${have}: ${allowed ? 'allowed' : 'denied'}`, async () => {
        const { broker, rec, v } = setup(have);
        await v.receive(frame());
        const r = last(rec);
        expect(r.type).toBe(resp);
        if (allowed) {
          expect(String(r.json?.error ?? '')).not.toMatch(/forbidden/);
        } else {
          expect(r.json).toMatchObject({ ok: false, error: `forbidden: needs ${need}` });
          expect(v.denied).toBe(1);
          expect(broker.created).toEqual([]);
          expect(broker.killed).toEqual([]);
        }
      });
    }
  }

  it('INPUT and RESIZE from a read viewer never reach the broker', async () => {
    const { broker, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    await v.receive(inputFrame(7, 'rm -rf /\r'));
    await v.receive(resizeFrame(7, 10, 10));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
    expect(broker.sessions.get('s1')!.resizes).toEqual([]);
    expect(v.denied).toBe(2);
  });

  it('INPUT and RESIZE from a steer viewer do reach the broker', async () => {
    const { broker, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    await v.receive(inputFrame(7, 'hi'));
    await v.receive(resizeFrame(7, 100, 30));
    expect(broker.sessions.get('s1')!.inputs.map(String)).toEqual(['hi']);
    expect(broker.sessions.get('s1')!.resizes).toEqual([[100, 30]]);
  });

  it('a tier drop applies to the next frame on an open connection', async () => {
    const { broker, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    v.principal = { ...v.principal, tier: 'read' };
    await v.receive(inputFrame(7, 'late'));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
  });

  it.each([FrameType.OUTPUT, FrameType.HISTORY, FrameType.CREATED, FrameType.ATTACHED, FrameType.ENDED, FrameType.SESSIONS])(
    'server-only frame %d closes the connection with 1008',
    async (t) => {
      const { rec, v } = setup('session');
      await v.receive(encodeFrame(t, Buffer.from('{}')));
      expect(rec.closes).toEqual([[1008, `frame type ${t} not accepted`]]);
    }
  );

  it('a malformed frame closes with 1002', async () => {
    const { rec, v } = setup('session');
    const bad = Buffer.alloc(5);
    bad.writeUInt32BE(0, 0);
    await v.receive(bad);
    expect(rec.closes[0][0]).toBe(1002);
  });
});

describe('CLOSE ownership', () => {
  it('the creator may close; another session-tier user may not', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const a = sinkRecorder();
    const b = sinkRecorder();
    const va = hub.viewer({ identity: alice, tier: 'session' }, a.sink);
    const vb = hub.viewer({ identity: bob, tier: 'session' }, b.sink);
    await va.receive(jsonFrame(FrameType.CREATE, { id: 'mine', cols: 80, rows: 24 }));
    await va.receive(jsonFrame(FrameType.ATTACH, { id: 'mine', channel: 1 }));
    await vb.receive(jsonFrame(FrameType.ATTACH, { id: 'mine', channel: 5 }));
    await vb.receive(jsonFrame(FrameType.CLOSE, { channel: 5 }));
    expect(last(b).json).toMatchObject({ ok: false, error: 'forbidden: only the session owner can close it' });
    expect(broker.sessions.get('mine')!.closed).toBe(false);
    await va.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(last(a).json).toMatchObject({ ok: true });
    expect(broker.sessions.get('mine')!.closed).toBe(true);
    expect(b.frames.some((f) => f.type === FrameType.ENDED && f.json?.reason === 'closed')).toBe(true);
  });

  it('a session nobody created through this host cannot be closed by a viewer', async () => {
    const { broker, rec, v } = setup('session', ['auto-1']);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'auto-1', channel: 1 }));
    await v.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(last(rec).json).toMatchObject({ ok: false });
    expect(broker.sessions.get('auto-1')!.closed).toBe(false);
  });

  it('re-CREATE of an existing id does not transfer ownership', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    await hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    await hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    expect(hub.owners.get('x')).toBe('github:1');
  });
});

describe('CREATE args', () => {
  it.each([
    [undefined, ['--settings', RUNNER_HOOK_SETTINGS]],
    [['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID], ['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID]],
    [['--resume', UUID], ['--settings', RUNNER_HOOK_SETTINGS, '--resume', UUID]]
  ])('accepts %j', async (args, want) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([{ id: 'n', args: want }]);
  });

  it.each([
    [['--dangerously-skip-permissions']],
    [['--resume', 'not-a-uuid']],
    [['--settings', '/tmp/evil.json', '--resume', UUID]],
    [['--resume', UUID, '--mcp-config', '/x']]
  ])('refuses %j', async (args) => {
    const { broker, rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([]);
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: unsupported create args' });
  });
});

describe('fan-out', () => {
  it('one upstream per session; output reaches every viewer; newcomers get HISTORY', async () => {
    const broker = fakeBroker(['s1']);
    const hub = new AttachHub(broker.ops);
    const a = sinkRecorder();
    const b = sinkRecorder();
    const va = hub.viewer({ identity: alice, tier: 'steer' }, a.sink);
    await va.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    broker.sessions.get('s1')!.handlers!.onHistory(Buffer.from('old\n'));
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('live1'));
    const vb = hub.viewer({ identity: bob, tier: 'read' }, b.sink);
    await vb.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 4 }));
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('live2'));
    expect(broker.attachCalls()).toBe(1);
    expect(a.frames.filter((f) => f.type === FrameType.OUTPUT).map((f) => String(f.body))).toEqual(['live1', 'live2']);
    expect(b.frames.map((f) => f.type)).toEqual([FrameType.ATTACHED, FrameType.HISTORY, FrameType.OUTPUT]);
    expect(String(b.frames[1].body)).toBe('old\nlive1');
    expect(b.frames[1].channel).toBe(4);
  });

  it('the upstream detaches when the last viewer leaves, leaving the session alive', async () => {
    const { broker, hub, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await v.dispose();
    expect(broker.sessions.get('s1')!.detached).toBe(1);
    expect(broker.sessions.get('s1')!.closed).toBe(false);
    expect(hub.liveTaps).toBe(0);
  });

  it('ATTACH to a missing session reports "no such session" (the desktop then CREATEs)', async () => {
    const { rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'nope', channel: 1 }));
    expect(last(rec).json).toMatchObject({ ok: false, error: 'no such session' });
  });

  it('ENDED fans out to every viewer', async () => {
    const { broker, rec, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 3 }));
    broker.sessions.get('s1')!.handlers!.onEnded();
    expect(last(rec)).toMatchObject({ type: FrameType.ENDED, json: { channel: 3, reason: 'exit' } });
  });
});

describe('ReplayBuffer', () => {
  it('keeps the newest bytes and trims a wrapped head to a safe start', () => {
    const r = new ReplayBuffer(8);
    r.append(Buffer.from('abc\n'));
    expect(String(r.snapshot())).toBe('abc\n');
    r.append(Buffer.from('de\x1b[1mfg'));
    expect(String(r.snapshot())).toBe('\x1b[1mfg');
  });

  it('trimToSafeStart drops a dangling UTF-8 continuation', () => {
    expect(trimToSafeStart(Buffer.from([0x80, 0x80, 0x41]))).toEqual(Buffer.from('A'));
  });
});

describe('AttachHub.shutdown', () => {
  it('detaches every upstream and leaves sessions alive', async () => {
    const { broker, hub, v } = setup('read', ['s1']);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await hub.shutdown();
    expect(broker.sessions.get('s1')!.detached).toBe(1);
    expect(broker.sessions.get('s1')!.closed).toBe(false);
    expect(hub.liveTaps).toBe(0);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run src/host/attachHub.test.ts`
Expected: FAIL, cannot resolve `./attachHub.js`.

- [ ] **Step 5: Implement**

`src/host/frameGate.ts`:

```ts
// Which broker frames a viewer may send on /attach, and the tier each needs.
// Absent types (every server-to-client frame) are protocol errors.
import { FrameType } from '../main/broker.js';
import type { Tier } from '../main/identity/grants.js';
import { claudeCreateArgs, RUNNER_HOOK_SETTINGS } from '../main/claudeArgs.js';

export const CLIENT_FRAME_TIER: ReadonlyMap<FrameType, Tier> = new Map<FrameType, Tier>([
  [FrameType.ATTACH, 'read'],
  [FrameType.DETACH, 'read'],
  [FrameType.LIST, 'read'],
  [FrameType.LISTPORTS, 'read'],
  [FrameType.INPUT, 'steer'],
  [FrameType.RESIZE, 'steer'],
  [FrameType.KILLPORT, 'steer'],
  [FrameType.DIAL, 'steer'],
  [FrameType.CREATE, 'session'],
  [FrameType.CLOSE, 'session']
]);

/** The response frame a denied or failed request is answered with. */
export const RESPONSE_OF: ReadonlyMap<FrameType, FrameType> = new Map([
  [FrameType.CREATE, FrameType.CREATED],
  [FrameType.ATTACH, FrameType.ATTACHED],
  [FrameType.DETACH, FrameType.DETACHED],
  [FrameType.CLOSE, FrameType.CLOSED],
  [FrameType.LIST, FrameType.SESSIONS],
  [FrameType.DIAL, FrameType.DIALED],
  [FrameType.LISTPORTS, FrameType.PORTS],
  [FrameType.KILLPORT, FrameType.KILLED]
]);

export function decodeResize(payload: Buffer): { channel: number; cols: number; rows: number } {
  if (payload.length !== 8) throw new Error('resize frame must be 8 bytes');
  return { channel: payload.readUInt32BE(0), cols: payload.readUInt16BE(4), rows: payload.readUInt16BE(6) };
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/**
 * A viewer's CREATE args, rebuilt by the host. Only the shape the desktop
 * sends (`claudeCreateArgs`) is accepted, so a viewer can't append arbitrary
 * claude flags. Null means refuse.
 */
export function hostCreateArgs(args: unknown): string[] | null {
  if (args === undefined) return claudeCreateArgs();
  if (!Array.isArray(args)) return null;
  const rest = args[0] === '--settings' && args[1] === RUNNER_HOOK_SETTINGS ? args.slice(2) : args;
  if (rest.length === 0) return claudeCreateArgs();
  if (rest.length !== 2 || typeof rest[1] !== 'string' || !UUID_RE.test(rest[1])) return null;
  if (rest[0] === '--resume') return claudeCreateArgs(rest[1]);
  if (rest[0] === '--session-id') return claudeCreateArgs(undefined, rest[1]);
  return null;
}
```

`src/host/brokerOps.ts`:

```ts
// The host's view of the in-container broker. One upstream attachment per
// session (the broker allows one writer); control ops use a fresh connection
// each, because BrokerClient allows one in-flight request per response type.
import { BrokerClient, type BrokerPortInfo, type SessionInfo } from '../main/broker.js';

export const UPSTREAM_CHANNEL = 1;

export interface UpstreamHandlers {
  onHistory(body: Buffer): void;
  onOutput(body: Buffer): void;
  onEnded(): void;
  /** The broker connection dropped. */
  onGone(): void;
}

export interface Upstream {
  input(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Kill the session in the broker. */
  closeSession(): Promise<void>;
  /** Leave the session alive and drop the connection. */
  detach(): Promise<void>;
}

export interface BrokerOps {
  attach(id: string, h: UpstreamHandlers): Promise<{ ok: true; upstream: Upstream } | { ok: false; error: string }>;
  create(id: string, cols: number, rows: number, args: string[]): Promise<{ ok: boolean; error?: string }>;
  list(): Promise<SessionInfo[]>;
  listPorts(): Promise<BrokerPortInfo[]>;
  killPort(port: number): Promise<{ ok: boolean; error?: string }>;
}

async function withClient<T>(socket: string, fn: (c: BrokerClient) => Promise<T>): Promise<T> {
  const c = new BrokerClient(socket);
  try {
    await c.ready();
    return await fn(c);
  } finally {
    c.close();
  }
}

export function brokerOps(socket: string): BrokerOps {
  return {
    async attach(id, h) {
      const c = new BrokerClient(socket);
      try {
        await c.ready();
      } catch (err) {
        c.close();
        return { ok: false, error: `broker unreachable (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
      }
      c.on('history', (ch: number, b: Buffer) => ch === UPSTREAM_CHANNEL && h.onHistory(b));
      c.on('output', (ch: number, b: Buffer) => ch === UPSTREAM_CHANNEL && h.onOutput(b));
      c.on('ended', (ch: number) => ch === UPSTREAM_CHANNEL && h.onEnded());
      c.on('error', () => undefined);
      c.on('close', () => h.onGone());
      const r = await c.attachSession(id, UPSTREAM_CHANNEL).catch((err: Error) => ({ ok: false, error: err.message }));
      if (!r.ok) {
        c.removeAllListeners('close');
        c.close();
        return { ok: false, error: r.error ?? 'attach failed' };
      }
      return {
        ok: true,
        upstream: {
          input: (d) => c.sendInput(UPSTREAM_CHANNEL, d),
          resize: (cols, rows) => c.sendResize(UPSTREAM_CHANNEL, cols, rows),
          async closeSession() {
            await c.closeChannel(UPSTREAM_CHANNEL);
          },
          async detach() {
            c.removeAllListeners('close');
            await c.detachChannel(UPSTREAM_CHANNEL).catch(() => undefined);
            c.close();
          }
        }
      };
    },
    create: (id, cols, rows, args) => withClient(socket, (c) => c.createSession(id, cols, rows, args)),
    list: () => withClient(socket, (c) => c.listSessions()),
    listPorts: () => withClient(socket, (c) => c.listPorts()),
    killPort: (port) => withClient(socket, (c) => c.killPort(port))
  };
}
```

`src/host/attachHub.ts`:

```ts
// /attach: many viewers, one broker writer per session. The host terminates
// every viewer frame, checks its tier, and relays through a single upstream
// attachment per session, fanning OUTPUT out and replaying recent output to
// newcomers as HISTORY.
import {
  FrameReader,
  FrameType,
  decodeChannelData,
  encodeChannelData,
  encodeFrame,
  encodeJSONFrame
} from '../main/broker.js';
import { tierAtLeast, type Tier } from '../main/identity/grants.js';
import type { Identity } from '../main/identity/types.js';
import type { BrokerOps, Upstream } from './brokerOps.js';
import { CLIENT_FRAME_TIER, RESPONSE_OF, decodeResize, hostCreateArgs, validSessionId } from './frameGate.js';

/** Matches the broker's per-session ring. */
export const REPLAY_BYTES = 64 * 1024;

export interface Principal {
  identity: Identity;
  tier: Tier;
}

export interface ViewerSink {
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
}

export const ownerKey = (i: Identity): string => `${i.provider}:${i.id}`;

/** Earliest replay position that can't be mid escape sequence or mid codepoint (mirrors ring.go trimToSafeStart). */
export function trimToSafeStart(b: Buffer): Buffer {
  if (b.length === 0) return b;
  const esc = b.indexOf(0x1b);
  const nl = b.indexOf(0x0a);
  if (esc < 0 && nl < 0) {
    let i = 0;
    while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
    return b.subarray(i);
  }
  if (esc < 0) return b.subarray(nl + 1);
  if (nl < 0) return b.subarray(esc);
  return esc < nl + 1 ? b.subarray(esc) : b.subarray(nl + 1);
}

export class ReplayBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private wrapped = false;
  constructor(private readonly cap: number) {}

  append(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.cap) {
      const head = this.chunks[0];
      const excess = this.size - this.cap;
      this.wrapped = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  snapshot(): Buffer {
    const all = Buffer.concat(this.chunks);
    return this.wrapped ? trimToSafeStart(all) : all;
  }
}

type JoinResult = { ok: true } | { ok: false; error: string };

class SessionTap {
  private readonly viewers = new Map<Viewer, number>();
  private readonly replay = new ReplayBuffer(REPLAY_BYTES);
  private upstream: Upstream | null = null;
  private opening: Promise<JoinResult> | null = null;
  ended = false;

  constructor(
    readonly id: string,
    private readonly ops: BrokerOps,
    private readonly onRetire: (tap: SessionTap) => void
  ) {}

  async join(v: Viewer, channel: number): Promise<JoinResult> {
    if (!this.upstream && !this.ended) {
      this.opening ??= this.open();
      const r = await this.opening;
      if (!r.ok) {
        this.opening = null;
        if (this.viewers.size === 0) this.onRetire(this);
        return r;
      }
    }
    this.viewers.set(v, channel);
    return { ok: true };
  }

  private async open(): Promise<JoinResult> {
    const r = await this.ops.attach(this.id, {
      onHistory: (b) => this.fanOut(FrameType.HISTORY, b),
      onOutput: (b) => this.fanOut(FrameType.OUTPUT, b),
      onEnded: () => this.end('exit'),
      onGone: () => this.end('broker-gone')
    });
    if (!r.ok) return r;
    this.upstream = r.upstream;
    return { ok: true };
  }

  private fanOut(type: FrameType.OUTPUT | FrameType.HISTORY, body: Buffer): void {
    this.replay.append(body);
    for (const [v, ch] of this.viewers) v.deliver(type, ch, body);
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.upstream = null;
    this.onRetire(this);
    for (const [v, ch] of this.viewers) v.deliverEnded(ch, reason);
  }

  history(): Buffer {
    return this.replay.snapshot();
  }

  input(d: Buffer): void {
    this.upstream?.input(d);
  }

  resize(cols: number, rows: number): void {
    this.upstream?.resize(cols, rows);
  }

  async closeSession(): Promise<void> {
    const up = this.upstream;
    if (up) await up.closeSession();
    this.end('closed');
  }

  /** Drop the upstream without killing the session (SIGTERM). */
  async shutdown(): Promise<void> {
    const up = this.upstream;
    this.upstream = null;
    this.onRetire(this);
    if (up) await up.detach();
  }

  async leave(v: Viewer): Promise<void> {
    if (!this.viewers.delete(v) || this.viewers.size > 0) return;
    const up = this.upstream;
    this.upstream = null;
    this.onRetire(this);
    if (up) await up.detach();
  }
}

export class AttachHub {
  private readonly taps = new Map<string, SessionTap>();
  /** Broker session id → ownerKey of the person who CREATEd it (in memory; PTYs die with the container). */
  readonly owners = new Map<string, string>();

  constructor(readonly ops: BrokerOps) {}

  tap(id: string): SessionTap {
    let t = this.taps.get(id);
    if (!t) {
      t = new SessionTap(id, this.ops, (gone) => {
        if (this.taps.get(gone.id) === gone) this.taps.delete(gone.id);
      });
      this.taps.set(id, t);
    }
    return t;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.taps.values()].map((t) => t.shutdown()));
  }

  get liveTaps(): number {
    return this.taps.size;
  }

  viewer(principal: Principal, sink: ViewerSink): Viewer {
    return new Viewer(this, principal, sink);
  }
}

type Json = Record<string, unknown>;

function parseJson(payload: Buffer): Json | null {
  try {
    const v: unknown = JSON.parse(payload.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const isChannel = (c: unknown): c is number => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 0xffffffff;
const dim = (n: unknown, d: number): number => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 1000 ? n : d);

export class Viewer {
  private readonly channels = new Map<number, SessionTap>();
  private readonly reader = new FrameReader();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  /** Frames refused for insufficient tier. */
  denied = 0;

  constructor(
    private readonly hub: AttachHub,
    public principal: Principal,
    private readonly sink: ViewerSink
  ) {}

  /** Raw bytes from the viewer's socket; frames may span messages. */
  receive(chunk: Buffer): Promise<void> {
    if (this.closed) return this.queue;
    try {
      this.reader.push(chunk);
      for (const f of this.reader.consume()) {
        this.queue = this.queue.then(() => (this.closed ? undefined : this.safeHandle(f.type, f.payload)));
      }
    } catch {
      this.fail(1002, 'malformed frame');
    }
    return this.queue;
  }

  deliver(type: FrameType.OUTPUT | FrameType.HISTORY, channel: number, body: Buffer): void {
    if (!this.closed) this.sink.send(encodeFrame(type, encodeChannelData(channel, body)));
  }

  deliverEnded(channel: number, reason: string): void {
    if (!this.closed) this.sink.send(encodeJSONFrame(FrameType.ENDED, { channel, reason }));
  }

  private reply(type: FrameType, body: unknown): void {
    if (!this.closed) this.sink.send(encodeJSONFrame(type, body));
  }

  private fail(code: number, reason: string): void {
    void this.dispose();
    this.sink.close(code, reason);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const taps = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(taps.map((t) => t.leave(this)));
  }

  private deny(type: FrameType, payload: Buffer, need: Tier): void {
    this.denied++;
    const resp = RESPONSE_OF.get(type);
    if (resp === undefined) return;
    const req = parseJson(payload) ?? {};
    this.reply(resp, { id: req.id, channel: req.channel, ok: false, error: `forbidden: needs ${need}` });
  }

  private async safeHandle(type: FrameType, payload: Buffer): Promise<void> {
    try {
      await this.handle(type, payload);
    } catch {
      const resp = RESPONSE_OF.get(type);
      if (resp !== undefined) this.reply(resp, { ok: false, error: 'broker request failed' });
    }
  }

  private async handle(type: FrameType, payload: Buffer): Promise<void> {
    const need = CLIENT_FRAME_TIER.get(type);
    if (need === undefined) return this.fail(1008, `frame type ${type} not accepted`);
    if (!tierAtLeast(this.principal.tier, need)) return this.deny(type, payload, need);
    switch (type) {
      case FrameType.INPUT: {
        const { channel, body } = decodeChannelData(payload);
        this.channels.get(channel)?.input(body);
        return;
      }
      case FrameType.RESIZE: {
        const { channel, cols, rows } = decodeResize(payload);
        this.channels.get(channel)?.resize(cols, rows);
        return;
      }
      case FrameType.LIST:
        return this.reply(FrameType.SESSIONS, { sessions: await this.hub.ops.list() });
      case FrameType.LISTPORTS:
        return this.reply(FrameType.PORTS, { ports: await this.hub.ops.listPorts() });
    }
    const req = parseJson(payload);
    const resp = RESPONSE_OF.get(type) as FrameType;
    if (!req) return this.reply(resp, { ok: false, error: 'bad json' });
    switch (type) {
      case FrameType.ATTACH:
        return this.attach(req);
      case FrameType.DETACH: {
        const tap = isChannel(req.channel) ? this.channels.get(req.channel) : undefined;
        if (!tap) return this.reply(resp, { channel: req.channel, ok: false, error: 'channel not attached' });
        this.channels.delete(req.channel as number);
        await tap.leave(this);
        return this.reply(resp, { channel: req.channel, ok: true });
      }
      case FrameType.CLOSE:
        return this.close(req);
      case FrameType.CREATE:
        return this.create(req);
      case FrameType.KILLPORT: {
        const port = req.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          return this.reply(resp, { ok: false, error: 'bad port' });
        }
        return this.reply(resp, await this.hub.ops.killPort(port));
      }
      case FrameType.DIAL:
        return this.reply(resp, { channel: req.channel, ok: false, error: 'port forwarding is not available on remote hosts' });
    }
  }

  private async attach(req: Json): Promise<void> {
    const { id, channel } = req;
    if (!validSessionId(id) || !isChannel(channel)) {
      return this.reply(FrameType.ATTACHED, { channel, ok: false, error: 'bad request' });
    }
    if (this.channels.has(channel)) {
      return this.reply(FrameType.ATTACHED, { channel, ok: false, error: 'channel in use' });
    }
    const tap = this.hub.tap(id);
    const r = await tap.join(this, channel);
    if (!r.ok) return this.reply(FrameType.ATTACHED, { channel, ok: false, error: r.error });
    if (this.closed) return tap.leave(this);
    this.channels.set(channel, tap);
    this.reply(FrameType.ATTACHED, { channel, ok: true });
    const h = tap.history();
    if (h.length > 0) this.deliver(FrameType.HISTORY, channel, h);
    if (tap.ended) this.deliverEnded(channel, 'exit');
  }

  private async close(req: Json): Promise<void> {
    const tap = isChannel(req.channel) ? this.channels.get(req.channel) : undefined;
    if (!tap) return this.reply(FrameType.CLOSED, { channel: req.channel, ok: false, error: 'channel not attached' });
    if (this.hub.owners.get(tap.id) !== ownerKey(this.principal.identity)) {
      return this.reply(FrameType.CLOSED, { channel: req.channel, ok: false, error: 'forbidden: only the session owner can close it' });
    }
    this.channels.delete(req.channel as number);
    await tap.closeSession();
    this.hub.owners.delete(tap.id);
    this.reply(FrameType.CLOSED, { channel: req.channel, ok: true });
  }

  private async create(req: Json): Promise<void> {
    const { id } = req;
    if (!validSessionId(id)) return this.reply(FrameType.CREATED, { id, ok: false, error: 'bad session id' });
    const args = hostCreateArgs(req.args);
    if (!args) return this.reply(FrameType.CREATED, { id, ok: false, error: 'forbidden: unsupported create args' });
    const r = await this.hub.ops.create(id, dim(req.cols, 80), dim(req.rows, 24), args);
    if (r.ok) this.hub.owners.set(id, ownerKey(this.principal.identity));
    this.reply(FrameType.CREATED, { id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
}
```

- [ ] **Step 6: Run it to see it pass**

Run: `npx vitest run src/host/attachHub.test.ts && npx tsc -p tsconfig.host.json`
Expected: PASS (45 tests), no tsc output.

- [ ] **Step 7: Mutation-check the gating**

Apply each mutation alone. Confirm the listed failures, then revert.

| Mutation in `src/host/attachHub.ts` | Expected |
|---|---|
| Delete `if (!tierAtLeast(this.principal.tier, need)) return this.deny(type, payload, need);` | ≥6 failures (every "denied" row, INPUT/RESIZE from read) |
| Replace `if (this.hub.owners.get(tap.id) !== ownerKey(this.principal.identity)) {` with `if (false) {` | 2 failures (CLOSE ownership) |
| Replace `const args = hostCreateArgs(req.args);` with `const args = (req.args as string[]) ?? [];` | ≥4 failures (CREATE args) |

- [ ] **Step 8: Commit**

```bash
git add src/main/broker.ts src/host/frameGate.ts src/host/brokerOps.ts src/host/attachHub.ts src/host/testFakes.ts src/host/attachHub.test.ts
git commit -m "feat(host): /attach viewer fan-out with per-frame tier checks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: RPC registry and the events hub

**Files:**
- Create: `src/host/rpc.ts`, `src/host/rpc.test.ts`, `src/host/events.ts`, `src/host/events.test.ts`

**Interfaces:**
- Consumes: `Principal`, `BrokerOps` (Task 5); `redactSecrets` (Task 2).
- Produces:
  - from `rpc.ts`:
    - `RpcChannel { tier; handle(args, caller) }`, `RpcRegistry`, `RpcArgError`
    - `dispatchRpc(reg, channel, body, caller): Promise<RpcResponse>`
    - `brokerRpcChannels(ops): Map<string, RpcChannel>` (`sessions:live`, `ports:list`, `ports:kill`)
  - from `events.ts`:
    - `EVENT_CHANNELS`
    - `EventHub`, with `.add(sub): () => void`, `.publish(channel, payload)`, `.size`
    - `brokerWatch(ops, hub): { poll(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`src/host/rpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Tier } from '../main/identity/grants.js';
import { brokerRpcChannels, dispatchRpc, RpcArgError, type RpcChannel } from './rpc.js';
import { fakeBroker, person } from './testFakes.js';

const caller = (tier: Tier) => ({ identity: person('alice', 1), tier });

describe('dispatchRpc', () => {
  const handle = vi.fn(async (args: unknown[]) => ({ echoed: args }));
  const reg = new Map<string, RpcChannel>([['x:steer', { tier: 'steer', handle }]]);

  it('runs a channel the caller has the tier for', async () => {
    expect(await dispatchRpc(reg, 'x:steer', { args: [1] }, caller('steer'))).toEqual({ status: 200, body: { ok: true, result: { echoed: [1] } } });
  });

  it('403s below the channel tier without running it', async () => {
    handle.mockClear();
    expect(await dispatchRpc(reg, 'x:steer', { args: [] }, caller('read'))).toEqual({ status: 403, body: { ok: false, error: 'forbidden: needs steer' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('404s an unregistered channel, 400s a body without args', async () => {
    expect((await dispatchRpc(reg, 'config:get', { args: [] }, caller('session'))).status).toBe(404);
    expect((await dispatchRpc(reg, 'x:steer', { nope: 1 }, caller('session'))).status).toBe(400);
  });

  it('maps RpcArgError to 400 and redacts other errors', async () => {
    const r = new Map<string, RpcChannel>([
      ['bad', { tier: 'read', handle: async () => { throw new RpcArgError('port must be 1-65535'); } }],
      ['boom', { tier: 'read', handle: async () => { throw new Error('Bearer gho_' + 'a'.repeat(36)); } }]
    ]);
    expect(await dispatchRpc(r, 'bad', { args: [] }, caller('read'))).toEqual({ status: 400, body: { ok: false, error: 'port must be 1-65535' } });
    expect(await dispatchRpc(r, 'boom', { args: [] }, caller('read'))).toEqual({ status: 500, body: { ok: false, error: '[redacted]' } });
  });
});

describe('brokerRpcChannels', () => {
  it('declares read for listings and steer for ports:kill', () => {
    const reg = brokerRpcChannels(fakeBroker().ops);
    expect(Object.fromEntries([...reg].map(([k, v]) => [k, v.tier]))).toEqual({ 'sessions:live': 'read', 'ports:list': 'read', 'ports:kill': 'steer' });
  });

  it('ports:kill validates its port', async () => {
    const b = fakeBroker();
    const reg = brokerRpcChannels(b.ops);
    expect((await dispatchRpc(reg, 'ports:kill', { args: ['22; rm'] }, caller('steer'))).status).toBe(400);
    expect(b.killed).toEqual([]);
  });
});
```

`src/host/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { brokerWatch, EventHub } from './events.js';
import { fakeBroker } from './testFakes.js';

describe('EventHub', () => {
  it('fans a JSON message to every subscriber until it unsubscribes', () => {
    const hub = new EventHub();
    const a: string[] = [];
    const b: string[] = [];
    hub.add({ send: (t) => a.push(t) });
    const offB = hub.add({ send: (t) => b.push(t) });
    hub.publish('inbox:changed', { n: 1 });
    offB();
    hub.publish('inbox:changed', { n: 2 });
    expect(a.map((t) => JSON.parse(t))).toEqual([{ channel: 'inbox:changed', payload: { n: 1 } }, { channel: 'inbox:changed', payload: { n: 2 } }]);
    expect(b).toHaveLength(1);
  });

  it('refuses an unknown channel', () => {
    expect(() => new EventHub().publish('vault:get', {})).toThrow(/unknown event channel/);
  });
});

describe('brokerWatch', () => {
  it('publishes sessions:changed and ports:changed only when they change', async () => {
    const b = fakeBroker(['s1']);
    const hub = new EventHub();
    const got: string[] = [];
    hub.add({ send: (t) => got.push((JSON.parse(t) as { channel: string }).channel) });
    const w = brokerWatch(b.ops, hub);
    await w.poll();
    await w.poll();
    expect(got).toEqual(['sessions:changed', 'ports:changed']);
    await b.ops.create('s2', 80, 24, []);
    await w.poll();
    expect(got).toEqual(['sessions:changed', 'ports:changed', 'sessions:changed']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/host/rpc.test.ts src/host/events.test.ts`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement**

`src/host/rpc.ts`:

```ts
// POST /rpc/<channel>: IPC channel names and argument lists, each channel
// allowlisted with the tier it needs. Anything not registered doesn't exist.
import { tierAtLeast, type Tier } from '../main/identity/grants.js';
import type { Principal } from './attachHub.js';
import type { BrokerOps } from './brokerOps.js';
import { redactSecrets } from './log.js';

export interface RpcChannel {
  tier: Tier;
  handle(args: unknown[], caller: Principal): Promise<unknown>;
}

export type RpcRegistry = ReadonlyMap<string, RpcChannel>;

export class RpcArgError extends Error {}

export interface RpcResponse {
  status: number;
  body: { ok: true; result: unknown } | { ok: false; error: string };
}

export async function dispatchRpc(reg: RpcRegistry, channel: string, body: unknown, caller: Principal): Promise<RpcResponse> {
  const ch = reg.get(channel);
  if (!ch) return { status: 404, body: { ok: false, error: 'no such channel' } };
  if (!tierAtLeast(caller.tier, ch.tier)) return { status: 403, body: { ok: false, error: `forbidden: needs ${ch.tier}` } };
  const args = body && typeof body === 'object' && !Array.isArray(body) ? (body as { args?: unknown }).args : undefined;
  if (!Array.isArray(args)) return { status: 400, body: { ok: false, error: 'body must be {"args": [...]}' } };
  try {
    return { status: 200, body: { ok: true, result: await ch.handle(args, caller) } };
  } catch (err) {
    const status = err instanceof RpcArgError ? 400 : 500;
    return { status, body: { ok: false, error: redactSecrets((err as Error).message ?? 'error') } };
  }
}

export function brokerRpcChannels(ops: BrokerOps): Map<string, RpcChannel> {
  return new Map<string, RpcChannel>([
    ['sessions:live', { tier: 'read', handle: () => ops.list() }],
    ['ports:list', { tier: 'read', handle: () => ops.listPorts() }],
    [
      'ports:kill',
      {
        tier: 'steer',
        handle: async ([port]) => {
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new RpcArgError('port must be 1-65535');
          return ops.killPort(port);
        }
      }
    ]
  ]);
}
```

`src/host/events.ts`:

```ts
// GET /events: server push of the channel names desktops use internally.
// Every channel needs `read`, which every authenticated subscriber has.
import type { BrokerOps } from './brokerOps.js';

export const EVENT_CHANNELS = new Set([
  'sessions:changed',
  'ports:changed',
  'observability:summary',
  'sessionstatus:update',
  'inputwait:update',
  'automations:changed',
  'proposals:changed',
  'inbox:changed'
]);

export interface Subscriber {
  send(text: string): void;
}

export class EventHub {
  private readonly subs = new Set<Subscriber>();

  add(s: Subscriber): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  get size(): number {
    return this.subs.size;
  }

  publish(channel: string, payload: unknown): void {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`unknown event channel ${channel}`);
    const text = JSON.stringify({ channel, payload });
    for (const s of this.subs) s.send(text);
  }
}

/** Polls the broker and publishes sessions:changed / ports:changed on a change. */
export function brokerWatch(ops: BrokerOps, hub: EventHub) {
  let lastSessions = '';
  let lastPorts = '';
  async function poll(): Promise<void> {
    const sessions = await ops.list();
    const s = JSON.stringify([...sessions].sort((a, b) => a.id.localeCompare(b.id)));
    if (s !== lastSessions) {
      lastSessions = s;
      hub.publish('sessions:changed', { sessions });
    }
    const ports = await ops.listPorts();
    const p = JSON.stringify([...ports].sort((a, b) => a.port - b.port));
    if (p !== lastPorts) {
      lastPorts = p;
      hub.publish('ports:changed', { ports });
    }
  }
  return { poll };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/host/rpc.test.ts src/host/events.test.ts`
Expected: PASS (6 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/host/rpc.ts src/host/rpc.test.ts src/host/events.ts src/host/events.test.ts
git commit -m "feat(host): tier-allowlisted RPC registry and /events hub

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The endpoint (`createHostServer`)

**Files:**
- Create: `src/host/server.ts`, `src/host/server.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5 and 6.
- Produces:
  - `createHostServer(deps: HostServerDeps): HostServer`
  - `HostServerDeps { workspace(); auth(); lease(); healthy(); hub; events; rpc; log; reverifyMs? }`
  - `HostServer { server: http.Server; reverifyAll(): Promise<void>; close(): Promise<void> }`
  - `MAX_RPC_BODY`, `REVERIFY_MS`, `MAX_VIEWER_BUFFER`
- `/whoami` replies `{ workspace: {id,name,description,color}, user: {provider,kind,login,id,name,avatarUrl}, tier }`. c2's `RemoteClient` parses exactly this.

- [ ] **Step 1: Write the failing test** — `src/host/server.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { FrameType } from '../main/broker.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';
import { AttachHub } from './attachHub.js';
import { buildAuthContext, type AuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import { createLogger } from './log.js';
import { brokerRpcChannels, type RpcChannel } from './rpc.js';
import { createHostServer, type HostServer } from './server.js';
import { decodeAll, fakeBroker, inputFrame, jsonFrame, person, TOKEN } from './testFakes.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot', description: 'reviews', color: { hue: 210 } };
// One token per tier; anything else is rejected by the fake provider.
const TOKENS: Record<string, Identity> = {
  [`${TOKEN}r`]: person('reader', 10, ['acme/eng']),
  [`${TOKEN}s`]: person('steerer', 11, ['acme/ops']),
  [`${TOKEN}x`]: person('owner', 12, ['acme/platform']),
  [`${TOKEN}n`]: person('nobody', 13, ['acme/none'])
};
const GRANTS = [
  { team: 'acme/eng', tier: 'read' },
  { team: 'acme/ops', tier: 'steer' },
  { team: 'acme/platform', tier: 'session' }
];

interface Rig {
  url: string;
  host: HostServer;
  logs: string[];
  broker: ReturnType<typeof fakeBroker>;
  events: EventHub;
  setLease(s: LeaseState): void;
  setAuth(c: AuthContext): void;
  verify: IdentityProvider['verify'];
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.host.close();
  rig = null;
});

function provider(verify: IdentityProvider['verify']): AuthContext {
  return buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: GRANTS }), () => ({ id: 'github', verify }));
}

async function start(extraRpc: Array<[string, RpcChannel]> = []): Promise<Rig> {
  const logs: string[] = [];
  const broker = fakeBroker(['s1']);
  const events = new EventHub();
  let lease: LeaseState = 'holder';
  const verify = vi.fn(async (t: string) => {
    const who = TOKENS[t];
    if (!who) throw new IdentityError('unauthorized', 'bad credentials', 401);
    return who;
  });
  let auth = provider(verify);
  const rpc = new Map([...brokerRpcChannels(broker.ops), ...extraRpc]);
  const host = createHostServer({
    workspace: () => WS,
    auth: () => auth,
    lease: () => lease,
    healthy: () => true,
    hub: new AttachHub(broker.ops),
    events,
    rpc,
    log: createLogger((l) => logs.push(l)),
    reverifyMs: 3_600_000
  });
  await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', () => r()));
  const { port } = host.server.address() as AddressInfo;
  rig = {
    url: `http://127.0.0.1:${port}`,
    host,
    logs,
    broker,
    events,
    setLease: (s) => (lease = s),
    setAuth: (c) => (auth = c),
    verify
  };
  return rig;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function rpc(r: Rig, channel: string, args: unknown[], token?: string) {
  const res = await fetch(`${r.url}/rpc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? bearer(token) : {}) },
    body: JSON.stringify({ args })
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function openWs(r: Rig, path: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(r.url.replace('http', 'ws') + path, { headers: token ? bearer(token) : {} });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const nextMessage = (ws: WebSocket) => new Promise<Buffer>((r) => ws.once('message', (d: Buffer) => r(d)));
const closed = (ws: WebSocket) => new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, String(why)])));

describe('unauthenticated routes', () => {
  it('/healthz reports lease state without a token, holder or standby', async () => {
    const r = await start();
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder' });
    r.setLease('standby');
    const res = await fetch(`${r.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', lease: 'standby' });
    expect(r.verify).not.toHaveBeenCalled();
  });

  it('/leader is 200 only on the holder', async () => {
    const r = await start();
    expect((await fetch(`${r.url}/leader`)).status).toBe(200);
    r.setLease('standby');
    expect((await fetch(`${r.url}/leader`)).status).toBe(503);
  });
});

describe('identity on every request', () => {
  it.each(['/whoami'])('%s: 401 without a token, 401 with a bad one, 403 with no grant', async (path) => {
    const r = await start();
    expect((await fetch(`${r.url}${path}`)).status).toBe(401);
    expect((await fetch(`${r.url}${path}`, { headers: bearer('ghp_wrong') })).status).toBe(401);
    expect((await fetch(`${r.url}${path}`, { headers: bearer(`${TOKEN}n`) })).status).toBe(403);
  });

  it('/rpc: 401 without a token even for a read channel', async () => {
    const r = await start();
    expect((await rpc(r, 'ports:list', [])).status).toBe(401);
  });

  it.each(['/attach', '/events'])('%s upgrade: 401 without a token, 403 with no grant', async (path) => {
    const r = await start();
    await expect(openWs(r, path)).rejects.toThrow('HTTP 401');
    await expect(openWs(r, path, `${TOKEN}n`)).rejects.toThrow('HTTP 403');
  });

  it('verifies each request rather than trusting a prior one on the same connection', async () => {
    const r = await start();
    await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}r`), keepalive: true });
    expect((await fetch(`${r.url}/whoami`, { keepalive: true })).status).toBe(401);
  });

  it('a standby serves none of the authenticated routes', async () => {
    const r = await start();
    r.setLease('standby');
    expect((await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}x`) })).status).toBe(503);
    expect((await rpc(r, 'ports:list', [], `${TOKEN}x`)).status).toBe(503);
    await expect(openWs(r, '/attach', `${TOKEN}x`)).rejects.toThrow('HTTP 503');
  });
});

describe('per-route tiers', () => {
  it('/whoami returns workspace, user and tier', async () => {
    const r = await start();
    const res = await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}s`) });
    expect(await res.json()).toEqual({
      workspace: WS,
      user: { provider: 'github', kind: 'user', login: 'steerer', id: 11, name: null, avatarUrl: null },
      tier: 'steer'
    });
  });

  it.each([
    ['r', 403],
    ['s', 200],
    ['x', 200]
  ])('ports:kill (steer) with tier token %s → %d', async (suffix, status) => {
    const r = await start();
    const res = await rpc(r, 'ports:kill', [3000], `${TOKEN}${suffix}`);
    expect(res.status).toBe(status);
    expect(r.broker.killed).toEqual(status === 200 ? [3000] : []);
  });

  it('ports:list (read) is open to read', async () => {
    const r = await start();
    expect(await rpc(r, 'ports:list', [], `${TOKEN}r`)).toEqual({ status: 200, body: { ok: true, result: [{ port: 3000 }] } });
  });

  it('a session-tier channel refuses steer', async () => {
    const handle = vi.fn(async () => 'ran');
    const r = await start([['sessions:start', { tier: 'session', handle }]]);
    expect((await rpc(r, 'sessions:start', [], `${TOKEN}s`)).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    expect((await rpc(r, 'sessions:start', [], `${TOKEN}x`)).status).toBe(200);
  });

  it('unregistered channels do not exist', async () => {
    const r = await start();
    for (const ch of ['config:get', 'workspace:remove', 'fs:openPath', 'endpoints:setApiKey']) {
      expect((await rpc(r, ch, [], `${TOKEN}x`)).status).toBe(404);
    }
  });

  it('/attach frames are gated by the upgrade tier', async () => {
    const r = await start();
    const ws = await openWs(r, '/attach', `${TOKEN}r`);
    ws.send(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    expect(decodeAll(await nextMessage(ws))[0]).toMatchObject({ type: FrameType.ATTACHED, json: { ok: true } });
    ws.send(inputFrame(1, 'x'));
    ws.send(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect(decodeAll(await nextMessage(ws))[0].json).toMatchObject({ ok: false, error: 'forbidden: needs session' });
    expect(r.broker.sessions.get('s1')!.inputs).toEqual([]);
    ws.close();
  });

  it('/events pushes to authenticated subscribers', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    const msg = nextMessage(ws);
    r.events.publish('sessions:changed', { sessions: [] });
    expect(JSON.parse(String(await msg))).toEqual({ channel: 'sessions:changed', payload: { sessions: [] } });
    ws.close();
  });
});

describe('re-verification of open sockets', () => {
  it('closes a socket whose grant was removed by a config reload', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}s`);
    const done = closed(ws);
    r.setAuth(buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: [] }), () => ({ id: 'github', verify: r.verify })));
    await r.host.reverifyAll();
    expect(await done).toEqual([4403, 'no grant for @steerer']);
  });

  it('downgrades an /attach viewer in place when its tier drops', async () => {
    const r = await start();
    const ws = await openWs(r, '/attach', `${TOKEN}s`);
    ws.send(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await nextMessage(ws);
    r.setAuth(
      buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: [{ team: 'acme/ops', tier: 'read' }] }), () => ({
        id: 'github',
        verify: r.verify
      }))
    );
    await r.host.reverifyAll();
    ws.send(inputFrame(1, 'after'));
    ws.send(jsonFrame(FrameType.KILLPORT, { port: 1 }));
    expect(decodeAll(await nextMessage(ws))[0].json).toMatchObject({ error: 'forbidden: needs steer' });
    expect(r.broker.sessions.get('s1')!.inputs).toEqual([]);
    ws.close();
  });

  it('closes with 4401 once the token itself is rejected', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    const done = closed(ws);
    r.setAuth(provider(async () => { throw new IdentityError('unauthorized', 'revoked', 401); }));
    await r.host.reverifyAll();
    expect((await done)[0]).toBe(4401);
  });
});

describe('no token in logs or error bodies', () => {
  it('across auth failures, rpc errors and upgrades', async () => {
    const leaky = `${TOKEN}leak`;
    const handle = async () => {
      throw new Error(`upstream said: Authorization: Bearer ${leaky}`);
    };
    const r = await start([['boom', { tier: 'read', handle }]]);
    r.setAuth(
      buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: GRANTS }), () => ({
        id: 'github',
        verify: async (t) => {
          if (t === leaky) return person('reader', 10, ['acme/eng']);
          throw new Error(`GitHub said no to ${t}`);
        }
      }))
    );
    const bodies: string[] = [];
    bodies.push(await (await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}other`) })).text());
    bodies.push(JSON.stringify((await rpc(r, 'boom', [], leaky)).body));
    bodies.push(JSON.stringify((await rpc(r, 'nope', [], leaky)).body));
    await openWs(r, '/attach', `${TOKEN}other`).catch((e: Error) => bodies.push(e.message));
    const ws = await openWs(r, '/attach', leaky);
    ws.close();
    for (const b of [...bodies, ...r.logs]) {
      expect(b).not.toContain(TOKEN);
    }
    expect(r.logs.some((l) => l.includes('"path":"/rpc/boom"'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/host/server.test.ts`
Expected: FAIL, cannot resolve `./server.js`.

- [ ] **Step 3: Implement** — `src/host/server.ts`:

```ts
// The fleet-host endpoint (remote-workspaces §6). Every route but /healthz and
// /leader authenticates every request; WebSockets authenticate on upgrade and
// re-verify on a timer and on config reload.
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_PAYLOAD } from '../main/broker.js';
import type { AttachHub, Principal } from './attachHub.js';
import { authenticate, type AuthContext, type AuthResult } from './auth.js';
import type { HostWorkspaceInfo } from './config.js';
import type { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import type { Logger } from './log.js';
import { dispatchRpc, type RpcRegistry } from './rpc.js';

export const MAX_RPC_BODY = 1 << 20;
export const REVERIFY_MS = 60_000;
/** A viewer this far behind is dropped rather than buffered without bound. */
export const MAX_VIEWER_BUFFER = 8 << 20;

export interface HostServerDeps {
  workspace(): { id: string } & HostWorkspaceInfo;
  auth(): AuthContext;
  lease(): LeaseState;
  healthy(): boolean;
  hub: AttachHub;
  events: EventHub;
  rpc: RpcRegistry;
  log: Logger;
  reverifyMs?: number;
}

export interface HostServer {
  server: Server;
  /** Re-check every open socket against the current AuthContext. */
  reverifyAll(): Promise<void>;
  close(): Promise<void>;
}

interface LiveSocket {
  token: string;
  principal: Principal;
  setPrincipal(p: Principal): void;
  close(code: number, reason: string): void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  const text = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_RPC_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const tokenOf = (header: string | string[] | undefined): string => (typeof header === 'string' ? header.slice('Bearer '.length) : '');

export function createHostServer(deps: HostServerDeps): HostServer {
  const live = new Set<LiveSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_PAYLOAD + 5 });

  async function gate(req: IncomingMessage): Promise<AuthResult | { ok: false; status: 503; error: string }> {
    if (deps.lease() !== 'holder') return { ok: false, status: 503, error: 'standby' };
    return authenticate(req.headers.authorization, deps.auth());
  }

  async function reverify(s: LiveSocket): Promise<void> {
    const r = await authenticate(`Bearer ${s.token}`, deps.auth());
    if (!r.ok) return s.close(r.status === 401 ? 4401 : 4403, r.error);
    s.setPrincipal({ identity: r.identity, tier: r.tier });
  }

  async function reverifyAll(): Promise<void> {
    await Promise.all([...live].map(reverify));
  }

  const timer = setInterval(() => void reverifyAll(), deps.reverifyMs ?? REVERIFY_MS);
  timer.unref();

  /** Returns the caller's login once authenticated, for the request log. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    if (path === '/healthz' || path === '/leader') {
      if (req.method !== 'GET') sendJson(res, 405, { error: 'method not allowed' });
      else if (path === '/healthz') sendJson(res, deps.healthy() ? 200 : 503, { status: deps.healthy() ? 'ok' : 'unhealthy', lease: deps.lease() });
      else sendJson(res, deps.lease() === 'holder' ? 200 : 503, { lease: deps.lease() });
      return null;
    }
    const isRpc = path.startsWith('/rpc/');
    if (path !== '/whoami' && !isRpc && path !== '/attach' && path !== '/events') {
      sendJson(res, 404, { error: 'not found' });
      return null;
    }
    if (req.method !== (isRpc ? 'POST' : 'GET')) {
      sendJson(res, 405, { error: 'method not allowed' });
      return null;
    }
    const auth = await gate(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return null;
    }
    const login = auth.identity.login;
    if (path === '/attach' || path === '/events') {
      sendJson(res, 426, { error: 'WebSocket upgrade required' });
    } else if (path === '/whoami') {
      const { id, name, description, color } = deps.workspace();
      const i = auth.identity;
      sendJson(res, 200, {
        workspace: { id, name, description, color },
        user: { provider: i.provider, kind: i.kind, login: i.login, id: i.id, name: i.name, avatarUrl: i.avatarUrl },
        tier: auth.tier
      });
    } else {
      await handleRpc(req, res, path, auth);
    }
    return login;
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse, path: string, caller: Principal): Promise<void> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
    }
    const raw = await readBody(req);
    if (!raw) return sendJson(res, 413, { ok: false, error: 'body too large' });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'body is not JSON' });
    }
    const r = await dispatchRpc(deps.rpc, decodeURIComponent(path.slice('/rpc/'.length)), body, caller);
    sendJson(res, r.status, r.body);
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    handle(req, res)
      .then((login) => {
        if (path !== '/healthz') {
          deps.log.log('info', 'request', { method: req.method, path, status: res.statusCode, login, ms: Date.now() - started });
        }
      })
      .catch((err: Error) => {
        deps.log.log('error', 'request failed', { method: req.method, path, error: err.message });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
  });

  function track(ws: WebSocket, token: string, principal: Principal, onPrincipal: (p: Principal) => void): LiveSocket {
    const s: LiveSocket = {
      token,
      principal,
      setPrincipal(p) {
        s.principal = p;
        onPrincipal(p);
      },
      close: (code, reason) => ws.close(code, reason)
    };
    live.add(s);
    ws.on('close', () => live.delete(s));
    return s;
  }

  function guardedSend(ws: WebSocket, data: Buffer | string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_VIEWER_BUFFER) return ws.close(1013, 'viewer too slow');
    ws.send(data);
  }

  function onAttach(ws: WebSocket, token: string, principal: Principal): void {
    const viewer = deps.hub.viewer(principal, {
      send: (f) => guardedSend(ws, f),
      close: (code, reason) => ws.close(code, reason)
    });
    track(ws, token, principal, (p) => (viewer.principal = p));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return ws.close(1003, 'binary frames only');
      void viewer.receive(data);
    });
    ws.on('close', () => void viewer.dispose());
  }

  function onEvents(ws: WebSocket, token: string, principal: Principal): void {
    track(ws, token, principal, () => undefined);
    const off = deps.events.add({ send: (t) => guardedSend(ws, t) });
    ws.on('message', () => ws.close(1003, 'events is server-push only'));
    ws.on('close', off);
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    if (path !== '/attach' && path !== '/events') return rejectUpgrade(socket, 404, 'not found');
    void gate(req).then((auth) => {
      deps.log.log('info', 'upgrade', { path, status: auth.ok ? 101 : auth.status, login: auth.ok ? auth.identity.login : null });
      if (!auth.ok) return rejectUpgrade(socket, auth.status, auth.error);
      const token = tokenOf(req.headers.authorization);
      const principal: Principal = { identity: auth.identity, tier: auth.tier };
      wss.handleUpgrade(req, socket, head, (ws) => (path === '/attach' ? onAttach : onEvents)(ws, token, principal));
    });
  });

  return {
    server,
    reverifyAll,
    async close() {
      clearInterval(timer);
      for (const s of live) s.close(1001, 'host shutting down');
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const grace = setTimeout(() => server.closeAllConnections(), 5_000);
      await done;
      clearTimeout(grace);
    }
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/host/server.test.ts && npx tsc -p tsconfig.host.json`
Expected: PASS (21 tests).

- [ ] **Step 5: Mutation-check routes, identity and token hygiene**

Apply each mutation alone and confirm `server.test.ts` FAILS, then revert. These checks were run while this plan was validated, and each one failed as listed.

| Mutation | File | Fails |
|---|---|---|
| Replace `if (!tierAtLeast(caller.tier, ch.tier))` with `if (false)` | `rpc.ts` | ports:kill as read; session channel as steer |
| Replace `error: redactSecrets((err as Error).message ?? 'error')` with `error: (err as Error).message` | `rpc.ts` | "no token in logs or error bodies" |
| Delete `if (deps.lease() !== 'holder') return { ok: false, status: 503, error: 'standby' };` | `server.ts` | "a standby serves none of the authenticated routes" |
| Delete `    s.setPrincipal({ identity: r.identity, tier: r.tier });` | `server.ts` | "downgrades an /attach viewer in place" |
| Replace `if (!r.ok) return s.close(r.status === 401 ? 4401 : 4403, r.error);` with `if (!r.ok) return;` | `server.ts` | both close-on-reverify tests |
| In `auth.ts`, return `(err as Error).message` for non-IdentityErrors | `auth.ts` | "no token in logs or error bodies" |

- [ ] **Step 6: Commit**

```bash
git add src/host/server.ts src/host/server.test.ts
git commit -m "feat(host): authenticated endpoint with per-route tiers and socket re-verify

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Hot reload of the ConfigMap

**Files:**
- Create: `src/host/configReload.ts`, `src/host/configReload.test.ts`

**Interfaces:**
- Consumes: `HostConfig`, `loadHostConfig` (Task 1); `Logger` (Task 2).
- Produces:
  - `createReloader({ path, load, apply, log }): Reloader`, where `Reloader.reload(reason): Promise<boolean>`
  - `watchConfigDir(path, onChange, debounceMs?): () => void`

- [ ] **Step 1: Write the failing test** — `src/host/configReload.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostConfig, type HostConfig } from './config.js';
import { createReloader, watchConfigDir } from './configReload.js';
import { createLogger } from './log.js';

function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fh-reload-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, text);
  return { dir, path };
}

describe('createReloader', () => {
  it('applies a valid config and keeps the current one on an invalid file', async () => {
    const { path } = fixture('workspace: { name: a }\n');
    const applied: HostConfig[] = [];
    const logs: string[] = [];
    const r = createReloader({ path, load: loadHostConfig, apply: async (c) => void applied.push(c), log: createLogger((l) => logs.push(l)) });
    expect(await r.reload('start')).toBe(true);
    writeFileSync(path, 'workspace: { name: a }\ngrants: [{ team: acme/x, tier: admin }]\n');
    expect(await r.reload('SIGHUP')).toBe(false);
    expect(applied).toHaveLength(1);
    expect(logs.some((l) => l.includes('config reload rejected') && l.includes('tier must be one of'))).toBe(true);
  });

  it('serializes overlapping reloads', async () => {
    const { path } = fixture('workspace: { name: a }\n');
    const order: string[] = [];
    let n = 0;
    const r = createReloader({
      path,
      load: loadHostConfig,
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
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/host/configReload.test.ts`
Expected: FAIL, cannot resolve `./configReload.js`.

- [ ] **Step 3: Implement** — `src/host/configReload.ts`:

```ts
// Hot reload of the read-only ConfigMap mount. Kubernetes swaps the `..data`
// symlink in the mount directory, so the directory is watched, not the file.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { HostConfig } from './config.js';
import type { Logger } from './log.js';

export interface Reloader {
  /** Load, validate, apply. An invalid file keeps the current config. Calls are serialized. */
  reload(reason: string): Promise<boolean>;
}

export function createReloader(opts: {
  path: string;
  load(path: string): Promise<HostConfig>;
  apply(config: HostConfig): Promise<void>;
  log: Logger;
}): Reloader {
  let chain: Promise<boolean> = Promise.resolve(true);
  return {
    reload(reason) {
      chain = chain.then(async () => {
        let cfg: HostConfig;
        try {
          cfg = await opts.load(opts.path);
        } catch (err) {
          opts.log.log('warn', 'config reload rejected; keeping current config', { reason, error: (err as Error).message });
          return false;
        }
        await opts.apply(cfg);
        opts.log.log('info', 'config reloaded', { reason, grants: cfg.grants.grants.length, machines: cfg.grants.machines.length });
        return true;
      });
      return chain;
    }
  };
}

export function watchConfigDir(path: string, onChange: () => void, debounceMs = 250): () => void {
  const file = basename(path);
  let timer: NodeJS.Timeout | null = null;
  let w: FSWatcher;
  try {
    w = watch(dirname(path), (_event, name) => {
      if (name !== null && name !== file && name !== '..data') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
  } catch {
    return () => undefined;
  }
  return () => {
    if (timer) clearTimeout(timer);
    w.close();
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/host/configReload.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/host/configReload.ts src/host/configReload.test.ts
git commit -m "feat(host): serialized config reload on ConfigMap change and SIGHUP

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Entry point, bundle, and a real-broker test

**Files:**
- Create:
  - `src/host/main.ts`, `src/host/cli.ts`
  - `src/host/importGraph.test.ts`, `src/host/broker.integration.test.ts`
  - `vite.host.config.ts`
- Modify: `.github/workflows/build-app.yml`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `runHost(opts?: { env?; leaseStore?; exit? }): Promise<{ shutdown(code): Promise<void> }>`
  - `BROKER_POLL_MS`
  - the bundle `out/host/fleet-host.mjs`
- `leaseStore` is c3's injection point.

- [ ] **Step 1: Write the failing tests**

`src/host/importGraph.test.ts`:

```ts
// fleet-host runs on plain Node: the graph reachable from cli.ts must not touch
// electron or the desktop's native modules, and may reach only the pure
// src/main modules listed here.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const ENTRY = join(SRC, 'host', 'cli.ts');
const BARE_ALLOWED = new Set(['ws', 'yaml', 'ulid']);
const MAIN_ALLOWED = [/^main\/identity\/[^/]+\.ts$/, /^main\/broker\.ts$/, /^main\/claudeArgs\.ts$/, /^main\/vaultScopes\.ts$/, /^preload\/identityTypes\.ts$/];
const SPEC_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function walk(): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [ENTRY];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bare.add(spec.split('/')[0]);
        continue;
      }
      const ts = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!existsSync(ts)) throw new Error(`${relative(SRC, file)} imports missing ${spec}`);
      stack.push(ts);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')), bare };
}

describe('fleet-host import graph', () => {
  const { files, bare } = walk();

  it('uses only allowlisted packages (never electron)', () => {
    expect([...bare].filter((b) => !BARE_ALLOWED.has(b))).toEqual([]);
  });

  it('reaches only pure src/main modules', () => {
    const outside = files.filter((f) => !f.startsWith('host/') && !MAIN_ALLOWED.some((re) => re.test(f)));
    expect(outside).toEqual([]);
  });

  it('never ships test fakes', () => {
    expect(files.filter((f) => /test/i.test(f))).toEqual([]);
  });
});
```

`src/host/broker.integration.test.ts`:

```ts
// Against the real Go broker, with `cat` standing in for claude. Runs only when
// FLEET_BROKER_BIN points at a built broker (CI's host-image job sets it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameType } from '../main/broker.js';
import { AttachHub } from './attachHub.js';
import { brokerOps } from './brokerOps.js';
import { inputFrame, jsonFrame, person, sinkRecorder } from './testFakes.js';

const BIN = process.env.FLEET_BROKER_BIN;

describe.runIf(BIN)('fleet-host against the real broker', () => {
  let proc: ChildProcess;
  let socket: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-broker-'));
    socket = join(dir, 'broker.sock');
    const fake = join(dir, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nexec cat\n');
    chmodSync(fake, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_FLEET_BROKER_SOCKET: socket, CLAUDE_FLEET_BROKER_CLAUDE: fake };
    delete env.CLAUDE_FLEET_BROKER_TCP_PORT;
    proc = spawn(BIN!, [], { env, stdio: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    proc?.kill();
  });

  it('CREATE, two viewers, steer input echoes to both, read input is dropped', async () => {
    const hub = new AttachHub(brokerOps(socket));
    const a = sinkRecorder();
    const b = sinkRecorder();
    const owner = hub.viewer({ identity: person('owner', 1), tier: 'session' }, a.sink);
    const watcher = hub.viewer({ identity: person('watcher', 2), tier: 'read' }, b.sink);
    await owner.receive(jsonFrame(FrameType.CREATE, { id: 'it1', cols: 80, rows: 24 }));
    expect(a.frames.at(-1)?.json).toMatchObject({ ok: true });
    await owner.receive(jsonFrame(FrameType.ATTACH, { id: 'it1', channel: 1 }));
    await watcher.receive(jsonFrame(FrameType.ATTACH, { id: 'it1', channel: 9 }));
    await watcher.receive(inputFrame(9, 'from-watcher\r'));
    await owner.receive(inputFrame(1, 'from-owner\r'));
    const text = (r: ReturnType<typeof sinkRecorder>) =>
      r.frames.filter((f) => f.type === FrameType.OUTPUT || f.type === FrameType.HISTORY).map((f) => String(f.body)).join('');
    await expect.poll(() => text(b), { timeout: 5000 }).toContain('from-owner');
    expect(text(a)).toContain('from-owner');
    expect(text(a) + text(b)).not.toContain('from-watcher');
    await owner.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(a.frames.at(-1)?.json).toMatchObject({ ok: true });
    await watcher.dispose();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/host/importGraph.test.ts`
Expected: FAIL with `ENOENT … cli.ts`.

- [ ] **Step 3: Implement**

`src/host/main.ts`:

```ts
// fleet-host wiring: config, identity, lease, broker, endpoint, reload, shutdown.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AttachHub } from './attachHub.js';
import { buildAuthContext } from './auth.js';
import { brokerOps } from './brokerOps.js';
import { loadHostConfig, readHostEnv } from './config.js';
import { createReloader, watchConfigDir } from './configReload.js';
import { brokerWatch, EventHub } from './events.js';
import { loadOrMintWorkspaceId } from './hostState.js';
import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';
import { createLogger } from './log.js';
import { brokerRpcChannels } from './rpc.js';
import { createHostServer } from './server.js';

export const BROKER_POLL_MS = 2_000;

export interface RunHostOptions {
  env?: NodeJS.ProcessEnv;
  /** The c3 Postgres store replaces this; memory is single-replica only. */
  leaseStore?: LeaseStore;
  exit?: (code: number) => void;
}

export async function runHost(opts: RunHostOptions = {}): Promise<{ shutdown(code: number): Promise<void> }> {
  const log = createLogger();
  const env = readHostEnv(opts.env ?? process.env);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let config = await loadHostConfig(env.configPath);
  let auth = buildAuthContext(config);
  const workspaceId = await loadOrMintWorkspaceId(env.stateDir);
  const ops = brokerOps(env.brokerSocket);
  const hub = new AttachHub(ops);
  const events = new EventHub();
  const lease = new LeaseManager({
    holder: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    store: opts.leaseStore ?? memoryLeaseStore(),
    onError: (err) => log.log('warn', 'lease store error', { error: err.message })
  });
  const host = createHostServer({
    workspace: () => ({ id: workspaceId, ...config.workspace }),
    auth: () => auth,
    lease: () => lease.state,
    healthy: () => lease.running,
    hub,
    events,
    rpc: brokerRpcChannels(ops),
    log
  });

  const reloader = createReloader({
    path: env.configPath,
    load: loadHostConfig,
    apply: async (next) => {
      config = next;
      auth = buildAuthContext(next);
      await host.reverifyAll();
    },
    log
  });
  const stopWatch = watchConfigDir(env.configPath, () => void reloader.reload('file change'));
  const onHup = (): void => void reloader.reload('SIGHUP');
  process.on('SIGHUP', onHup);

  const watch = brokerWatch(ops, events);
  const poller = setInterval(() => {
    if (lease.state !== 'holder' || events.size === 0) return;
    watch.poll().catch((err: Error) => log.log('warn', 'broker poll failed', { error: err.message }));
  }, BROKER_POLL_MS);

  let stopping: Promise<void> | null = null;
  function shutdown(code: number): Promise<void> {
    stopping ??= (async () => {
      log.log('info', 'shutting down', { code, lease: lease.state });
      clearInterval(poller);
      stopWatch();
      process.off('SIGHUP', onHup);
      await host.close();
      await hub.shutdown();
      await lease.stop();
      exit(code);
    })();
    return stopping;
  }

  lease.on('acquired', (epoch: number) => log.log('info', 'lease acquired', { epoch, workspaceId }));
  lease.on('lost', () => {
    log.log('error', 'lease lost; exiting');
    void shutdown(1);
  });
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));

  lease.start();
  await new Promise<void>((resolve) => host.server.listen(env.port, '0.0.0.0', () => resolve()));
  log.log('info', 'fleet-host listening', { port: env.port, workspaceId, workspace: config.workspace.name });
  return { shutdown };
}
```

`src/host/cli.ts`:

```ts
// Bundle entry. `fleet-host init` mints (or reads) the workspace id and exits.
import { readHostEnv } from './config.js';
import { loadOrMintWorkspaceId } from './hostState.js';
import { runHost } from './main.js';

async function cli(argv: string[]): Promise<void> {
  if (argv[0] === 'init') {
    const id = await loadOrMintWorkspaceId(readHostEnv(process.env).stateDir);
    process.stdout.write(JSON.stringify({ workspaceId: id }) + '\n');
    return;
  }
  await runHost();
}

cli(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'fleet-host failed to start', error: err.message }) + '\n');
  process.exit(1);
});
```

`vite.host.config.ts`:

```ts
import { defineConfig } from 'vite';

// fleet-host: one self-contained ESM file for plain Node 22 (no node_modules in the image).
export default defineConfig({
  build: {
    ssr: 'src/host/cli.ts',
    outDir: 'out/host',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'fleet-host.mjs', format: 'es' } }
  },
  ssr: { noExternal: true, target: 'node' }
});
```

- [ ] **Step 4: Run the graph test, the real-broker test and the bundle**

```bash
npx vitest run src/host/importGraph.test.ts
( cd broker && CGO_ENABLED=0 go build -o /tmp/fh-broker ./cmd/broker )
FLEET_BROKER_BIN=/tmp/fh-broker npx vitest run src/host/broker.integration.test.ts
npm run build:host
```

Expected:
- the graph test: PASS (3 tests);
- the integration test: PASS (1 test). It's skipped when `FLEET_BROKER_BIN` is unset;
- `out/host/fleet-host.mjs` is written, about 440 kB.

- [ ] **Step 5: Smoke the bundle outside the repo** (no `node_modules` reachable)

```bash
D=$(mktemp -d); cp out/host/fleet-host.mjs "$D/"; mkdir -p "$D/etc"
printf 'workspace: { name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n' > "$D/etc/config.yaml"
FLEET_HOST_STATE="$D/state" node "$D/fleet-host.mjs" init
FLEET_HOST_PORT=18080 FLEET_HOST_CONFIG="$D/etc/config.yaml" FLEET_HOST_STATE="$D/state" node "$D/fleet-host.mjs" & P=$!
sleep 1.5; curl -s localhost:18080/healthz; curl -s -o /dev/null -w '%{http_code}\n' localhost:18080/whoami
kill -TERM $P; wait $P
```

Expected:
- `{"workspaceId":"01…"}`;
- `{"status":"ok","lease":"holder"}`;
- `401`;
- JSON log lines ending in `"msg":"shutting down","code":0`.

- [ ] **Step 6: CI runs the host typecheck, the real-broker test and the bundle**

In `.github/workflows/build-app.yml`, job `unit-run`, insert after the `Install dependencies` step:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version-file: broker/go.mod

      - name: Build broker (fleet-host integration test)
        run: cd broker && CGO_ENABLED=0 go build -o "$RUNNER_TEMP/broker" ./cmd/broker
```

Then change the `Unit tests` step and add a bundle step after it:

```yaml
      - name: Unit tests
        env:
          FLEET_BROKER_BIN: ${{ runner.temp }}/broker
        run: npm run test:unit

      - name: Bundle fleet-host
        run: npm run build:host
```

In the `changes` job's grep, add `tsconfig\.host\.json$|vite\.host\.config\.ts$|broker/` to the alternation, so broker changes rerun the integration test.

- [ ] **Step 7: Commit**

```bash
git add src/host/main.ts src/host/cli.ts src/host/importGraph.test.ts src/host/broker.integration.test.ts vite.host.config.ts .github/workflows/build-app.yml
git commit -m "feat(host): fleet-host entry, single-file bundle and real-broker test

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `runner-host` and `runner-devops-host` images

**Files:**
- Create: `docker/host/Dockerfile`, `docker/host/fleet-host-entry`, `docker/host/smoke.test.sh`
- Modify: `.dockerignore`, `.github/workflows/publish-runner.yml`

**Interfaces:**
- Produces:
  - the images `ghcr.io/<owner>/claude-fleet/runner-host` and `…/runner-devops-host`, each tagged `latest` and `sha-<short>`;
  - `/usr/local/bin/fleet-host`, a CLI wrapper, so `fleet-host init` works in the pod.

- [ ] **Step 1: Write the entry script** — `docker/host/fleet-host-entry` (mode 0755):

```bash
#!/usr/bin/env bash
# Runs the broker and fleet-host side by side under tini; the container exits
# when either does. SIGTERM stops fleet-host first so it releases the lease.
set -u
broker_bin=${FLEET_BROKER_BIN:-/usr/local/bin/broker}
host_js=${FLEET_HOST_JS:-/usr/local/lib/fleet-host/fleet-host.mjs}

"$broker_bin" &
broker=$!
node "$host_js" &
host=$!

stop() {
  kill -TERM "$host" 2>/dev/null
  wait "$host" 2>/dev/null
  kill -TERM "$broker" 2>/dev/null
  wait "$broker" 2>/dev/null
}
trap 'stop; exit 0' TERM INT

wait -n "$broker" "$host"
status=$?
stop
exit "$status"
```

Check it locally against the broker built in Task 9:

```bash
D=$(mktemp -d); mkdir -p "$D/etc"; printf 'workspace: { name: smoke }\n' > "$D/etc/config.yaml"
env -u CLAUDE_FLEET_BROKER_TCP_PORT FLEET_BROKER_BIN=/tmp/fh-broker FLEET_HOST_JS="$PWD/out/host/fleet-host.mjs" \
  FLEET_HOST_PORT=18081 FLEET_HOST_CONFIG="$D/etc/config.yaml" FLEET_HOST_STATE="$D/state" \
  CLAUDE_FLEET_BROKER_SOCKET="$D/b.sock" CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat docker/host/fleet-host-entry > "$D/log" 2>&1 & E=$!
sleep 1.5; curl -s localhost:18081/healthz; kill -TERM $E; sleep 1.5; tail -3 "$D/log"
```

Expected: `{"status":"ok","lease":"holder"}`. The tail shows fleet-host's `shutting down` line *before* the broker's `shutdown signal: terminated`.

- [ ] **Step 2: Write the Dockerfile** — `docker/host/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# runner-host / runner-devops-host: a runner image plus fleet-host (remote
# workspaces). Build with the repo root as context; BASE_IMAGE picks the runner.
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest

FROM node:22-bookworm-slim AS host-build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.host.json vite.host.config.ts ./
COPY src ./src
RUN npx vite build --config vite.host.config.ts

FROM ${BASE_IMAGE}
USER root
COPY --from=host-build /src/out/host/fleet-host.mjs /usr/local/lib/fleet-host/fleet-host.mjs
COPY docker/host/fleet-host-entry /usr/local/bin/fleet-host-entry
RUN chmod 0644 /usr/local/lib/fleet-host/fleet-host.mjs \
 && chmod 0755 /usr/local/bin/fleet-host-entry \
 && printf '#!/bin/sh\nexec node /usr/local/lib/fleet-host/fleet-host.mjs "$@"\n' > /usr/local/bin/fleet-host \
 && chmod 0755 /usr/local/bin/fleet-host \
 && mkdir -p /etc/fleet-host
USER fleet
ENV FLEET_HOST_PORT=8080 \
    FLEET_HOST_CONFIG=/etc/fleet-host/config.yaml \
    FLEET_HOST_STATE=/home/fleet/.claude/fleet-host
EXPOSE 8080
CMD ["/usr/local/bin/fleet-host-entry"]
```

The base's `ENTRYPOINT ["/usr/bin/tini", "--"]` is inherited, so tini runs `fleet-host-entry`.

- [ ] **Step 3: Opt the build inputs into the context**

The context is deny-all (SPEC §4 *Runner image build*: an unlisted `COPY` fails the publish). Append to `.dockerignore`, *before* the trailing exclusion block:

```
# runner-host: the fleet-host bundle's inputs (docker/host/Dockerfile).
!docker/host/**
!package.json
!package-lock.json
!tsconfig.host.json
!vite.host.config.ts
!src/host/**
!src/main/identity/**
!src/main/broker.ts
!src/main/claudeArgs.ts
!src/main/vaultScopes.ts
!src/preload/identityTypes.ts
```

and to the exclusion block at the end:

```
src/**/*.test.ts
src/host/testFakes.ts
docker/host/*.test.sh
```

- [ ] **Step 4: Write the image smoke test** — `docker/host/smoke.test.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# Smoke-test a runner-host image: probes on 8080, auth required, uid 1000,
# `fleet-host init`, and a clean SIGTERM that reaches fleet-host.
set -euo pipefail
image=$1
cfg=$(mktemp -d)
printf 'workspace: { name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n' > "$cfg/config.yaml"
chmod -R a+rX "$cfg"
cid=$(docker run -d -p 127.0.0.1::8080 -v "$cfg:/etc/fleet-host:ro" "$image")
trap 'docker logs "$cid" 2>&1 | tail -20 || true; docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
port=$(docker port "$cid" 8080/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/healthz" | grep -q '"lease":"holder"'
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/whoami")" = 401
test "$(docker exec "$cid" id -u)" = 1000
docker exec "$cid" fleet-host init | grep -q '"workspaceId"'
docker stop -t 15 "$cid" >/dev/null
docker logs "$cid" 2>&1 | grep -q '"msg":"shutting down"'
echo "runner-host smoke: OK"
```

- [ ] **Step 5: Publish both variants**

In `.github/workflows/publish-runner.yml`:

1. In `on.push.paths`, add:

```yaml
      - 'src/host/**'
      - 'src/main/identity/**'
      - 'src/main/broker.ts'
      - 'src/main/claudeArgs.ts'
      - 'package-lock.json'
      - 'tsconfig.host.json'
      - 'vite.host.config.ts'
```

2. In `variant-build.strategy.matrix`:
   - change `variant: [devops, dev]` to `variant: [devops, dev, host]`;
   - add to `include`:

```yaml
          - variant: host
            image: runner-host
            file: docker/host/Dockerfile
            smoke: docker/host/smoke.test.sh
```

3. In `variant-merge.strategy.matrix.include`, add `- image: runner-host`.

4. Append two jobs that build `runner-devops-host` from the devops manifest this run just published. Everything after the `BASE_IMAGE` line mirrors `variant-build` / `variant-merge`:

```yaml
  # ── runner-devops-host: FROM the runner-devops manifest this run produced ──
  devops-host-build:
    needs: [base-merge, variant-merge]
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: amd64
            runner: ubuntu-24.04
          - arch: arm64
            runner: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Resolve the runner-devops digest for this commit
        id: base
        run: |
          ref="${{ env.REGISTRY }}/${{ needs.base-merge.outputs.owner }}/claude-fleet/runner-devops:sha-${GITHUB_SHA::7}"
          d="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' | tr -d '"')"
          echo "ref=${ref%%:*}@${d}" >> "$GITHUB_OUTPUT"
      - name: Build and push runner-devops-host (${{ matrix.arch }}) by digest
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/host/Dockerfile
          platforms: linux/${{ matrix.arch }}
          build-args: |
            BASE_IMAGE=${{ steps.base.outputs.ref }}
          outputs: type=image,name=${{ env.REGISTRY }}/${{ needs.base-merge.outputs.owner }}/claude-fleet/runner-devops-host,push-by-digest=true,name-canonical=true,push=true
          cache-from: type=gha,scope=devops-host-${{ matrix.arch }}
          cache-to: type=gha,mode=max,scope=devops-host-${{ matrix.arch }}
      - name: Export digest
        run: |
          mkdir -p /tmp/digests
          touch "/tmp/digests/${DIGEST#sha256:}"
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
      - uses: actions/upload-artifact@v4
        with:
          name: digest-runner-devops-host-${{ matrix.arch }}
          path: /tmp/digests/*
          if-no-files-found: error
          retention-days: 1

  devops-host-merge:
    needs: [base-merge, devops-host-build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: /tmp/digests
          pattern: digest-runner-devops-host-*
          merge-multiple: true
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ needs.base-merge.outputs.owner }}/claude-fleet/runner-devops-host
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short
      - name: Create manifest list and push
        working-directory: /tmp/digests
        run: |
          docker buildx imagetools create \
            $(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON") \
            $(printf '${{ env.REGISTRY }}/${{ needs.base-merge.outputs.owner }}/claude-fleet/runner-devops-host@sha256:%s ' *)
```

Before committing, check the YAML: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish-runner.yml'))"`. It should exit 0.

The container can't run Docker, so the image build and smoke test are gated in CI. The PR body must say so.

- [ ] **Step 6: Commit**

```bash
git add docker/host .dockerignore .github/workflows/publish-runner.yml
git commit -m "feat(docker): runner-host and runner-devops-host images (broker + fleet-host under tini)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: SPEC.md

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Edit in place** (current state only, no history):

- **§3 Non-goals:** replace the "Not a remote orchestrator." and "Not multi-user." bullets with:
  - **Not a remote orchestrator.** The app never drives remote Docker, SSH or Kubernetes. A *remote workspace's* container lifecycle belongs to its deployment; the desktop only talks to that host's `fleet-host` API (§7 *Remote host*). Cross-node file sharing is git-synced folders.
  - **One user per desktop; shared remote hosts.** A desktop has one user, machine and keychain. A remote host is shared by everyone its deployment grants, verified per request by GitHub identity.
- **§4 Runner image build:** add a paragraph:
  - `runner-host` (FROM the base) and `runner-devops-host` (FROM `runner-devops` of the same commit) add `/usr/local/lib/fleet-host/fleet-host.mjs` (one Vite-bundled file, no `node_modules`), `/usr/local/bin/fleet-host` and `/usr/local/bin/fleet-host-entry`.
  - tini runs the entry script, which runs the broker and fleet-host together; either exiting ends the container, and SIGTERM stops fleet-host first.
  - The inputs are opted into `.dockerignore`, and `docker/host/smoke.test.sh` gates the publish.
- **§5 Architecture:** after the three-process diagram, add a `fleet-host` box inside a remote container: broker ↔ fleet-host ↔ HTTPS/WS clients. Add one sentence: `src/host/` is Electron-free and reuses `src/main/identity/`, the broker codec and `claudeArgs.ts`, pinned by `src/host/importGraph.test.ts`.
- **New §7 subsection, *Remote host (`fleet-host`)*:**
  - **Env contract:** `FLEET_HOST_PORT` (8080), `FLEET_HOST_CONFIG` (`/etc/fleet-host/config.yaml`, read-only ConfigMap, reloaded on a directory change and on SIGHUP; an invalid file keeps the current config), `FLEET_HOST_STATE` (`/home/fleet/.claude/fleet-host`), `CLAUDE_FLEET_BROKER_SOCKET`, uid 1000.
  - **Config schema:** `workspace: { name, description?, color?: { hue } }`, `identity: { provider: github, org? }`, `grants`, `machines` (validated by `parseGrantConfig`).
  - **Workspace id:** a ULID minted once into `$FLEET_HOST_STATE/workspace-id.json`; `fleet-host init` prints it.
  - **Lease:** a `LeaseStore` seam. Process-local until the host DB lands, so it's correct only for one replica. Standby semantics and the D9 503.
  - **Routes** with their tiers (§6 table), the RPC body/response shape (D10) and the c1 channels.
  - **`/attach`:** one upstream per session, the 64 KiB replay, the frame tier table, CREATE-args rebuild (D5), CLOSE ownership (D6), DIAL refused (D7), PTY size follows the last steer RESIZE (D17).
  - **`/events`** channels (D11).
  - **Re-verify:** sockets every 60 s and on reload, 4401/4403 (D8).
  - **Logging:** one JSON line per request (method, path, status, login, ms), no headers, every string redacted.
- **§9 Security model:** add bullets:
  - fleet-host authenticates every request except `/healthz` and `/leader`; tiers are enforced per route and per frame on the host; the desktop's greying is UX only.
  - The bearer token is never stored, logged or echoed. The verify cache is keyed by SHA-256 of the token and rebuilt with the provider on every reload.
  - `CREATE` args are rebuilt by the host. Plain `http://` is allowed (spec §13 Q6 is open).
- **§11 Open decisions:** add "Remote host DB": the lease and id are process-local and file-backed until c3 (Postgres + `host_lease`). Deployments must run one replica without overlap until then.

- [ ] **Step 2: Verify the whole gate**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx tsc -p tsconfig.host.json
npx vitest run
npm run build:host
```

Expected:
- no tsc output;
- vitest all green; `broker.integration.test.ts` is skipped locally unless `FLEET_BROKER_BIN` is set;
- the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): fleet-host, the remote host endpoint and runner-host images

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

## Verification environment

- Make a worktree and give it its own `node_modules` (see *Global Constraints*).
- Go: `~/toolchains/go/bin/go` builds the broker without cgo.
- The container has no Docker. CI is the gate for:
  - Task 10's image build and smoke test;
  - the `devops-host-*` jobs (only on push to `main`).
- **Validated while writing this plan** (in a scratch worktree at `ee75294`):
  - Tasks 1–9 compile under all three tsc configs;
  - their tests pass: 124 host tests, plus the real-broker test against a locally built broker;
  - every Task 2/5/7 mutation fails its tests as listed;
  - the bundle runs outside the repo;
  - `fleet-host-entry` stops fleet-host before the broker.

## Self-review

- **Spec coverage, (c) host side:**
  - `src/host/` → T1–T9;
  - the endpoint routes → T7;
  - per-route and per-frame tiers → T5 and T7;
  - viewer fan-out → T5;
  - the lease → T3, with Postgres in c3;
  - `runner-host` → T10;
  - SPEC → T11.
- **Not here, by decision:** the host DB and its store (c3, D2); the App credential helper (c3, D18); the desktop (c2).
- **Name consistency:** `Principal`, `AuthContext`, `BrokerOps`, `LeaseStore`, `HostServerDeps` and `RpcChannel` are used identically in c2 and c3.
