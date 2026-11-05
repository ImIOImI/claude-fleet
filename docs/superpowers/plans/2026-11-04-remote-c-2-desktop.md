# Remote workspaces (c2): `kind: 'remote'` on the desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in desktop add a `fleet-host` by URL and see it as a chip with a cloud glyph and tier badge. The user can then open, watch, steer and start sessions in it, according to their tier. The chip and a banner show when the host is unreachable.

**Architecture:**
- A third backend, `remote.ts`, implements the existing `Backend` contract.
  - Its liveness is `/healthz`.
  - `attachPty` opens `/attach` and drives it with the ordinary `BrokerClient` over a WebSocket stream, so the renderer's `pty:*` channels see the same `PtyHandle` as for a container.
  - Lifecycle calls throw "managed by its deployment".
- `RemoteClient` owns RPC, `/whoami`, `/events` (reconnecting) and the bearer token. The token comes from `IdentityService.bearerToken()` and never reaches the renderer.
- The manifest is a bookmark (`kind: 'remote'`, `remote: { url, tier, login, checkedAt }`) keyed by the host's workspace id.
- The renderer gains a Remote kind in the `+` modal, remote chip affordances, watch-only tabs with a "Join…" picker, and an unreachable banner.

**Tech Stack:** TypeScript, Electron main + React renderer, `ws@8` (added in c1), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §2, §6 *The desktop side*, §8 *Adding a remote workspace* / *Chip and strip* / *Sessions with owners* (watch-only and New-session gating only) / *Degraded state*, §9 *Token storage*, §12 (c).

**Depends on:** c1 (`2026-11-04-remote-c-1-host.md`) merged. The tests here start c1's `createHostServer` over its `fakeBroker`. **Ships:** attach to and work in a remote workspace.

## Global Constraints

Copied from the spec. Every task implicitly includes these.

- **`remote.ts`** implements the `Backend` contract (§6, verbatim):
  - "`ping` is `/healthz`. `listLiveWorkspaces` reports `running` or `unreachable`."
  - "`attachPty` opens `/attach` and adapts it to the same handle the renderer's `pty:*` channels already drive."
  - "`start`, `pause`, `stop` and `ensureImage` throw "managed by its deployment"."
  - "`removeWorkspace` forgets the bookmark: it deletes the manifest. The GitHub token stays, because other remote workspaces use it too."
- **`RemoteClient`** (§6, verbatim): "A new `RemoteClient` (`src/main/remoteClient.ts`) owns the RPC, the `/events` socket (reconnect with backoff) and the token."
- **The manifest is a bookmark** (§2, verbatim): "Its manifest at `<userData>/state/<id>/workspace.json` is a *bookmark*, not a spec: the host URL, the workspace id the host reports, and display fields (name, colour)." Also: "Desktops adopt that id, so a remote workspace has the same id on every desktop."
- **The token stays in main** (§9, verbatim): "The GitHub token is stored in the safeStorage vault in the reserved, host-only scope `identity:github` … and is never sent to the renderer. `RemoteClient` (main) attaches it to requests."
- **The add flow** (§8, verbatim):
  - "The app calls `/whoami` and shows the workspace name, description and **your tier**, then writes the bookmark manifest under the host's workspace id."
  - "Errors are specific: not reachable (check your network or VPN); 403 no grant (ask the host's admins to add you to a team); SSO authorisation needed (§5)."
  - "The add-workspace form shows a one-line warning for a non-loopback `http://` URL, because bearer tokens cross the wire." (§6)
- **The chip** (§8, verbatim): "a **remote glyph** (cloud) and a small tier badge (`read` / `steer` / `session`). Its status dot follows `/healthz`. Its ⋮ menu has Rename locally, Copy host URL and Forget. It has no Pause, Stop or Edit spec, because the deployment owns those."
- **Sessions** (§8, verbatim):
  - "**New session** appears only for the `session` tier."
  - "A session the viewer can't type into (`read` tier) opens its tab **watch-only**: input is disabled and the tab is labelled "watching"."
- **Degraded state** (§8, verbatim):
  - "its chip renders dimmed and inert (`unreachable`, as with a Docker outage, #380)";
  - "a slim banner names it ("*review-bot* unreachable: its sessions and automations are hidden until it's back")".
- **UI greying is not enforcement** (§9): "The desktop greys out controls too, but only as UX, not enforcement."
- **Committees** (§9): "A remote workspace is never a committee target or manager in the first release (`decideControl` keeps requiring `kind: 'container'`)." That code is unchanged.
- **Repo rules:**
  - Comments are terse.
  - SPEC.md is updated in the same PR (Task 11).
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Use your own worktree `node_modules` (`npm ci --ignore-scripts --no-audit --no-fund` and the electron stub). Run the three tsc configs separately.
  - The container can't run Electron. UI tasks are gated by typecheck + unit + build, and Troy eyeballs the result on the host.

## Decisions (recorded in SPEC.md by Task 11)

- **E1 — `/attach` reuses `BrokerClient`.** Its constructor now also accepts an already-open `Duplex`, and `ws.createWebSocketStream` provides one. The ATTACH → CREATE-on-"no such session" → ATTACH flow and `brokerPtyStream` are shared with containers.
- **E2 — Only `session` CREATEs.** A tab's missing session is created only when the cached tier is `session`. A `read` or `steer` viewer gets "This session is not running on the host, and your tier cannot start one". The host refuses anyway.
- **E3 — Remote attaches write no local mapping rows.** `attachPty` skips `recordBrokerSessionMapping`. Remote data is live-only (§7).
- **E4 — Tier is refreshed with `/whoami`:**
  - at most once a minute per bookmark during `workspace:list`;
  - always before an attach.
  - A changed tier or login is written back to the manifest, so the chip badge survives the host being down. It's display only.
- **E5 — A standby host shows as `unreachable`.** It serves nothing but probes.
- **E6 — Tabs on a remote workspace stay per desktop** (`sessions.json`):
  - The Join… picker lists the host's live broker sessions (RPC `sessions:live`) that aren't already tabs.
  - For `read` and `steer`, an empty inventory opens no default tab, because creating one would fail.
  - Owners on rows and the Mine/Everyone filter are (f).
- **E7 — Watch-only is enforced twice in the UI:**
  - `TerminalSession` drops keystrokes;
  - the host drops `INPUT` from `read` (c1).
  - The tab shows a "watching" tag.
- **E8 — `remote:add` keys the manifest by the host-reported id:**
  - Re-adding a known id rebinds its URL and keeps the local name.
  - A clash with a local or container workspace's id is refused.
  - A name clash gets `-2`, `-3`, ….
- **E9 — SSO:** a 403 while `AccountStatus.sso` is set is reported as "Authorise claude-fleet for *org*", with the GitHub link.
- **E10 — An unreachable remote chip keeps its ⋮ menu** (Rename locally, Copy host URL, Forget) so it can still be forgotten. Everything else is inert. A remote bookmark is always "warm" (`fleetTemperature.isWarm`), so it never moves to the Saved list.
- **E11 — Mock mode lists no remote workspaces.**

## File Structure

| File | Responsibility |
|---|---|
| `src/main/broker.ts` | `BrokerClient` accepts an open `Duplex`. |
| `src/main/remoteUrl.ts` (new) | Canonical host URL, plain-http warning, ws URL. |
| `src/main/remoteClient.ts` (new) | `RemoteClient`, `RemoteError`, `WhoAmI`. |
| `src/main/remoteAttach.ts` (new) | `/attach` → `PtyHandle`. |
| `src/main/remote.ts` (new) | The `remote` `Backend`. |
| `src/main/remoteIpc.ts` (new) | `remote:probe` / `add` / `rename` / `liveSessions`. |
| `src/host/testHost.ts` (new) | A real endpoint over a fake broker, for desktop tests. |
| `src/preload/remoteTypes.ts` (new) | `RemoteProbe*`, `RemoteTier`. |
| `src/main/workspaces.ts`, `src/main/workspaceMerge.ts` | `kind: 'remote'`, `RemoteBookmark`, merging remote rows. |
| `src/main/identity/identityService.ts` | `bearerToken()`. |
| `src/main/ipc.ts`, `src/preload/index.ts`, `tsconfig.web.json` | Wiring. |
| `src/renderer/src/remoteView.ts` (new) | Tier rules and copy. |
| `src/renderer/src/components/RemoteWorkspaceForm.tsx`, `RenameRemoteModal.tsx` (new) | Add and rename. |
| `WorkspaceForm.tsx`, `WorkspaceModal.tsx`, `AccountSettings.tsx`, `WorkspaceTabStrip.tsx`, `TerminalPane.tsx`, `TerminalSession.tsx`, `App.tsx`, `fleetTemperature.ts`, `committee.tsx`, `formInitial.ts`, `styles.css` | UI. |

The diffs below are against `ee75294` plus c1. Apply each one with `git apply` and check the result with `git diff`.

---

### Task 1: `BrokerClient` over a `Duplex`; host URLs

**Files:**
- Modify: `src/main/broker.ts`, `src/main/broker.test.ts`
- Create: `src/main/remoteUrl.ts`, `src/main/remoteUrl.test.ts`

**Interfaces:**
- Produces:
  - `new BrokerClient(endpoint: string | { host; port } | Duplex)`
  - `normalizeHostUrl(input): string`, which throws `RemoteUrlError`
  - `plainHttpWarning(url): string | null`
  - `wsUrl(base, path): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/broker.test.ts`:

```ts
describe('BrokerClient over an already-open Duplex', () => {
  it('speaks the frame protocol on the given stream without connecting', async () => {
    const { Duplex } = await import('node:stream');
    const { encodeJSONFrame } = await import('./broker.js');
    const written: Buffer[] = [];
    let peer: InstanceType<typeof Duplex> | null = null;
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        written.push(chunk);
        peer!.push(encodeJSONFrame(FrameType.SESSIONS, { sessions: [{ id: 's1', alive: true }] }));
        cb();
      }
    });
    peer = stream;
    const c = new BrokerClient(stream);
    await c.ready();
    expect(await c.listSessions()).toEqual([{ id: 's1', alive: true }]);
    expect(written[0][4]).toBe(FrameType.LIST);
    c.close();
  });
});
```

Create `src/main/remoteUrl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeHostUrl, plainHttpWarning, RemoteUrlError, wsUrl } from './remoteUrl.js';

describe('normalizeHostUrl', () => {
  it.each([
    ['https://review-bot.example.com/', 'https://review-bot.example.com'],
    ['  https://Review-Bot.example.com:8443/fleet//  ', 'https://review-bot.example.com:8443/fleet'],
    ['http://fleet-agent-svc:8080', 'http://fleet-agent-svc:8080']
  ])('%s → %s', (input, want) => {
    expect(normalizeHostUrl(input)).toBe(want);
  });

  it.each(['review-bot.example.com', 'ftp://x', 'https://u:p@x', 'https://x/?token=1', 'https://x/#a'])('rejects %s', (input) => {
    expect(() => normalizeHostUrl(input)).toThrow(RemoteUrlError);
  });
});

describe('plainHttpWarning', () => {
  it('warns only for non-loopback http', () => {
    expect(plainHttpWarning('http://fleet-agent-svc:8080')).toMatch(/unencrypted/);
    expect(plainHttpWarning('http://localhost:8080')).toBeNull();
    expect(plainHttpWarning('http://127.0.0.1:8080')).toBeNull();
    expect(plainHttpWarning('http://[::1]:8080')).toBeNull();
    expect(plainHttpWarning('https://x')).toBeNull();
  });
});

describe('wsUrl', () => {
  it('maps http(s) to ws(s)', () => {
    expect(wsUrl('https://x/fleet', '/attach')).toBe('wss://x/fleet/attach');
    expect(wsUrl('http://x', '/events')).toBe('ws://x/events');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/broker.test.ts src/main/remoteUrl.test.ts`
Expected:
- the Duplex test fails, because `net.createConnection` is given a stream;
- `remoteUrl` is unresolved.

- [ ] **Step 3: Implement**

In `src/main/broker.ts`:
- change the field `private socket: net.Socket;` to `private socket: Duplex;`;
- replace the constructor's head up to the `this.socket.on('data', …)` line with:

```ts
  constructor(endpoint: string | { host: string; port: number } | Duplex) {
    super();
    // A string is a unix-socket path (Linux/macOS). An {host,port} object
    // is a loopback TCP endpoint (Windows), where the broker can't be
    // reached over an AF_UNIX socket living inside Docker's Linux VM. A
    // Duplex is an already-open transport (a remote host's /attach socket).
    if (endpoint instanceof Duplex) {
      this.socket = endpoint;
      this.connected = true;
    } else {
      this.socket =
        typeof endpoint === 'string'
          ? net.createConnection(endpoint)
          : net.createConnection(endpoint.port, endpoint.host);
    }
```

`src/main/remoteUrl.ts`:

```ts
// Remote host URLs: one canonical form per host, so a bookmark, its client and
// its token use are keyed identically.

export class RemoteUrlError extends Error {}

export function normalizeHostUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new RemoteUrlError('Enter a full URL, e.g. https://review-bot.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RemoteUrlError('The host URL must start with https:// or http://');
  if (u.username || u.password) throw new RemoteUrlError('The host URL must not contain credentials');
  if (u.search || u.hash) throw new RemoteUrlError('The host URL must not have a query or fragment');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The add-workspace warning for plain http to a non-loopback host, else null. */
export function plainHttpWarning(url: string): string | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' || LOOPBACK.test(u.hostname)) return null;
  return 'Plain http: your GitHub token crosses the network unencrypted unless a VPN, tunnel or mesh encrypts it.';
}

export function wsUrl(base: string, path: string): string {
  return base.replace(/^http/, 'ws') + path;
}
```

- [ ] **Step 4: Run them to see them pass, and typecheck**

Run: `npx vitest run src/main/broker.test.ts src/main/remoteUrl.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add src/main/broker.ts src/main/broker.test.ts src/main/remoteUrl.ts src/main/remoteUrl.test.ts
git commit -m "feat(remote): BrokerClient over an open stream; canonical host URLs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `RemoteClient`

**Files:**
- Create: `src/main/remoteClient.ts`, `src/main/remoteClient.test.ts`, `src/host/testHost.ts`

**Interfaces:**
- Consumes:
  - c1's `createHostServer`, `fakeBroker`, `person`, `TOKEN`;
  - `wsUrl` (Task 1).
- Produces:
  - `RemoteClient({ url, token, timeoutMs? })`, with:
    - `.healthz(timeoutMs?)`, `.whoami(): Promise<WhoAmI>`, `.rpc<T>(channel, args)`
    - `.openSocket('/attach' | '/events'): Promise<WebSocket>`
    - `.subscribe(onEvent, onState?): () => void`
  - `RemoteError { kind: 'not-signed-in'|'unreachable'|'unauthorized'|'forbidden'|'standby'|'protocol'; status? }`
  - `WhoAmI`, `RemoteEvent`
  - `startTestHost({ tokens, grants, sessions? })` → `{ url, broker, events, setLease, close }`, and `TEST_WORKSPACE_ID`

- [ ] **Step 1: Add the test host** — `src/host/testHost.ts`:

```ts
// A real fleet-host endpoint over a fake broker, for desktop-side tests (not shipped).
import type { AddressInfo } from 'node:net';
import type { GrantRule } from '../main/identity/grants.js';
import { IdentityError, type Identity } from '../main/identity/types.js';
import { AttachHub } from './attachHub.js';
import { buildAuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import { createLogger } from './log.js';
import { brokerRpcChannels } from './rpc.js';
import { createHostServer } from './server.js';
import { fakeBroker } from './testFakes.js';

export const TEST_WORKSPACE_ID = '01JC0000000000000000000000';

export async function startTestHost(opts: { tokens: Record<string, Identity>; grants: GrantRule[]; sessions?: string[] }) {
  const broker = fakeBroker(opts.sessions ?? []);
  const events = new EventHub();
  let lease: LeaseState = 'holder';
  const config = parseHostConfig({ workspace: { name: 'review-bot', description: 'reviews' }, grants: opts.grants });
  const auth = buildAuthContext(config, () => ({
    id: 'github',
    verify: async (t) => {
      const who = opts.tokens[t];
      if (!who) throw new IdentityError('unauthorized', 'bad credentials', 401);
      return who;
    }
  }));
  const host = createHostServer({
    workspace: () => ({ id: TEST_WORKSPACE_ID, ...config.workspace }),
    auth: () => auth,
    lease: () => lease,
    healthy: () => true,
    hub: new AttachHub(broker.ops),
    events,
    rpc: brokerRpcChannels(broker.ops),
    log: createLogger(() => undefined)
  });
  await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  return { url, broker, events, setLease: (s: LeaseState) => (lease = s), close: () => host.close() };
}
```

- [ ] **Step 2: Write the failing test** — `src/main/remoteClient.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost } from '../host/testHost.js';
import { RemoteClient, RemoteError, type RemoteEvent } from './remoteClient.js';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function rig() {
  const h = await startTestHost({ tokens: { [TOKEN]: person('alice', 1, ['acme/eng']) }, grants: [{ team: 'acme/eng', tier: 'read' }] });
  close = h.close;
  return { ...h, client: (t: string | null) => new RemoteClient({ url: h.url, token: async () => t }) };
}

describe('RemoteClient', () => {
  it('healthz needs no token; whoami returns workspace and tier', async () => {
    const r = await rig();
    expect(await r.client(null).healthz()).toEqual({ status: 'ok', lease: 'holder' });
    expect(await r.client(TOKEN).whoami()).toMatchObject({ workspace: { name: 'review-bot' }, user: { login: 'alice' }, tier: 'read' });
  });

  it('rpc returns the result, and refuses a channel above the tier', async () => {
    const r = await rig();
    expect(await r.client(TOKEN).rpc('sessions:live', [])).toEqual([]);
    await expect(r.client(TOKEN).rpc('ports:kill', [3000])).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('classifies failures, never echoing the token', async () => {
    const r = await rig();
    await expect(r.client(null).whoami()).rejects.toMatchObject({ kind: 'not-signed-in' });
    const bad = 'ghp_' + 'z'.repeat(36);
    const err = (await r.client(bad).whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err.kind).toBe('unauthorized');
    expect(err.message).not.toContain('zzzz');
    r.setLease('standby');
    await expect(r.client(TOKEN).whoami()).rejects.toMatchObject({ kind: 'standby' });
    await expect(new RemoteClient({ url: 'http://127.0.0.1:1', token: async () => TOKEN }).healthz()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('never follows a redirect with the token', async () => {
    const { createServer } = await import('node:http');
    const seen: Array<string | undefined> = [];
    const srv = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
    const port = (srv.address() as { port: number }).port;
    await expect(new RemoteClient({ url: `http://127.0.0.1:${port}`, token: async () => TOKEN }).whoami()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(seen).toHaveLength(1);
    srv.close();
  });

  it('subscribe delivers pushed events and reconnects after a drop', async () => {
    const r = await rig();
    const got: RemoteEvent[] = [];
    const states: boolean[] = [];
    const off = r.client(TOKEN).subscribe((e) => got.push(e), (c) => states.push(c));
    await expect.poll(() => states[0]).toBe(true);
    r.events.publish('sessions:changed', { sessions: [] });
    await expect.poll(() => got).toEqual([{ channel: 'sessions:changed', payload: { sessions: [] } }]);
    off();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/main/remoteClient.test.ts`
Expected: FAIL, cannot resolve `./remoteClient.js`.

- [ ] **Step 4: Implement** — `src/main/remoteClient.ts`:

```ts
// One client per remote host (remote-workspaces §6): RPC, /whoami, /healthz,
// the /events socket and the bearer token. The token comes from the identity
// service on every call and never appears in an error or a log line.
import WebSocket from 'ws';
import type { Tier } from './identity/grants.js';
import { wsUrl } from './remoteUrl.js';

export type RemoteErrorKind = 'not-signed-in' | 'unreachable' | 'unauthorized' | 'forbidden' | 'standby' | 'protocol';

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface WhoAmI {
  workspace: { id: string; name: string; description: string | null; color: { hue: number } | null };
  user: { provider: string; kind: 'user' | 'machine'; login: string; id: number; name: string | null; avatarUrl: string | null };
  tier: Tier;
}

export interface RemoteEvent {
  channel: string;
  payload: unknown;
}

export interface RemoteClientOptions {
  url: string;
  token(): Promise<string | null>;
  timeoutMs?: number;
}

export const REMOTE_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const TIERS: readonly string[] = ['read', 'steer', 'session'];

function isWhoAmI(v: unknown): v is WhoAmI {
  const o = v as WhoAmI | null;
  return (
    !!o &&
    typeof o.workspace?.id === 'string' &&
    typeof o.workspace.name === 'string' &&
    typeof o.user?.login === 'string' &&
    TIERS.includes(o.tier)
  );
}

async function errorText(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: unknown };
    return typeof b.error === 'string' ? b.error : '';
  } catch {
    return '';
  }
}

export class RemoteClient {
  readonly url: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RemoteClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
  }

  private async bearer(): Promise<string> {
    const t = await this.opts.token();
    if (!t) throw new RemoteError('not-signed-in', 'Sign in with GitHub first (Settings → Account)');
    return t;
  }

  private async request(path: string, init: { method: string; body?: string; auth: boolean; timeoutMs?: number }): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.auth) headers.Authorization = `Bearer ${await this.bearer()}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      // redirect: 'error' — a redirect would replay the bearer token to a URL the user never added.
      res = await fetch(this.url + path, {
        method: init.method,
        headers,
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs)
      });
    } catch (err) {
      throw new RemoteError('unreachable', `${this.url} is not reachable (${(err as Error).name}); check your network or VPN`);
    }
    if (res.ok) return res;
    const text = await errorText(res);
    if (res.status === 401) throw new RemoteError('unauthorized', 'GitHub sign-in was rejected by the host; sign in again', 401);
    if (res.status === 403) throw new RemoteError('forbidden', text || 'You have no grant on this host', 403);
    if (res.status === 503 && text === 'standby') throw new RemoteError('standby', 'The host is starting up (standby); try again shortly', 503);
    if (res.status >= 500) throw new RemoteError('unreachable', `${this.url} answered ${res.status}${text ? `: ${text}` : ''}`, res.status);
    throw new RemoteError('protocol', `${this.url} answered ${res.status}${text ? `: ${text}` : ''}`, res.status);
  }

  async healthz(timeoutMs = 3_000): Promise<{ lease: string }> {
    const res = await this.request('/healthz', { method: 'GET', auth: false, timeoutMs });
    return (await res.json()) as { lease: string };
  }

  async whoami(): Promise<WhoAmI> {
    const body: unknown = await (await this.request('/whoami', { method: 'GET', auth: true })).json();
    if (!isWhoAmI(body)) throw new RemoteError('protocol', `${this.url} is not a fleet-host (unexpected /whoami reply)`);
    return body;
  }

  async rpc<T>(channel: string, args: unknown[]): Promise<T> {
    const res = await this.request(`/rpc/${encodeURIComponent(channel)}`, { method: 'POST', auth: true, body: JSON.stringify({ args }) });
    const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
    if (!body.ok) throw new RemoteError('protocol', body.error ?? 'rpc failed');
    return body.result as T;
  }

  /** An authenticated WebSocket to `path`, resolved once open. */
  async openSocket(path: '/attach' | '/events'): Promise<WebSocket> {
    const token = await this.bearer();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.url, path), {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        handshakeTimeout: this.timeoutMs
      });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        const kind: RemoteErrorKind = res.statusCode === 401 ? 'unauthorized' : res.statusCode === 403 ? 'forbidden' : 'unreachable';
        reject(new RemoteError(kind, `${this.url}${path} refused the connection (${res.statusCode})`, res.statusCode));
      });
      ws.once('error', (err) => reject(new RemoteError('unreachable', `${this.url}${path}: ${err.name}`)));
    });
  }

  /** Subscribe to /events, reconnecting with backoff. Returns unsubscribe. */
  subscribe(onEvent: (e: RemoteEvent) => void, onState?: (connected: boolean) => void): () => void {
    let stopped = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let timer: NodeJS.Timeout | null = null;
    const connect = (): void => {
      this.openSocket('/events').then(
        (sock) => {
          if (stopped) return sock.close();
          ws = sock;
          attempt = 0;
          onState?.(true);
          sock.on('message', (data) => {
            try {
              const e = JSON.parse(String(data)) as RemoteEvent;
              if (typeof e.channel === 'string') onEvent(e);
            } catch {
              /* ignore a malformed push */
            }
          });
          sock.on('close', () => {
            ws = null;
            onState?.(false);
            schedule();
          });
        },
        () => schedule()
      );
    };
    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }
}
```

- [ ] **Step 5: Run it to see it pass; mutation-check the redirect guard**

Run: `npx vitest run src/main/remoteClient.test.ts`
Expected: PASS (5 tests).

Then delete `        redirect: 'error',` from `request()`. Rerun, and expect "never follows a redirect with the token" to FAIL. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/main/remoteClient.ts src/main/remoteClient.test.ts src/host/testHost.ts
git commit -m "feat(remote): RemoteClient (rpc, whoami, events) against fleet-host

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `/attach` as a `PtyHandle`

**Files:**
- Create: `src/main/remoteAttach.ts`, `src/main/remoteAttach.test.ts`

**Interfaces:**
- Consumes:
  - `RemoteClient.openSocket` (Task 2);
  - `BrokerClient(Duplex)` and `brokerPtyStream` (Task 1);
  - `claudeCreateArgs`.
- Produces:
  - `attachRemotePty({ client, sessionId, cols, rows, resumeOf?, canCreate }): Promise<PtyHandle>`

- [ ] **Step 1: Write the failing test** — `src/main/remoteAttach.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost } from '../host/testHost.js';
import { attachRemotePty } from './remoteAttach.js';
import { RemoteClient } from './remoteClient.js';

const READER = `${TOKEN}r`;
const OWNER = `${TOKEN}x`;
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function rig(sessions: string[]) {
  const h = await startTestHost({
    tokens: { [READER]: person('reader', 1, ['acme/eng']), [OWNER]: person('owner', 2, ['acme/platform']) },
    grants: [{ team: 'acme/eng', tier: 'read' }, { team: 'acme/platform', tier: 'session' }],
    sessions
  });
  close = h.close;
  return { ...h, client: (t: string) => new RemoteClient({ url: h.url, token: async () => t }) };
}

describe('attachRemotePty', () => {
  it('a read viewer sees output and its keystrokes never reach the broker', async () => {
    const { broker, client } = await rig(['s1']);
    const h = await attachRemotePty({ client: client(READER), sessionId: 's1', cols: 80, rows: 24, canCreate: false });
    const got: string[] = [];
    h.stream.on('data', (b: Buffer) => got.push(String(b)));
    await expect.poll(() => broker.sessions.get('s1')!.handlers !== null).toBe(true);
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('hello'));
    await expect.poll(() => got.join('')).toContain('hello');
    h.stream.write('typed');
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
    h.detach();
  });

  it('a session-tier owner creates a missing session, types into it, and closes it', async () => {
    const { broker, client } = await rig([]);
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 100, rows: 30, canCreate: true });
    expect(broker.created[0].id).toBe('tab1');
    expect(broker.created[0].args.slice(2, 3)).toEqual(['--session-id']);
    h.stream.write('ls\r');
    await expect.poll(() => broker.sessions.get('tab1')!.inputs.map(String).join('')).toBe('ls\r');
    await h.close();
    expect(broker.sessions.get('tab1')!.closed).toBe(true);
  });

  it('a read viewer cannot start a missing session', async () => {
    const { client } = await rig([]);
    await expect(attachRemotePty({ client: client(READER), sessionId: 'nope', cols: 80, rows: 24, canCreate: false })).rejects.toThrow(/cannot start one/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/main/remoteAttach.test.ts`
Expected: FAIL, cannot resolve `./remoteAttach.js`.

- [ ] **Step 3: Implement** — `src/main/remoteAttach.ts`:

```ts
// A remote host's /attach socket speaks the broker frame protocol, so the
// ordinary BrokerClient drives it over a WebSocket stream and the renderer's
// pty:* channels see the same PtyHandle as for a container. The host requires
// whole frames per message: BrokerClient writes one frame per write, and the
// ws stream sends each write as one message.
import { randomUUID } from 'node:crypto';
import { createWebSocketStream } from 'ws';
import { BrokerClient, brokerPtyStream } from './broker.js';
import { claudeCreateArgs } from './claudeArgs.js';
import type { PtyHandle } from './docker.js';
import type { RemoteClient } from './remoteClient.js';

const CHANNEL = 1;

export interface RemoteAttachOptions {
  client: RemoteClient;
  sessionId: string;
  cols: number;
  rows: number;
  resumeOf?: string;
  /** The viewer's tier allows CREATE (`session`). */
  canCreate: boolean;
}

export async function attachRemotePty(o: RemoteAttachOptions): Promise<PtyHandle> {
  const ws = await o.client.openSocket('/attach');
  const broker = new BrokerClient(createWebSocketStream(ws));
  const stream = brokerPtyStream(broker, CHANNEL);
  const fail = (msg: string): never => {
    stream.destroy();
    broker.close();
    throw new Error(msg);
  };
  let r = await broker.attachSession(o.sessionId, CHANNEL);
  if (!r.ok && /no such session/i.test(r.error ?? '')) {
    if (!o.canCreate) fail('This session is not running on the host, and your tier cannot start one');
    const created = await broker.createSession(o.sessionId, o.cols, o.rows, claudeCreateArgs(o.resumeOf, o.resumeOf ? undefined : randomUUID()));
    if (!created.ok) fail(`host refused to start the session: ${created.error ?? 'unknown error'}`);
    r = await broker.attachSession(o.sessionId, CHANNEL);
  }
  if (!r.ok) fail(`host refused to attach: ${r.error ?? 'unknown error'}`);
  return {
    stream,
    resize: async (cols, rows) => broker.sendResize(CHANNEL, cols, rows),
    detach: () => {
      void broker.detachChannel(CHANNEL).catch(() => undefined).finally(() => broker.close());
    },
    close: async () => {
      // The host refuses CLOSE of someone else's session; dropping the socket then just detaches.
      await broker.closeChannel(CHANNEL).catch(() => undefined);
      broker.close();
    }
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/main/remoteAttach.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/remoteAttach.ts src/main/remoteAttach.test.ts
git commit -m "feat(remote): attach a remote session through the shared broker client

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The bookmark manifest and merging remote rows

**Files:**
- Modify: `src/main/workspaces.ts`, `src/main/workspaceMerge.ts`, `src/main/workspaceMerge.test.ts`, `src/renderer/src/fleetTemperature.ts`, `src/renderer/src/fleetTemperature.test.ts`
- Create: `src/main/workspaces.remote.test.ts`

**Interfaces:**
- Produces:
  - `WorkspaceKind = 'container' | 'local' | 'remote'`
  - `RemoteBookmark { url; tier: 'read'|'steer'|'session'|null; login: string|null; checkedAt: number }`
  - `WorkspaceSpec.remote?: RemoteBookmark`
  - `sanitizeRemote(r): RemoteBookmark | undefined`
  - `MergeOptions.remoteLive?: Workspace[]`
  - `isWarm` is true for any `kind === 'remote'`

- [ ] **Step 1: Write the failing tests**

Create `src/main/workspaces.remote.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeRemote } from './workspaces.js';

describe('sanitizeRemote', () => {
  it('keeps a well-formed bookmark and drops unknown tiers', () => {
    expect(sanitizeRemote({ url: 'https://h', tier: 'steer', login: 'a', checkedAt: 3, extra: 1 })).toEqual({ url: 'https://h', tier: 'steer', login: 'a', checkedAt: 3 });
    expect(sanitizeRemote({ url: 'http://h:8080', tier: 'admin' })).toEqual({ url: 'http://h:8080', tier: null, login: null, checkedAt: 0 });
  });

  it('rejects a bookmark without an http(s) URL', () => {
    expect(sanitizeRemote(undefined)).toBeUndefined();
    expect(sanitizeRemote({ url: 'file:///etc/passwd' })).toBeUndefined();
    expect(sanitizeRemote({ tier: 'read' })).toBeUndefined();
  });
});
```

Apply the test half of the merge and temperature diffs below: `workspaceMerge.test.ts` and `fleetTemperature.test.ts`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/workspaces.remote.test.ts src/main/workspaceMerge.test.ts src/renderer/src/fleetTemperature.test.ts`
Expected:
- `sanitizeRemote` is not exported;
- the remote merge case fails: the row is synthesized as `unreachable` from the manifest, with a private-dir root;
- the temperature case is cold.

- [ ] **Step 3: Implement**

`src/main/workspaces.ts`:

```diff
diff --git a/src/main/workspaces.ts b/src/main/workspaces.ts
index 3e8ba47..bc35b5d 100644
--- a/src/main/workspaces.ts
+++ b/src/main/workspaces.ts
@@ -31,7 +31,31 @@ export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted' | 'unr
  * host-process backend (no isolation, just spawn `claude` directly).
  * The selector exists in the UI; the 'local' implementation is deferred.
  */
-export type WorkspaceKind = 'container' | 'local';
+export type WorkspaceKind = 'container' | 'local' | 'remote';
+
+/** kind 'remote' only: a bookmark of a fleet-host. The id is the host's workspace id. */
+export interface RemoteBookmark {
+  /** Canonical host URL (remoteUrl.normalizeHostUrl). */
+  url: string;
+  /** Last tier /whoami reported; display only, the host enforces. */
+  tier: 'read' | 'steer' | 'session' | null;
+  /** Login the tier was reported for. */
+  login: string | null;
+  checkedAt: number;
+}
+
+export function sanitizeRemote(r: unknown): RemoteBookmark | undefined {
+  if (!r || typeof r !== 'object') return undefined;
+  const o = r as Record<string, unknown>;
+  if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return undefined;
+  const tier = o.tier === 'read' || o.tier === 'steer' || o.tier === 'session' ? o.tier : null;
+  return {
+    url: o.url,
+    tier,
+    login: typeof o.login === 'string' ? o.login : null,
+    checkedAt: typeof o.checkedAt === 'number' ? o.checkedAt : 0
+  };
+}
 
 /** Authentication mode for the workspace's `claude` invocation. */
 export type AuthMode = 'oauth' | 'apikey' | 'endpoint';
@@ -183,6 +207,8 @@ export interface WorkspaceSpec {
   inbox?: InboxConfig;
   /** 'automations' = the one workspace behind the Inbox chip (#407 Phase 5b): fleet-wide automation read + trusted. */
   role?: 'automations';
+  /** kind 'remote' only. */
+  remote?: RemoteBookmark;
   createdAt: number;
   lastUsedAt: number;
 }
@@ -306,6 +332,9 @@ export async function readWorkspaceManifest(id: string): Promise<WorkspaceSpec |
     ) {
       return null;
     }
+    const kind: WorkspaceKind = parsed.kind === 'local' || parsed.kind === 'remote' ? parsed.kind : 'container';
+    const remote = kind === 'remote' ? sanitizeRemote(parsed.remote) : undefined;
+    if (kind === 'remote' && !remote) return null;
     return {
       id: parsed.id,
       name: parsed.name,
@@ -314,7 +343,8 @@ export async function readWorkspaceManifest(id: string): Promise<WorkspaceSpec |
       color: parsed.color && typeof parsed.color.hue === 'number' ? { hue: parsed.color.hue } : undefined,
       workspaceRoot: parsed.workspaceRoot,
       workspaceSubdir: parsed.workspaceSubdir ?? '',
-      kind: parsed.kind ?? 'container',
+      kind,
+      ...(remote ? { remote } : {}),
       image: parsed.image,
       authMode:
         parsed.authMode === 'apikey' ? 'apikey'
```

`src/main/workspaceMerge.ts` and its test:

```diff
diff --git a/src/main/workspaceMerge.ts b/src/main/workspaceMerge.ts
index b58b5ad..f59b86e 100644
--- a/src/main/workspaceMerge.ts
+++ b/src/main/workspaceMerge.ts
@@ -22,6 +22,8 @@ export function isDaemonConnectError(err: unknown): boolean {
 export interface MergeOptions {
   dockerResult: PromiseSettledResult<Workspace[]>;
   localLive: Workspace[];
+  /** One row per remote bookmark, running or unreachable (remote.ts). */
+  remoteLive?: Workspace[];
   manifests: WorkspaceSpec[];
   /** Mutated in place: repopulated from merged container states on docker
    *  success; read for synthesis on daemon-connect failure. */
@@ -32,13 +34,14 @@ export interface MergeOptions {
 
 export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]> {
   const { dockerResult, localLive, manifests, lastKnown, privateDir, factoryMirror } = opts;
+  const remoteLive = opts.remoteLive ?? [];
   const dockerDown = dockerResult.status === 'rejected';
   if (dockerDown && !isDaemonConnectError(dockerResult.reason)) throw dockerResult.reason;
   const dockerLive = dockerResult.status === 'fulfilled' ? dockerResult.value : [];
 
   // ── manifest overlay: identical merge logic to ipc.ts ──────────────────────
   const liveById = new Map<string, Workspace>();
-  for (const w of [...dockerLive, ...localLive]) if (!liveById.has(w.id)) liveById.set(w.id, w);
+  for (const w of [...dockerLive, ...localLive, ...remoteLive]) if (!liveById.has(w.id)) liveById.set(w.id, w);
   const manifestById = new Map(manifests.map((m) => [m.id, m]));
   const result: Workspace[] = [];
 
@@ -57,7 +60,8 @@ export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]>
       // container created before the fleet-root migration still carries the old
       // path). Local: the user picked an existing host dir, so honor the
       // manifest's workspaceRoot (#16).
-      workspaceRoot: w.kind === 'local' ? m?.workspaceRoot ?? w.workspaceRoot : await privateDir(w.id),
+      workspaceRoot:
+        w.kind === 'remote' ? '' : w.kind === 'local' ? m?.workspaceRoot ?? w.workspaceRoot : await privateDir(w.id),
       workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
       authMode: m?.authMode ?? w.authMode,
       endpointId: m?.endpointId,
@@ -69,6 +73,7 @@ export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]>
       accessibility: m?.accessibility,
       inbox: m?.inbox,
       role: m?.role,
+      remote: m?.remote ?? w.remote,
       // Manifest-only (#268). This projection is field-by-field, so an omitted
       // field is dropped for every LIVE workspace while the deleted branch
       // (`...m`) keeps it — the form would then show "Default" for a workspace
@@ -81,6 +86,7 @@ export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]>
   }
 
   for (const m of manifestById.values()) {
+    if (m.kind === 'remote') continue;
     const root = m.kind === 'local' ? m.workspaceRoot : await privateDir(m.id);
     if (dockerDown && m.kind !== 'local') {
       // Degraded synthesis (#380). Honest-state rule: a last-known 'deleted'
@@ -104,7 +110,7 @@ export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]>
   // down-merge must not overwrite the states it needs for synthesis.
   if (!dockerDown) {
     lastKnown.clear();
-    for (const w of result) if (w.kind !== 'local') lastKnown.set(w.id, w.state);
+    for (const w of result) if (w.kind === 'container') lastKnown.set(w.id, w.state);
   }
   return result;
 }
diff --git a/src/main/workspaceMerge.test.ts b/src/main/workspaceMerge.test.ts
index 1db0759..067e5dc 100644
--- a/src/main/workspaceMerge.test.ts
+++ b/src/main/workspaceMerge.test.ts
@@ -121,3 +121,33 @@ describe('mergeWorkspaces', () => {
     expect(out[0]).toMatchObject({ id: 'a', terminalRenderer: 'webgl' });
   });
 });
+
+describe('mergeWorkspaces: remote bookmarks', () => {
+  const bookmark = { url: 'https://h', tier: 'read' as const, login: 'a', checkedAt: 1 };
+  const remoteSpec = (id: string): WorkspaceSpec => ({ ...spec(id, 'container'), kind: 'remote', workspaceRoot: '', remote: bookmark }) as WorkspaceSpec;
+
+  it('a remote row comes only from remoteLive, never from docker-down synthesis or lastKnown', async () => {
+    const lastKnown = new Map<string, WorkspaceState>();
+    const out = await mergeWorkspaces({
+      dockerResult: down(),
+      localLive: [],
+      remoteLive: [{ ...remoteSpec('r1'), state: 'unreachable', containerId: 'r1' } as Workspace],
+      manifests: [remoteSpec('r1'), remoteSpec('r2')],
+      lastKnown,
+      privateDir,
+      factoryMirror: MIRROR
+    });
+    expect(out.map((w) => [w.id, w.state, w.workspaceRoot, w.remote?.url])).toEqual([['r1', 'unreachable', '', 'https://h']]);
+    const up2 = await mergeWorkspaces({
+      dockerResult: up([]),
+      localLive: [],
+      remoteLive: [{ ...remoteSpec('r1'), state: 'running', containerId: 'r1' } as Workspace],
+      manifests: [remoteSpec('r1')],
+      lastKnown,
+      privateDir,
+      factoryMirror: MIRROR
+    });
+    expect(up2[0].state).toBe('running');
+    expect(lastKnown.has('r1')).toBe(false);
+  });
+});
```

`src/renderer/src/fleetTemperature.ts` and its test:

```diff
diff --git a/src/renderer/src/fleetTemperature.ts b/src/renderer/src/fleetTemperature.ts
index 1862a53..51826c5 100644
--- a/src/renderer/src/fleetTemperature.ts
+++ b/src/renderer/src/fleetTemperature.ts
@@ -5,10 +5,13 @@
 interface TemperatureInput {
   state: 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';
   lastKnownState?: 'running' | 'paused' | 'stopped' | 'deleted';
+  kind?: string;
 }
 
 export function isWarm(w: TemperatureInput | undefined): boolean {
   if (!w) return false;
+  // A remote bookmark is never cold: unreachable shows as a dimmed chip.
+  if (w.kind === 'remote') return true;
   if (w.state === 'running' || w.state === 'paused') return true;
   return w.state === 'unreachable' && (w.lastKnownState === 'running' || w.lastKnownState === 'paused');
 }
diff --git a/src/renderer/src/fleetTemperature.test.ts b/src/renderer/src/fleetTemperature.test.ts
index 0fce335..c64f7ca 100644
--- a/src/renderer/src/fleetTemperature.test.ts
+++ b/src/renderer/src/fleetTemperature.test.ts
@@ -22,4 +22,9 @@ describe('fleet temperature', () => {
     expect(isCold(w('unreachable', 'running'))).toBe(false); // in the strip, not Saved
     expect(isCold(w('running'))).toBe(false);
   });
+
+  it('a remote bookmark is always warm, reachable or not', () => {
+    expect(isWarm({ state: 'unreachable', kind: 'remote' })).toBe(true);
+    expect(isCold({ state: 'unreachable', kind: 'remote' })).toBe(false);
+  });
 });
```

- [ ] **Step 4: Run them to see them pass, and typecheck both configs**

Run: `npx vitest run src/main/workspaces.remote.test.ts src/main/workspaceMerge.test.ts src/renderer/src/fleetTemperature.test.ts src/main/workspacesManifestRead.test.ts && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, no tsc output.

- [ ] **Step 5: Commit**

```bash
git add src/main/workspaces.ts src/main/workspaces.remote.test.ts src/main/workspaceMerge.ts src/main/workspaceMerge.test.ts src/renderer/src/fleetTemperature.ts src/renderer/src/fleetTemperature.test.ts
git commit -m "feat(remote): kind 'remote' bookmark manifests and remote rows in the merged list

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The `remote` backend and the bearer token

**Files:**
- Create: `src/main/remote.ts`, `src/main/remote.test.ts`
- Modify: `src/main/identity/identityService.ts`, `src/main/identity/identityService.test.ts`

**Interfaces:**
- Consumes:
  - `RemoteClient` (Task 2), `attachRemotePty` (Task 3);
  - `WorkspaceSpec.remote` (Task 4);
  - `startTestHost`.
- Produces:
  - `createRemoteBackend({ token, listManifests, writeManifest, deleteState, now? }): RemoteBackend`
  - `RemoteBackend extends Backend { clientFor(url): RemoteClient; refreshTier(spec): Promise<WhoAmI> }`
  - `MANAGED_MSG`, `TIER_REFRESH_MS`
  - `IdentityService.bearerToken(): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

`src/main/remote.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost, TEST_WORKSPACE_ID as ID } from '../host/testHost.js';
import { createRemoteBackend, MANAGED_MSG } from './remote.js';
import type { WorkspaceSpec } from './workspaces.js';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function rig(tier: 'read' | 'session') {
  const h = await startTestHost({ tokens: { [TOKEN]: person('alice', 1) }, grants: [{ login: 'alice', tier }] });
  close = h.close;
  let manifests: WorkspaceSpec[] = [
    { id: ID, name: 'review-bot', kind: 'remote', remote: { url: h.url, tier: null, login: null, checkedAt: 0 } } as WorkspaceSpec,
    { id: 'gone', name: 'gone', kind: 'remote', remote: { url: 'http://127.0.0.1:1', tier: 'read', login: 'alice', checkedAt: 0 } } as WorkspaceSpec
  ];
  const deleted: string[] = [];
  const backend = createRemoteBackend({
    token: async () => TOKEN,
    listManifests: async () => manifests,
    writeManifest: async (s) => void (manifests = manifests.map((m) => (m.id === s.id ? s : m))),
    deleteState: async (id) => void deleted.push(id)
  });
  return { ...h, backend, manifests: () => manifests, deleted };
}

describe('remote backend', () => {
  it('lists every bookmark as running or unreachable and persists the reported tier', async () => {
    const r = await rig('read');
    const rows = await r.backend.listLiveWorkspaces();
    expect(rows.map((w) => [w.id, w.state, w.containerId])).toEqual([[ID, 'running', ID], ['gone', 'unreachable', 'gone']]);
    expect(r.manifests()[0].remote).toMatchObject({ tier: 'read', login: 'alice' });
  });

  it('a standby host is shown unreachable', async () => {
    const r = await rig('read');
    r.setLease('standby');
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('unreachable');
  });

  it('attach starts a missing session only for the session tier', async () => {
    const reader = await rig('read');
    await expect(reader.backend.attachPty(ID, 'tab1', 80, 24)).rejects.toThrow(/cannot start one/);
    await reader.close();
    const owner = await rig('session');
    const h = await owner.backend.attachPty(ID, 'tab1', 80, 24);
    expect(owner.broker.created.map((c) => c.id)).toEqual(['tab1']);
    h.detach();
  });

  it('lifecycle calls throw "managed by its deployment"; forget deletes local state only', async () => {
    const r = await rig('read');
    await expect(r.backend.startWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.stopWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.pauseWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.ensureImage(() => undefined)).rejects.toThrow(MANAGED_MSG);
    await r.backend.removeWorkspace(ID);
    expect(r.deleted).toEqual([ID]);
  });
});
```

In `src/main/identity/identityService.test.ts`, in `describe('IdentityService refresh, sign-out and the packages token', …)`, add after `it('offers the token for packages only with read:packages', …)`:

```ts
  it('offers the bearer token for remote hosts whatever its scopes, and none once signed out', async () => {
    const s = setup({ polls: [{ status: 'done', token: TOKEN, scopes: ['read:org'] }], probe: { ...PROBE, scopes: ['read:org'] } });
    expect(await s.svc.bearerToken()).toBeNull();
    await signIn(s);
    expect(await s.svc.bearerToken()).toBe(TOKEN);
    await s.svc.signOut();
    expect(await s.svc.bearerToken()).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/remote.test.ts src/main/identity/identityService.test.ts`
Expected: FAIL. `./remote.js` is unresolved, and `bearerToken is not a function`.

- [ ] **Step 3: Implement**

`src/main/remote.ts`:

```ts
// The `remote` backend (remote-workspaces §6): a bookmark of a fleet-host.
// Lifecycle belongs to the deployment, so start/pause/stop/image calls throw;
// liveness is /healthz, attach is /attach.
import type { Backend } from './backend.js';
import type { Workspace, WorkspaceSpec } from './workspaces.js';
import { attachRemotePty } from './remoteAttach.js';
import { RemoteClient, type WhoAmI } from './remoteClient.js';

export const MANAGED_MSG = 'This remote workspace is managed by its deployment';
export const TIER_REFRESH_MS = 60_000;

export interface RemoteBackendDeps {
  token(): Promise<string | null>;
  listManifests(): Promise<WorkspaceSpec[]>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  /** Delete the bookmark's local state dir (manifest + local tab list). */
  deleteState(id: string): Promise<void>;
  now?: () => number;
}

export interface RemoteBackend extends Backend {
  clientFor(url: string): RemoteClient;
  /** Re-read /whoami for a bookmark and persist a changed tier. */
  refreshTier(spec: WorkspaceSpec): Promise<WhoAmI>;
}

const managed = async (): Promise<never> => {
  throw new Error(MANAGED_MSG);
};
const unsupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available for remote workspaces`);
};

export function createRemoteBackend(deps: RemoteBackendDeps): RemoteBackend {
  const now = deps.now ?? Date.now;
  const clients = new Map<string, RemoteClient>();
  const lastWhoami = new Map<string, number>();

  function clientFor(url: string): RemoteClient {
    let c = clients.get(url);
    if (!c) {
      c = new RemoteClient({ url, token: deps.token });
      clients.set(url, c);
    }
    return c;
  }

  async function bookmark(id: string): Promise<WorkspaceSpec> {
    const m = (await deps.listManifests()).find((s) => s.id === id && s.kind === 'remote');
    if (!m?.remote) throw new Error(`no remote workspace ${id}`);
    return m;
  }

  async function refreshTier(spec: WorkspaceSpec): Promise<WhoAmI> {
    const who = await clientFor(spec.remote!.url).whoami();
    lastWhoami.set(spec.id, now());
    const r = spec.remote!;
    if (r.tier !== who.tier || r.login !== who.user.login) {
      await deps.writeManifest({ ...spec, remote: { ...r, tier: who.tier, login: who.user.login, checkedAt: now() } });
    }
    return who;
  }

  async function liveRow(spec: WorkspaceSpec): Promise<Workspace> {
    const c = clientFor(spec.remote!.url);
    let state: Workspace['state'] = 'unreachable';
    let current = spec;
    try {
      const h = await c.healthz();
      if (h.lease === 'holder') {
        state = 'running';
        if (now() - (lastWhoami.get(spec.id) ?? 0) >= TIER_REFRESH_MS) {
          const who = await refreshTier(spec).catch(() => null);
          if (who) current = { ...spec, remote: { ...spec.remote!, tier: who.tier, login: who.user.login } };
        }
      }
    } catch {
      state = 'unreachable';
    }
    return { ...current, state, containerId: spec.id };
  }

  return {
    clientFor,
    refreshTier,
    ping: async () => true,
    ensureImage: managed,
    async listLiveWorkspaces() {
      const remotes = (await deps.listManifests()).filter((m) => m.kind === 'remote' && m.remote);
      return Promise.all(remotes.map(liveRow));
    },
    createWorkspace: managed,
    inspectImage: managed,
    startWorkspace: managed,
    isResumeImageStale: async () => false,
    pauseWorkspace: managed,
    stopWorkspace: managed,
    async removeWorkspace(containerId) {
      await deps.deleteState(containerId);
      lastWhoami.delete(containerId);
    },
    async attachPty(containerId, sessionId, cols, rows, resumeOf) {
      const spec = await bookmark(containerId);
      const who = await refreshTier(spec);
      return attachRemotePty({ client: clientFor(spec.remote!.url), sessionId, cols, rows, resumeOf, canCreate: who.tier === 'session' });
    },
    getBrokerLogs: async () => '',
    committeePost: unsupported('Committee post'),
    spawnHeadless: unsupported('Headless sessions'),
    headlessState: unsupported('Headless sessions'),
    closeHeadless: unsupported('Headless sessions'),
    execScript: unsupported('Script steps')
  };
}
```

In `src/main/identity/identityService.ts`, add above `packagesToken()`:

```ts
  /** For RemoteClient: the signed-in token, attached to fleet-host requests. Main process only. */
  async bearerToken(): Promise<string | null> {
    return (await this.settled())?.token ?? null;
  }
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/main/remote.test.ts src/main/identity/identityService.test.ts src/main/identity/noElectron.test.ts`
Expected: PASS (remote 4, identityService 56, noElectron unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/main/remote.ts src/main/remote.test.ts src/main/identity/identityService.ts src/main/identity/identityService.test.ts
git commit -m "feat(remote): remote Backend (healthz liveness, managed lifecycle, tier refresh)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `remote:*` IPC and wiring

**Files:**
- Create: `src/main/remoteIpc.ts`, `src/main/remoteIpc.test.ts`, `src/preload/remoteTypes.ts`
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `tsconfig.web.json`

**Interfaces:**
- Consumes: `RemoteBackend` (Task 5); `IdentityService.status()`.
- Produces:
  - channels `remote:probe(url) → RemoteProbe`, `remote:add(url) → RemoteProbe`, `remote:rename(id, name) → void`, `remote:liveSessions(id) → Array<{ id; alive }>`
  - `window.api.remote.{probe, add, rename, liveSessions}`
  - `RemoteProbe = RemoteProbeOk | RemoteProbeErr`, and `RemoteTier`

- [ ] **Step 1: Write the failing test** — `src/main/remoteIpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../preload/identityTypes.js';
import type { RemoteBackend } from './remote.js';
import { RemoteError, type WhoAmI } from './remoteClient.js';
import { REMOTE_CHANNELS, registerRemoteIpc, type RemoteIpcDeps } from './remoteIpc.js';
import type { WorkspaceSpec } from './workspaces.js';

const WHO: WhoAmI = {
  workspace: { id: '01JC0000000000000000000000', name: 'review-bot', description: 'reviews', color: { hue: 210 } },
  user: { provider: 'github', kind: 'user', login: 'alice', id: 1, name: 'Alice', avatarUrl: null },
  tier: 'steer'
};

function harness(whoami: () => Promise<WhoAmI>, opts: { manifests?: WorkspaceSpec[]; sso?: AccountStatus['sso'] } = {}) {
  const store = new Map((opts.manifests ?? []).map((m) => [m.id, m]));
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const deps: RemoteIpcDeps = {
    backend: { clientFor: () => ({ whoami }) } as unknown as RemoteBackend,
    accountStatus: async () => ({ sso: opts.sso ?? null }) as AccountStatus,
    readManifest: async (id) => store.get(id) ?? null,
    writeManifest: async (s) => void store.set(s.id, s),
    findByName: async (n) => [...store.values()].find((m) => m.name === n) ?? null,
    invalidate: vi.fn(),
    now: () => 5
  };
  registerRemoteIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  const call = (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a));
  return { call, store, handlers, deps };
}

describe('remote:* IPC', () => {
  it('registers exactly the remote channels', () => {
    expect([...harness(async () => WHO).handlers.keys()].sort()).toEqual([...REMOTE_CHANNELS].sort());
  });

  it('probe normalizes the URL, reports tier and the plain-http warning', async () => {
    const r = await harness(async () => WHO).call('remote:probe', ' http://fleet-agent-svc:8080/ ');
    expect(r).toMatchObject({ ok: true, url: 'http://fleet-agent-svc:8080', tier: 'steer', existing: false, warning: expect.stringMatching(/unencrypted/) });
  });

  it.each([
    [new RemoteError('unreachable', 'x is not reachable'), 'unreachable'],
    [new RemoteError('forbidden', 'no grant for @alice'), 'forbidden'],
    [new RemoteError('not-signed-in', 'sign in'), 'not-signed-in']
  ])('probe maps %s to %s', async (err, kind) => {
    expect(await harness(async () => { throw err; }).call('remote:probe', 'https://h')).toMatchObject({ ok: false, kind });
  });

  it('a 403 with a pending SSO authorisation says so', async () => {
    const sso = { url: 'https://github.com/orgs/acme/sso?x', org: 'acme', orgCount: 1, appSettingsUrl: null };
    const r = await harness(async () => { throw new RemoteError('forbidden', 'no grant'); }, { sso }).call('remote:probe', 'https://h');
    expect(r).toMatchObject({ ok: false, kind: 'sso', ssoUrl: sso.url });
  });

  it('add writes a bookmark under the host-reported id, suffixing a clashing name', async () => {
    const taken = { id: 'other', name: 'review-bot', kind: 'container' } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [taken] });
    await h.call('remote:add', 'https://h/');
    const m = h.store.get(WHO.workspace.id)!;
    expect(m).toMatchObject({ kind: 'remote', name: 'review-bot-2', workspaceRoot: '', remote: { url: 'https://h', tier: 'steer', login: 'alice', checkedAt: 5 } });
    expect(h.deps.invalidate).toHaveBeenCalled();
  });

  it('add of a known id rebinds the URL and keeps the local name', async () => {
    const prior = { id: WHO.workspace.id, name: 'my-name', kind: 'remote', remote: { url: 'https://old', tier: 'read', login: 'alice', checkedAt: 1 } } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [prior] });
    expect(await h.call('remote:add', 'https://new')).toMatchObject({ ok: true, existing: true });
    expect(h.store.get(WHO.workspace.id)).toMatchObject({ name: 'my-name', remote: { url: 'https://new', tier: 'steer' } });
  });

  it('add refuses an id that belongs to a local workspace', async () => {
    const local = { id: WHO.workspace.id, name: 'x', kind: 'local' } as WorkspaceSpec;
    expect(await harness(async () => WHO, { manifests: [local] }).call('remote:add', 'https://h')).toMatchObject({ ok: false });
  });

  it('liveSessions asks the bookmark\'s host over sessions:live', async () => {
    const rpc = vi.fn(async () => [{ id: 's1', alive: true }]);
    const a = { id: 'A', name: 'a', kind: 'remote', remote: { url: 'https://h', tier: 'read', login: 'x', checkedAt: 0 } } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [a] });
    (h.deps.backend as unknown as { clientFor: () => unknown }).clientFor = () => ({ rpc });
    expect(await h.call('remote:liveSessions', 'A')).toEqual([{ id: 's1', alive: true }]);
    expect(rpc).toHaveBeenCalledWith('sessions:live', []);
    await expect(h.call('remote:liveSessions', 'nope')).rejects.toThrow(/Not a remote/);
  });

  it('rename changes only the local name and refuses a clash', async () => {
    const a = { id: 'A', name: 'a', kind: 'remote', remote: { url: 'https://h', tier: null, login: null, checkedAt: 0 } } as WorkspaceSpec;
    const b = { id: 'B', name: 'b', kind: 'container' } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [a, b] });
    await h.call('remote:rename', 'A', ' renamed ');
    expect(h.store.get('A')!.name).toBe('renamed');
    await expect(h.call('remote:rename', 'A', 'b')).rejects.toThrow(/already exists/);
    await expect(h.call('remote:rename', 'B', 'z')).rejects.toThrow(/Not a remote/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/main/remoteIpc.test.ts`
Expected: FAIL, unresolved `./remoteIpc.js`.

- [ ] **Step 3: Implement**

`src/preload/remoteTypes.ts`:

```ts
// remote:* IPC payloads (add a remote workspace). No token ever appears here.

export type RemoteTier = 'read' | 'steer' | 'session';

export interface RemoteProbeOk {
  ok: true;
  /** Canonical URL the bookmark will store. */
  url: string;
  workspace: { id: string; name: string; description: string | null; color: { hue: number } | null };
  user: { login: string; name: string | null; avatarUrl: string | null };
  tier: RemoteTier;
  /** Plain-http warning for a non-loopback host, else null. */
  warning: string | null;
  /** A bookmark for this workspace id already exists. */
  existing: boolean;
}

export type RemoteProbeErrorKind =
  | 'invalid-url'
  | 'not-signed-in'
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'sso'
  | 'standby'
  | 'protocol';

export interface RemoteProbeErr {
  ok: false;
  kind: RemoteProbeErrorKind;
  message: string;
  /** kind 'sso': GitHub's authorise URL when known. */
  ssoUrl?: string | null;
}

export type RemoteProbe = RemoteProbeOk | RemoteProbeErr;
```

`src/main/remoteIpc.ts`:

```ts
// remote:* IPC: probe a host URL, bookmark it, rename the bookmark locally.
// Forget is workspace:remove (the remote backend deletes the bookmark).
import type { IpcHandleLike } from './vaultIpc.js';
import type { AccountStatus } from '../preload/identityTypes.js';
import type { RemoteProbe, RemoteProbeErr } from '../preload/remoteTypes.js';
import type { RemoteBackend } from './remote.js';
import { RemoteError } from './remoteClient.js';
import { normalizeHostUrl, plainHttpWarning, RemoteUrlError } from './remoteUrl.js';
import { FACTORY_MIRROR, type WorkspaceSpec } from './workspaces.js';

export const REMOTE_CHANNELS = ['remote:probe', 'remote:add', 'remote:rename', 'remote:liveSessions'] as const;

export interface RemoteIpcDeps {
  backend: RemoteBackend;
  accountStatus(): Promise<AccountStatus>;
  readManifest(id: string): Promise<WorkspaceSpec | null>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  findByName(name: string): Promise<WorkspaceSpec | null>;
  invalidate(): void;
  now?: () => number;
}

async function classify(err: unknown, deps: RemoteIpcDeps): Promise<RemoteProbeErr> {
  if (err instanceof RemoteUrlError) return { ok: false, kind: 'invalid-url', message: err.message };
  if (!(err instanceof RemoteError)) return { ok: false, kind: 'protocol', message: 'Unexpected error talking to the host' };
  if (err.kind === 'forbidden') {
    const sso = (await deps.accountStatus().catch(() => null))?.sso;
    if (sso) {
      return {
        ok: false,
        kind: 'sso',
        message: `Authorise claude-fleet for ${sso.org ?? 'your organisation'} on GitHub (a one-time step), then try again`,
        ssoUrl: sso.url ?? sso.appSettingsUrl
      };
    }
    return { ok: false, kind: 'forbidden', message: `${err.message}. Ask the host's admins to add you to a team with access.` };
  }
  return { ok: false, kind: err.kind, message: err.message };
}

async function uniqueName(base: string, id: string, deps: RemoteIpcDeps): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const hit = await deps.findByName(name);
    if (!hit || hit.id === id) return name;
  }
}

export function registerRemoteIpc(ipc: IpcHandleLike, deps: RemoteIpcDeps): void {
  const now = deps.now ?? Date.now;

  async function probe(raw: unknown): Promise<RemoteProbe> {
    try {
      if (typeof raw !== 'string') throw new RemoteUrlError('Enter a host URL');
      const url = normalizeHostUrl(raw);
      const who = await deps.backend.clientFor(url).whoami();
      const existing = (await deps.readManifest(who.workspace.id)) !== null;
      return {
        ok: true,
        url,
        workspace: who.workspace,
        user: { login: who.user.login, name: who.user.name, avatarUrl: who.user.avatarUrl },
        tier: who.tier,
        warning: plainHttpWarning(url),
        existing
      };
    } catch (err) {
      return classify(err, deps);
    }
  }

  ipc.handle('remote:probe', (_e, url: unknown) => probe(url));

  ipc.handle('remote:add', async (_e, url: unknown): Promise<RemoteProbe> => {
    const p = await probe(url);
    if (!p.ok) return p;
    const prior = await deps.readManifest(p.workspace.id);
    if (prior && prior.kind !== 'remote') {
      return { ok: false, kind: 'protocol', message: `Workspace id ${p.workspace.id} already belongs to a local workspace` };
    }
    const t = now();
    const spec: WorkspaceSpec = prior
      ? { ...prior, remote: { url: p.url, tier: p.tier, login: p.user.login, checkedAt: t } }
      : {
          id: p.workspace.id,
          name: await uniqueName(p.workspace.name, p.workspace.id, deps),
          description: p.workspace.description ?? undefined,
          labels: [],
          color: p.workspace.color ?? undefined,
          workspaceRoot: '',
          workspaceSubdir: '',
          kind: 'remote',
          authMode: 'oauth',
          env: { plain: {}, secretKeys: [] },
          mirror: FACTORY_MIRROR,
          remote: { url: p.url, tier: p.tier, login: p.user.login, checkedAt: t },
          createdAt: t,
          lastUsedAt: t
        };
    await deps.writeManifest(spec);
    deps.invalidate();
    return { ...p, existing: prior !== null };
  });

  ipc.handle('remote:liveSessions', async (_e, id: unknown): Promise<Array<{ id: string; alive: boolean }>> => {
    const m = typeof id === 'string' ? await deps.readManifest(id) : null;
    if (!m?.remote) throw new Error('Not a remote workspace');
    return deps.backend.clientFor(m.remote.url).rpc('sessions:live', []);
  });

  ipc.handle('remote:rename', async (_e, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) throw new Error('A name is required');
    const m = await deps.readManifest(id);
    if (!m || m.kind !== 'remote') throw new Error('Not a remote workspace');
    const clash = await deps.findByName(name.trim());
    if (clash && clash.id !== id) throw new Error(`A workspace named "${name.trim()}" already exists.`);
    await deps.writeManifest({ ...m, name: name.trim() });
    deps.invalidate();
  });
}
```

The wiring:

```diff
diff --git a/src/main/ipc.ts b/src/main/ipc.ts
index 8091914..335cca5 100644
--- a/src/main/ipc.ts
+++ b/src/main/ipc.ts
@@ -2,11 +2,11 @@ import { app, ipcMain, BrowserWindow, dialog, clipboard, Menu, shell, powerMonit
 import { appBuildSha, appVersionString } from './appVersion.js';
 import { randomUUID } from 'node:crypto';
 import { existsSync } from 'node:fs';
-import { unlink, readdir } from 'node:fs/promises';
+import { unlink, readdir, rm } from 'node:fs/promises';
 import { execFile } from 'node:child_process';
 import { promisify } from 'node:util';
 import { homedir } from 'node:os';
-import { workspaceTranscriptPath, workspaceHistoryFile, workspaceHistoryDir, encodeClaudeProjectDir, workspaceClaudeSessionsDir, hostLocalSessionsDir, workspaceClaudeDir } from './paths.js';
+import { workspaceTranscriptPath, workspaceHistoryFile, workspaceHistoryDir, encodeClaudeProjectDir, workspaceClaudeSessionsDir, hostLocalSessionsDir, workspaceClaudeDir, workspaceStateDir } from './paths.js';
 import { createWorkspaceSkills, toSkillWorkspace } from './skills/workspaceSkills.js';
 import {
   setWorkspaceDefault,
@@ -79,6 +79,8 @@ import { registerVaultIpc } from './vaultIpc.js';
 import { IdentityService } from './identity/identityService.js';
 import { pickGithubClientId, GITHUB_CLIENT_ID_ENV } from './identity/clientId.js';
 import { registerIdentityIpc } from './identityIpc.js';
+import { createRemoteBackend } from './remote.js';
+import { registerRemoteIpc } from './remoteIpc.js';
 import { listEndpoints, saveEndpoint, deleteEndpoint, setEndpointApiKey, probeEndpoint, getEndpoint, type ModelEndpoint } from './endpoints.js';
 import * as fs from './fs.js';
 import * as imageLibrary from './imageLibrary.js';
@@ -292,9 +294,18 @@ const mockPorts: MockServingPorts | null = MOCK_MODE && process.env.CLAUDE_FLEET
 // `Backend` contract. In mock mode everything routes to the mock backend.
 const dockerBackend: Backend = MOCK_MODE ? mockDocker : realDocker;
 const localBackend: Backend = MOCK_MODE ? mockDocker : realLocal;
+// Bound to the signed-in GitHub token once registerIpc builds the identity service.
+let remoteToken: () => Promise<string | null> = async () => null;
+const remoteBackend = createRemoteBackend({
+  token: () => remoteToken(),
+  listManifests: () => listWorkspaceManifests(),
+  writeManifest: (spec) => writeWorkspaceManifest(spec),
+  deleteState: (id) => rm(workspaceStateDir(id), { recursive: true, force: true })
+});
 
 function backendForKind(kind: WorkspaceKind): Backend {
   if (MOCK_MODE) return mockDocker;
+  if (kind === 'remote') return remoteBackend;
   return kind === 'local' ? localBackend : dockerBackend;
 }
 
@@ -414,7 +425,7 @@ async function fetchAllWorkspaces(): Promise<Workspace[]> {
   const dockerPromise: Promise<Workspace[]> = e2eDockerDown
     ? Promise.reject(Object.assign(new Error('docker daemon down (e2e)'), { code: 'ECONNREFUSED' }))
     : dockerBackend.listLiveWorkspaces();
-  const [dockerResult, localLive, manifests] = await Promise.all([
+  const [dockerResult, localLive, remoteLive, manifests] = await Promise.all([
     dockerPromise.then(
       (value): PromiseSettledResult<Workspace[]> => ({ status: 'fulfilled', value }),
       (reason): PromiseSettledResult<Workspace[]> => ({ status: 'rejected', reason })
@@ -423,10 +434,11 @@ async function fetchAllWorkspaces(): Promise<Workspace[]> {
     // docker half down, container-kind mocks must not sneak back in as live
     // through the local half.
     localBackend.listLiveWorkspaces().then((ws) => (e2eDockerDown ? ws.filter((w) => w.kind === 'local') : ws)),
+    MOCK_MODE ? Promise.resolve([]) : remoteBackend.listLiveWorkspaces(),
     listWorkspaceManifests()
   ]);
   return mergeWorkspaces({
-    dockerResult, localLive, manifests,
+    dockerResult, localLive, remoteLive, manifests,
     lastKnown: lastKnownStates,
     privateDir: fleetPrivateDir,
     factoryMirror: FACTORY_MIRROR
@@ -1902,6 +1914,15 @@ export function registerIpc(opts: RegisterIpcOpts = { jsonlWatcher: null }): voi
       pickGithubClientId({ env: process.env[GITHUB_CLIENT_ID_ENV], config: await getGithubClientIdConfig() })
   });
   registerIdentityIpc(ipcMain, identity);
+  remoteToken = () => identity.bearerToken();
+  registerRemoteIpc(ipcMain, {
+    backend: remoteBackend,
+    accountStatus: () => identity.status(),
+    readManifest: readWorkspaceManifest,
+    writeManifest: writeWorkspaceManifest,
+    findByName: findWorkspaceByName,
+    invalidate: invalidateWorkspaceList
+  });
   loadoutSources.setGithubTokenProvider(() => identity.packagesToken());
 
   ipcMain.handle(
diff --git a/src/preload/index.ts b/src/preload/index.ts
index 8df0087..63264b1 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -13,6 +13,8 @@ export type {
 } from './inboxTypes';
 import type { AccountStatus, SignInStart, SignInPoll } from './identityTypes';
 export type { AccountStatus, AccountIdentity, AccountSso, SignInStart, SignInPoll } from './identityTypes';
+import type { RemoteProbe } from './remoteTypes';
+export type { RemoteProbe, RemoteProbeOk, RemoteProbeErr, RemoteTier } from './remoteTypes';
 
 /** Outcome of a `pty:resize`. Lives here because preload is the IPC contract
  *  surface: main imports it type-only, and the renderer picks it up through
@@ -701,6 +703,16 @@ const api = {
     /** Delete the token from this computer's vault. */
     signOut: (): Promise<void> => ipcRenderer.invoke('identity:signOut')
   },
+  remote: {
+    /** /whoami a host URL with the signed-in token; never returns the token. */
+    probe: (url: string): Promise<RemoteProbe> => ipcRenderer.invoke('remote:probe', url),
+    /** Probe, then write the bookmark manifest under the host's workspace id. */
+    add: (url: string): Promise<RemoteProbe> => ipcRenderer.invoke('remote:add', url),
+    /** Rename the local bookmark; the host's name is unchanged. */
+    rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('remote:rename', id, name),
+    /** Broker sessions live on the host (any tier may watch them). */
+    liveSessions: (id: string): Promise<Array<{ id: string; alive: boolean }>> => ipcRenderer.invoke('remote:liveSessions', id)
+  },
   endpoints: {
     list: (): Promise<unknown[]> => ipcRenderer.invoke('endpoints:list'),
     save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('endpoints:save', input),
diff --git a/tsconfig.web.json b/tsconfig.web.json
index 7252bff..6aaf177 100644
--- a/tsconfig.web.json
+++ b/tsconfig.web.json
@@ -13,5 +13,5 @@
     "allowSyntheticDefaultImports": true,
     "types": ["vite/client"]
   },
-  "include": ["src/renderer/src/**/*.ts", "src/renderer/src/**/*.tsx", "src/preload/inboxTypes.ts", "src/preload/identityTypes.ts"]
+  "include": ["src/renderer/src/**/*.ts", "src/renderer/src/**/*.tsx", "src/preload/inboxTypes.ts", "src/preload/identityTypes.ts", "src/preload/remoteTypes.ts"]
 }
```

- [ ] **Step 4: Run, typecheck and grep**

```bash
npx vitest run src/main/remoteIpc.test.ts
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
/usr/bin/grep -n "bearerToken\|remoteToken" src/main/ipc.ts src/preload/index.ts
```

Expected:
- PASS (11 tests);
- no tsc output;
- the grep finds `bearerToken`/`remoteToken` only in `ipc.ts`. Nothing in preload returns a token.

- [ ] **Step 5: Commit**

```bash
git add src/main/remoteIpc.ts src/main/remoteIpc.test.ts src/preload/remoteTypes.ts src/main/ipc.ts src/preload/index.ts tsconfig.web.json
git commit -m "feat(remote): remote:* IPC (probe, add, rename, liveSessions) and backend routing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add a remote workspace (the `+` modal's Remote kind)

**Files:**
- Create: `src/renderer/src/remoteView.ts`, `src/renderer/src/remoteView.test.ts`, `src/renderer/src/components/RemoteWorkspaceForm.tsx`
- Modify: `src/renderer/src/components/AccountSettings.tsx`, `WorkspaceForm.tsx`, `WorkspaceModal.tsx`, and in `App.tsx` the `WorkspaceKind`/`WorkspaceSummary` types and the `WorkspaceModal` `onRemoteAdded` prop

**Interfaces:**
- Consumes: `window.api.remote.probe/add` (Task 6); `window.api.identity.status`.
- Produces:
  - from `remoteView.ts`: `canType(t)`, `canStartSessions(t)`, `tierTitle(t)`, `unreachableBanner(names)`, `probeErrorText(err)`
  - `<RemoteWorkspaceForm onAdded onCancel>`
  - `WorkspaceForm`'s `onRemoteAdded?` prop
  - `AccountSettings`'s `onStatus?` prop

- [ ] **Step 1: Write the failing test** — `src/renderer/src/remoteView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canStartSessions, canType, probeErrorText, tierTitle, unreachableBanner } from './remoteView';

describe('remote tier rules', () => {
  it('only steer and session type; only session starts sessions', () => {
    expect([canType('read'), canType('steer'), canType('session'), canType(null)]).toEqual([false, true, true, false]);
    expect([canStartSessions('read'), canStartSessions('steer'), canStartSessions('session'), canStartSessions(undefined)]).toEqual([false, false, true, false]);
  });

  it('titles every tier', () => {
    expect(tierTitle('read')).toMatch(/watch/);
    expect(tierTitle(null)).toMatch(/unknown/);
  });
});

describe('unreachableBanner', () => {
  it('names one or several hosts', () => {
    expect(unreachableBanner([])).toBeNull();
    expect(unreachableBanner(['review-bot'])).toBe("review-bot unreachable: its sessions and automations are hidden until it's back");
    expect(unreachableBanner(['a', 'b'])).toMatch(/^a, b unreachable: their/);
  });
});

describe('probeErrorText', () => {
  it('adds the network hint for unreachable hosts', () => {
    expect(probeErrorText({ ok: false, kind: 'unreachable', message: 'x is not reachable' })).toMatch(/VPN/);
    expect(probeErrorText({ ok: false, kind: 'forbidden', message: 'ask admins' })).toBe('ask admins');
  });
});
```

Run: `npx vitest run src/renderer/src/remoteView.test.ts`
Expected: FAIL, unresolved `./remoteView`.

- [ ] **Step 2: Implement the copy** — `src/renderer/src/remoteView.ts`:

```ts
// Pure copy and tier rules for remote workspaces. Display only: the host
// enforces every tier.
import type { RemoteProbeErr, RemoteTier } from '../../preload/remoteTypes';

export type MaybeTier = RemoteTier | null | undefined;

export const canType = (t: MaybeTier): boolean => t === 'steer' || t === 'session';
export const canStartSessions = (t: MaybeTier): boolean => t === 'session';

export function tierTitle(t: MaybeTier): string {
  switch (t) {
    case 'read':
      return 'read: you can watch sessions but not type';
    case 'steer':
      return 'steer: you can type into sessions';
    case 'session':
      return 'session: you can start and close your own sessions';
    default:
      return 'tier unknown until the host answers';
  }
}

/** Banner text for unreachable remote workspaces, or null when none are. */
export function unreachableBanner(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} unreachable: its sessions and automations are hidden until it's back`;
  return `${names.join(', ')} unreachable: their sessions and automations are hidden until they're back`;
}

export function probeErrorText(e: RemoteProbeErr): string {
  switch (e.kind) {
    case 'unreachable':
      return `Not reachable. Check your network or VPN. (${e.message})`;
    case 'not-signed-in':
      return 'Sign in with GitHub first.';
    default:
      return e.message;
  }
}
```

Run it again. Expected: PASS (4 tests).

- [ ] **Step 3: The form** — `src/renderer/src/components/RemoteWorkspaceForm.tsx`:

```tsx
// The + modal's Remote kind: sign in, check a host URL, bookmark it.
import { useCallback, useEffect, useState } from 'react';
import type { AccountStatus, RemoteProbe } from '../../../preload';
import { probeErrorText, tierTitle } from '../remoteView';
import { AccountSettings } from './AccountSettings';

export function RemoteWorkspaceForm({ onAdded, onCancel }: { onAdded: (id: string) => void; onCancel: () => void }) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<RemoteProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const onStatus = useCallback((s: AccountStatus) => setAccount(s), []);

  useEffect(() => {
    void window.api.identity.status().then(setAccount);
  }, []);

  async function check(): Promise<void> {
    setBusy(true);
    try {
      setProbe(await window.api.remote.probe(url));
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    setBusy(true);
    try {
      const r = await window.api.remote.add(url);
      setProbe(r);
      if (r.ok) onAdded(r.workspace.id);
    } finally {
      setBusy(false);
    }
  }

  if (account && !account.signedIn) {
    return (
      <div className="remote-form">
        <p className="form-help">Remote workspaces check who you are with your GitHub sign-in. One sign-in serves every host.</p>
        <AccountSettings onStatus={onStatus} />
      </div>
    );
  }

  return (
    <div className="remote-form">
      <div className="form-row">
        <label htmlFor="remote-url">Host URL</label>
        <input
          id="remote-url"
          type="url"
          placeholder="https://review-bot.example.com"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setProbe(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim()) void check();
          }}
          disabled={busy}
        />
      </div>
      {probe?.ok && (
        <div className="remote-probe">
          <div className="remote-probe-name">{probe.workspace.name}</div>
          {probe.workspace.description && <div className="remote-probe-desc">{probe.workspace.description}</div>}
          <div>
            Signed in as @{probe.user.login} · your tier:{' '}
            <span className={`tier-badge tier-${probe.tier}`} title={tierTitle(probe.tier)}>
              {probe.tier}
            </span>
          </div>
          {probe.existing && <div className="form-help">Already added; adding again updates its URL.</div>}
          {probe.warning && <div className="form-warning">{probe.warning}</div>}
        </div>
      )}
      {probe && !probe.ok && (
        <div className="form-error" role="alert">
          {probeErrorText(probe)}
          {probe.ssoUrl && (
            <>
              {' '}
              <a href={probe.ssoUrl} target="_blank" rel="noreferrer">
                Authorise on GitHub
              </a>
            </>
          )}
        </div>
      )}
      <div className="form-footer">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {probe?.ok ? (
          <button className="btn primary" onClick={() => void add()} disabled={busy}>
            Add workspace
          </button>
        ) : (
          <button className="btn primary" onClick={() => void check()} disabled={busy || !url.trim()}>
            Check host
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Thread it through**

```diff
diff --git a/src/renderer/src/components/AccountSettings.tsx b/src/renderer/src/components/AccountSettings.tsx
index c8005fe..9ebc7cd 100644
--- a/src/renderer/src/components/AccountSettings.tsx
+++ b/src/renderer/src/components/AccountSettings.tsx
@@ -8,8 +8,11 @@ interface ActiveRun extends SignInRun {
   wake: () => void;
 }
 
-export function AccountSettings() {
+export function AccountSettings({ onStatus }: { onStatus?: (s: AccountStatus) => void } = {}) {
   const [status, setStatus] = useState<AccountStatus | null>(null);
+  useEffect(() => {
+    if (status) onStatus?.(status);
+  }, [status, onStatus]);
   const [flow, setFlow] = useState<SignInStart | null>(null);
   const [signingIn, setSigningIn] = useState(false);
   const [error, setError] = useState<string | null>(null);
diff --git a/src/renderer/src/components/WorkspaceForm.tsx b/src/renderer/src/components/WorkspaceForm.tsx
index a862b4f..d6fd787 100644
--- a/src/renderer/src/components/WorkspaceForm.tsx
+++ b/src/renderer/src/components/WorkspaceForm.tsx
@@ -8,6 +8,7 @@
 // place).
 
 import type { ReactNode } from 'react';
+import { RemoteWorkspaceForm } from './RemoteWorkspaceForm';
 import { useEffect, useMemo, useState } from 'react';
 import type {
   AuthMode,
@@ -176,6 +177,8 @@ interface Props {
   /** Opens the app Settings modal on a tab — used by "＋ Add endpoint…" and
    *  the endpoint auth note's "edit" link. Threaded from App.tsx. */
   onOpenSettings?: (tab: 'endpoints') => void;
+  /** Create mode: offers the Remote kind; called with the bookmarked workspace id. */
+  onRemoteAdded?: (id: string) => void;
 }
 
 export function WorkspaceForm({
@@ -191,8 +194,10 @@ export function WorkspaceForm({
   deleteDisabledReason,
   primaryLabel: primaryLabelOverride,
   extraFooterLeft,
-  onOpenSettings
+  onOpenSettings,
+  onRemoteAdded
 }: Props) {
+  const [remoteMode, setRemoteMode] = useState(false);
   const [name, setName] = useState(initial?.name ?? '');
   const [description, setDescription] = useState(initial?.description ?? '');
   const [labelInput, setLabelInput] = useState('');
@@ -632,38 +637,65 @@ export function WorkspaceForm({
   const swatchStyle = hue !== null ? { background: `oklch(72% 0.14 ${hue})` } : undefined;
   const primaryLabel = primaryLabelOverride ?? (mode === 'create' ? 'Create & start' : 'Resume');
 
-  return (
-    <div className="workspace-form">
-      <div className="form-row" aria-label="Workspace kind">
-        <label>Type</label>
-        <div className="kind-radios" role="radiogroup">
-          <label className={`kind-radio ${kind === 'container' ? 'active' : ''}`}>
-            <input
-              type="radio"
-              name="workspace-kind"
-              value="container"
-              checked={kind === 'container'}
-              onChange={() => setKind('container')}
-              disabled={busy || dockerUp === false}
-            />
-            <span>Container</span>
-            <span className="kind-help">isolated Docker runner</span>
-            {dockerUp === false && <span className="kind-hint">needs Docker — daemon unreachable</span>}
-          </label>
-          <label className={`kind-radio ${kind === 'local' ? 'active' : ''}`}>
+  const kindRow = (
+    <div className="form-row" aria-label="Workspace kind">
+      <label>Type</label>
+      <div className="kind-radios" role="radiogroup">
+        <label className={`kind-radio ${!remoteMode && kind === 'container' ? 'active' : ''}`}>
+          <input
+            type="radio"
+            name="workspace-kind"
+            value="container"
+            checked={!remoteMode && kind === 'container'}
+            onChange={() => { setRemoteMode(false); setKind('container'); }}
+            disabled={busy || dockerUp === false}
+          />
+          <span>Container</span>
+          <span className="kind-help">isolated Docker runner</span>
+          {dockerUp === false && <span className="kind-hint">needs Docker — daemon unreachable</span>}
+        </label>
+        <label className={`kind-radio ${!remoteMode && kind === 'local' ? 'active' : ''}`}>
+          <input
+            type="radio"
+            name="workspace-kind"
+            value="local"
+            checked={!remoteMode && kind === 'local'}
+            onChange={() => { setRemoteMode(false); setKind('local'); }}
+            disabled={busy}
+          />
+          <span>Local</span>
+          <span className="kind-help">runs claude on this host</span>
+        </label>
+        {mode === 'create' && onRemoteAdded && (
+          <label className={`kind-radio ${remoteMode ? 'active' : ''}`}>
             <input
               type="radio"
               name="workspace-kind"
-              value="local"
-              checked={kind === 'local'}
-              onChange={() => setKind('local')}
+              value="remote"
+              checked={remoteMode}
+              onChange={() => setRemoteMode(true)}
               disabled={busy}
             />
-            <span>Local</span>
-            <span className="kind-help">runs claude on this host</span>
+            <span>Remote</span>
+            <span className="kind-help">a fleet-host someone deployed</span>
           </label>
-        </div>
+        )}
       </div>
+    </div>
+  );
+
+  if (remoteMode && onRemoteAdded) {
+    return (
+      <div className="workspace-form">
+        {kindRow}
+        <RemoteWorkspaceForm onAdded={onRemoteAdded} onCancel={onCancel} />
+      </div>
+    );
+  }
+
+  return (
+    <div className="workspace-form">
+      {kindRow}
 
       {kind === 'local' && (
         <>
diff --git a/src/renderer/src/components/WorkspaceModal.tsx b/src/renderer/src/components/WorkspaceModal.tsx
index 6b2f87d..0f3aef9 100644
--- a/src/renderer/src/components/WorkspaceModal.tsx
+++ b/src/renderer/src/components/WorkspaceModal.tsx
@@ -45,6 +45,8 @@ interface Props {
   initialNewTabValues?: Partial<WorkspaceFormSubmit & { id: string }> | null;
   /** Open Settings modal on a specific tab (e.g. deep-link to Model Endpoints). */
   onOpenSettings?: (tab: 'endpoints') => void;
+  /** A remote workspace was bookmarked from the New tab. */
+  onRemoteAdded?: (id: string) => void;
 }
 
 /**
@@ -94,7 +96,8 @@ export function WorkspaceModal({
   onClone,
   onDelete,
   initialNewTabValues,
-  onOpenSettings
+  onOpenSettings,
+  onRemoteAdded
 }: Props) {
   // Saved tab = the "cold" fleet: stopped, deleted, and unreachable-was-cold
   // workspaces (#21, #380). Unreachable-was-warm chips stay in the strip
@@ -406,6 +409,7 @@ export function WorkspaceModal({
               onSubmit={handleCreate}
               onCancel={onClose}
               onOpenSettings={onOpenSettings}
+              onRemoteAdded={onRemoteAdded}
             />
           </div>
         )}
```

The `App.tsx` hunks for this task are the `WorkspaceKind`/`remote` type lines, the imports and the `onRemoteAdded` block of the full diff in Task 8. Apply the whole `App.tsx` diff in Task 8. Until then, add only:
- `| 'remote'` to `WorkspaceKind`;
- the `remote?:` field on `WorkspaceSummary`, with `import type { RemoteTier } from '../../preload/remoteTypes';`;
- the `onRemoteAdded={…}` prop on `<WorkspaceModal>`.

That keeps this commit compiling.

- [ ] **Step 5: Typecheck and test**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/renderer`
Expected: no tsc output; all renderer tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/remoteView.ts src/renderer/src/remoteView.test.ts src/renderer/src/components/RemoteWorkspaceForm.tsx src/renderer/src/components/AccountSettings.tsx src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/components/WorkspaceModal.tsx src/renderer/src/App.tsx
git commit -m "feat(remote): add a remote workspace from the + modal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The remote chip (glyph, tier badge, ⋮ menu)

**Files:**
- Create: `src/renderer/src/components/RenameRemoteModal.tsx`
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx`, `src/renderer/src/App.tsx` (the rest of its diff), `src/renderer/src/components/committee.tsx`, `src/renderer/src/components/formInitial.ts`

**Interfaces:**
- Consumes: `window.api.remote.rename`, `window.api.workspace.remove`, `window.api.clipboard.write`; `tierTitle` (Task 7).
- Produces:
  - `WorkspaceTabStrip`'s `onRenameRemote?` prop
  - `<RenameRemoteModal id name onClose>`

- [ ] **Step 1: Implement**

`src/renderer/src/components/RenameRemoteModal.tsx`:

```tsx
// Rename a remote bookmark on this computer only; the host keeps its name.
import { useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';

export function RenameRemoteModal({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await window.api.remote.rename(id, draft);
      onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" role="dialog" aria-label="Rename locally" onClick={(e) => e.stopPropagation()}>
        <h2>Rename locally</h2>
        <p className="form-hint">Only this computer sees the new name.</p>
        <input
          aria-label="Name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) void save();
          }}
          autoFocus
        />
        {error && <p className="form-hint error-text">{error}</p>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
```

```diff
diff --git a/src/renderer/src/components/WorkspaceTabStrip.tsx b/src/renderer/src/components/WorkspaceTabStrip.tsx
index 04fa589..91e4c32 100644
--- a/src/renderer/src/components/WorkspaceTabStrip.tsx
+++ b/src/renderer/src/components/WorkspaceTabStrip.tsx
@@ -1,4 +1,5 @@
 import { useState, type ReactNode } from 'react';
+import { tierTitle } from '../remoteView';
 import { createPortal } from 'react-dom';
 import type { WorkspaceObservabilitySummary } from '../../../preload';
 import { colorFor, type WorkspaceState, type WorkspaceSummary } from '../App';
@@ -66,6 +67,8 @@ interface Props {
   onReorderWorkspace: (draggedId: string, targetId: string) => void;
   /** Per-workspace waiting flag: true when the workspace has a session blocked on AskUserQuestion. */
   waitingByWorkspace?: Record<string, boolean>;
+  /** Remote chips' ⋮ Rename locally (App opens the rename dialog). */
+  onRenameRemote?: (workspace: WorkspaceSummary) => void;
   /** The Inbox chip (#407), rendered after the workspace chips, before the add button. */
   inboxChip?: ReactNode;
 }
@@ -123,6 +126,7 @@ export function WorkspaceTabStrip({
   onDeleteWorkspace,
   onRefresh,
   onReorderWorkspace,
+  onRenameRemote,
   inboxChip
 }: Props) {
   // Chip ⋮ menu — shared portaled-menu mechanics (right-anchored).
@@ -218,10 +222,18 @@ export function WorkspaceTabStrip({
               */}
               <span className={`ws-chip-sub ${busy || waiting ? 'busy' : ''}`}>
                 {unreachable
-                  ? `unreachable${w.lastKnownState ? ` · was ${w.lastKnownState}` : ''}`
+                  ? w.kind === 'remote' ? 'host unreachable' : `unreachable${w.lastKnownState ? ` · was ${w.lastKnownState}` : ''}`
                   : waiting ? 'needs input' : busy ? 'working…' : chipActivityText(summaries[w.id]) ?? ' '}
               </span>
             </span>
+            {w.kind === 'remote' && (
+              <span className="ws-chip-roles">
+                <CloudGlyph title={`Remote · ${w.remote?.url ?? ''}`} />
+                <span className={`tier-badge tier-${w.remote?.tier ?? 'unknown'}`} title={tierTitle(w.remote?.tier)}>
+                  {w.remote?.tier ?? '?'}
+                </span>
+              </span>
+            )}
             {(isManager(w) || isReachable(w)) && (
               <span className="ws-chip-roles">
                 {isManager(w) && (
@@ -231,7 +243,7 @@ export function WorkspaceTabStrip({
               </span>
             )}
           </button>
-          {!unreachable && (
+          {(!unreachable || w.kind === 'remote') && (
             <button
               className="ws-chip-menu-trigger"
               aria-label={`Actions for ${w.name}`}
@@ -296,6 +308,44 @@ export function WorkspaceTabStrip({
             style={{ position: 'fixed', top: menu.top, right: menu.right }}
             onClick={(e) => e.stopPropagation()}
           >
+            {menuWorkspace.kind === 'remote' ? (
+              <>
+                <button
+                  role="menuitem"
+                  onClick={() => {
+                    closeMenu();
+                    onRenameRemote?.(menuWorkspace);
+                  }}
+                >
+                  <IconPencil />
+                  <span>Rename locally…</span>
+                </button>
+                <button
+                  role="menuitem"
+                  onClick={() => {
+                    closeMenu();
+                    void window.api.clipboard.write(menuWorkspace.remote?.url ?? '');
+                  }}
+                >
+                  <IconCopy />
+                  <span>Copy host URL</span>
+                </button>
+                <div className="ws-chip-menu-divider" />
+                <button
+                  role="menuitem"
+                  className="danger"
+                  title="Remove the bookmark from this computer; the host is untouched"
+                  onClick={() => {
+                    closeMenu();
+                    void window.api.workspace.remove(menuWorkspace.id, { id: menuWorkspace.id }).finally(onRefresh);
+                  }}
+                >
+                  <IconEject />
+                  <span>Forget</span>
+                </button>
+              </>
+            ) : (
+            <>
             {menuWorkspace.state === 'running' && (
               <>
                 {(menuWorkspace.kind !== 'local' || menuWorkspace.launcher?.mode === 'wsl') && (
@@ -367,9 +417,26 @@ export function WorkspaceTabStrip({
               <IconTrash />
               <span>Delete…</span>
             </button>
+            </>
+            )}
           </div>,
           document.body
         )}
     </div>
   );
 }
+
+function CloudGlyph({ title }: { title: string }): React.JSX.Element {
+  return (
+    <svg className="committee-glyph cloud" width={14} height={14} viewBox="0 0 16 16" aria-hidden={!title}>
+      <title>{title}</title>
+      <path
+        d="M4.5 12.5h7a3 3 0 00.4-5.97A4 4 0 004.3 7.1 2.7 2.7 0 004.5 12.5z"
+        stroke="currentColor"
+        strokeWidth="1.3"
+        fill="none"
+        strokeLinejoin="round"
+      />
+    </svg>
+  );
+}
diff --git a/src/renderer/src/components/committee.tsx b/src/renderer/src/components/committee.tsx
index 1aefd67..30f3575 100644
--- a/src/renderer/src/components/committee.tsx
+++ b/src/renderer/src/components/committee.tsx
@@ -11,7 +11,7 @@ export const COMMITTEE_VERBS: CommitteeVerb[] = ['read', 'post', 'pause'];
 /** Minimal shape the helpers need (a WorkspaceSummary structurally satisfies it). */
 export interface CommitteeFields {
   id: string;
-  kind: 'container' | 'local';
+  kind: 'container' | 'local' | 'remote';
   control?: ControlConfig;
   accessibility?: AccessibilityConfig;
 }
diff --git a/src/renderer/src/components/formInitial.ts b/src/renderer/src/components/formInitial.ts
index b76928e..adbb8be 100644
--- a/src/renderer/src/components/formInitial.ts
+++ b/src/renderer/src/components/formInitial.ts
@@ -28,7 +28,7 @@ export function workspaceToFormInitial(
     labels: w.labels,
     color: w.color,
     workspaceSubdir: w.workspaceSubdir,
-    kind: w.kind,
+    kind: w.kind === 'remote' ? 'container' : w.kind,
     workspaceRoot: w.workspaceRoot,
     launcher: w.launcher,
     terminalRenderer: w.terminalRenderer,
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index eaff602..22a9c9e 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -1,4 +1,7 @@
 import { useEffect, useState, useCallback, useRef, useReducer, useMemo } from 'react';
+import { unreachableBanner } from './remoteView';
+import { RenameRemoteModal } from './components/RenameRemoteModal';
+import type { RemoteTier } from '../../preload/remoteTypes';
 import { usePorts } from './usePorts';
 import { useServingSessionNames } from './useServingSessionNames';
 import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
@@ -51,7 +54,7 @@ function makeLifecycleApi(): WorkspaceLifecycleApi {
 }
 
 export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted' | 'unreachable';
-export type WorkspaceKind = 'container' | 'local';
+export type WorkspaceKind = 'container' | 'local' | 'remote';
 export type AuthMode = 'oauth' | 'apikey' | 'endpoint';
 
 export interface WorkspaceColor {
@@ -140,6 +143,8 @@ export interface WorkspaceSummary {
   accessibility?: AccessibilityConfig;
   /** Host-private inbox permissions (#407). */
   inbox?: InboxConfig;
+  /** kind 'remote' only: the fleet-host bookmark (tier is display only). */
+  remote?: { url: string; tier: RemoteTier | null; login: string | null; checkedAt: number };
   createdAt: number;
   lastUsedAt: number;
 }
@@ -301,6 +306,7 @@ export function App() {
   const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
   const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
   const [editTargetId, setEditTargetId] = useState<string | null>(null);
+  const [renameRemoteId, setRenameRemoteId] = useState<string | null>(null);
   // When the user clicks Clone (Saved-row footer, chip menu, or
   // EditWorkspaceModal), the source spec lands here and the modal
   // reopens on the New tab pre-filled. Cleared when modal closes.
@@ -1321,7 +1327,7 @@ export function App() {
       labels: source.labels,
       color: undefined, // fresh hue
       workspaceSubdir: source.workspaceSubdir,
-      kind: source.kind,
+      kind: source.kind === 'remote' ? 'container' : source.kind,
       workspaceRoot: source.workspaceRoot,
       launcher: source.launcher,
       image: source.image,
@@ -1407,11 +1413,15 @@ export function App() {
     [busyBrokerByWorkspace, claudeMappings, peerStatus]
   );
 
+  const remoteBanner = unreachableBanner(
+    workspaces.filter((w) => w.kind === 'remote' && w.state === 'unreachable').map((w) => w.name)
+  );
+
   return (
     <div
       className={`app${dragging ? ' dragging' : ''}${
         backendReady === false ? ' daemon-down' : ''
-      }`}
+      }${remoteBanner ? ' remote-down' : ''}`}
     >
       <WorkspaceTabStrip
         workspaces={roleWsId ? workspaces.filter((w) => w.id !== roleWsId) : workspaces}
@@ -1433,6 +1443,7 @@ export function App() {
         onDeleteWorkspace={(w) => setDeleteTargetId(w.id)}
         onRefresh={refresh}
         onReorderWorkspace={handleReorderWorkspaces}
+        onRenameRemote={(w) => setRenameRemoteId(w.id)}
         waitingByWorkspace={waitingByWorkspaceFlag}
       />
 
@@ -1443,6 +1454,12 @@ export function App() {
           can&apos;t be started or attached until it&apos;s back.
         </div>
       )}
+      {remoteBanner && (
+        <div className="daemon-banner remote-banner" role="status">
+          <span className="dot" aria-hidden="true" />
+          {remoteBanner}
+        </div>
+      )}
 
       <div
         className={`app-body${leftCollapsed ? ' left-collapsed' : ''}${
@@ -1509,6 +1526,14 @@ export function App() {
               />
             ) : liveCount === 0 ? (
               <FirstRun onNewWorkspace={() => setCreateOpen(true)} />
+            ) : selected?.state === 'unreachable' && selected.kind === 'remote' ? (
+              <div className="empty">
+                <div className="icon-card error">!</div>
+                <h2>Host unreachable</h2>
+                <p>
+                  {selected.name} ({selected.remote?.url}) isn&apos;t answering. Its sessions reappear when it&apos;s back.
+                </p>
+              </div>
             ) : selected?.state === 'unreachable' ? (
               <div className="empty">
                 <div className="icon-card error">!</div>
@@ -1529,6 +1554,7 @@ export function App() {
               .map((w) => (
                 <TerminalPane
                   key={w.id}
+                  remoteTier={w.kind === 'remote' ? w.remote?.tier ?? null : undefined}
                   visible={(!inboxOpen && selectedId === w.id) || (inboxOpen && inboxSection === 'sessions' && w.id === roleWsId)}
                   workspaceId={w.id}
                   mirrorDefault={w.mirror.default}
@@ -1623,7 +1649,26 @@ export function App() {
         onDelete={(w) => setDeleteTargetId(w.id)}
         initialNewTabValues={cloneSource}
         onOpenSettings={(tab) => setSettingsTab(tab)}
+        onRemoteAdded={(id) => {
+          setCreateOpen(false);
+          refresh();
+          setSelectedId(id);
+        }}
       />
+      {(() => {
+        const target = renameRemoteId ? workspaces.find((w) => w.id === renameRemoteId) : undefined;
+        if (!target) return null;
+        return (
+          <RenameRemoteModal
+            id={target.id}
+            name={target.name}
+            onClose={() => {
+              setRenameRemoteId(null);
+              refresh();
+            }}
+          />
+        );
+      })()}
       {(() => {
         if (!editTargetId) return null;
         const target = workspaces.find((w) => w.id === editTargetId);
```

What these hunks do:
- `committee.tsx` and `formInitial.ts` widen `kind` for type compatibility only. A remote chip offers no Edit or Clone, and committee helpers still filter on `kind === 'container'`.
- The `App.tsx` diff also contains Task 9's `remoteTier` prop and Task 10's banner and empty-pane hunks. If you're executing strictly task by task, apply those hunks in their own tasks. Every hunk is independent.

- [ ] **Step 2: Typecheck and test**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/renderer`
Expected: no tsc output; PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/RenameRemoteModal.tsx src/renderer/src/components/WorkspaceTabStrip.tsx src/renderer/src/components/committee.tsx src/renderer/src/components/formInitial.ts src/renderer/src/App.tsx
git commit -m "feat(remote): remote chip with cloud glyph, tier badge and Rename/Copy URL/Forget

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Watch-only tabs, Join…, and New-session gating

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/TerminalSession.tsx`, and in `App.tsx` the `remoteTier={…}` prop on `<TerminalPane>`

**Interfaces:**
- Consumes: `canType`, `canStartSessions`, `tierTitle` (Task 7); `window.api.remote.liveSessions` (Task 6).
- Produces:
  - `TerminalPane`'s `remoteTier?: RemoteTier | null`, which is `undefined` for local and container workspaces;
  - `TerminalSession`'s `readOnly?: boolean`.

- [ ] **Step 1: Implement**

```diff
diff --git a/src/renderer/src/components/TerminalSession.tsx b/src/renderer/src/components/TerminalSession.tsx
index f4998c5..3ec45bd 100644
--- a/src/renderer/src/components/TerminalSession.tsx
+++ b/src/renderer/src/components/TerminalSession.tsx
@@ -112,6 +112,8 @@ interface Props {
    * replays its ring buffer) when it flips back to false on resume. (#18)
    */
   paused?: boolean;
+  /** Remote workspace below `steer`: keystrokes are not sent (the host would refuse them). */
+  readOnly?: boolean;
   /**
    * Called when the PTY signals end-of-life (user `/exit`, claude
    * crash, docker stop, etc.). The parent TerminalPane uses this to
@@ -151,6 +153,7 @@ export function TerminalSession({
   resumeOf,
   visible,
   paused = false,
+  readOnly = false,
   onLifecycleChange,
   onActivityChange,
   reloadToken,
@@ -160,6 +163,8 @@ export function TerminalSession({
   // The live xterm, so effects outside the attach effect can force a repaint
   // without reaching into its closure (#268).
   const termRef = useRef<Terminal | null>(null);
+  const readOnlyRef = useRef(readOnly);
+  readOnlyRef.current = readOnly;
   // Bumped when the user clicks "Start new session" / "Retry" after a
   // session ends. The effect deps on containerId+sessionEpoch, so a new
   // attach happens with a fresh xterm instance (no stale state from the
@@ -632,6 +637,7 @@ export function TerminalSession({
           }
         });
         term.onData((data) => {
+          if (readOnlyRef.current) return;
           // First user keystroke ⇒ they're interacting; cancel any pending
           // repaint nudge so we never inject Ctrl+L into an active session.
           disarmNudge();
diff --git a/src/renderer/src/components/TerminalPane.tsx b/src/renderer/src/components/TerminalPane.tsx
index dc9f3c6..b2cb2df 100644
--- a/src/renderer/src/components/TerminalPane.tsx
+++ b/src/renderer/src/components/TerminalPane.tsx
@@ -14,6 +14,7 @@
 // context is lost; PR2's in-container broker is what preserves that.
 
 import { useEffect, useRef, useState } from 'react';
+import { canStartSessions, canType, tierTitle } from '../remoteView';
 import { createPortal } from 'react-dom';
 import type { WorkspaceObservabilitySummary } from '../../../preload';
 import type { MirrorSetting, CleanupSetting } from '../App';
@@ -51,6 +52,8 @@ function SessionTabDot({ ended, busy, waiting }: { ended: boolean; busy: boolean
 
 interface Props {
   containerId: string;
+  /** Remote workspaces only: the viewer's tier (null until the host answers). Undefined for local/container. */
+  remoteTier?: 'read' | 'steer' | 'session' | null;
   /** ULID — used for sessions.json path and observability lookups. */
   workspaceId: string;
   /** The workspace's durable-mirror defaults (manifest). New tabs inherit
@@ -204,6 +207,7 @@ function uid(): string {
 
 export function TerminalPane({
   containerId,
+  remoteTier,
   workspaceId,
   mirrorDefault,
   cleanupDefault,
@@ -316,7 +320,10 @@ export function TerminalPane({
     (async () => {
       const inv = await window.api.sessions.read(workspaceId);
       if (cancelled) return;
-      if (inv.sessions.length === 0) {
+      if (inv.sessions.length === 0 && remoteTier !== undefined && !canStartSessions(remoteTier)) {
+        setSessions([]);
+        setActiveId('');
+      } else if (inv.sessions.length === 0) {
         const main: Session = { id: uid(), name: 'main', createdAt: Date.now() };
         setSessions([main]);
         setActiveId(main.id);
@@ -372,6 +379,25 @@ export function TerminalPane({
     onActiveTabChange?.(workspaceId, activeId, freshIdsRef.current.has(activeId));
   }, [activeId, workspaceId, onActiveTabChange]);
 
+  const remote = remoteTier !== undefined;
+  const readOnly = remote && !canType(remoteTier);
+  const [joinOpen, setJoinOpen] = useState(false);
+  const [joinable, setJoinable] = useState<Array<{ id: string; alive: boolean }> | null>(null);
+
+  async function openJoin(): Promise<void> {
+    setJoinOpen((o) => !o);
+    setJoinable(null);
+    const live = await window.api.remote.liveSessions(workspaceId).catch(() => []);
+    setJoinable(live.filter((l) => l.alive && !sessions.some((s) => s.id === l.id)));
+  }
+
+  function joinSession(id: string): void {
+    setJoinOpen(false);
+    setSessions((prev) => [...prev, { id, name: `session ${nextNum}`, createdAt: Date.now() }]);
+    setActiveId(id);
+    setNextNum((n) => n + 1);
+  }
+
   function addSession(): void {
     if (!loaded) return;
     const id = uid();
@@ -771,6 +797,7 @@ export function TerminalPane({
                 <span className="session-tab-name">
                   {s.autoName && <span className="session-tab-auto" title="Auto-named from Claude's summary" aria-hidden="true">✦</span>}
                   {s.name}
+                  {readOnly && <span className="session-tab-watching" title={tierTitle(remoteTier)}>watching</span>}
                 </span>
               )}
               <button
@@ -789,15 +816,46 @@ export function TerminalPane({
             </div>
           );
         })}
-        <button
-          className="session-tab-new"
-          onClick={addSession}
-          title="New session in this workspace"
-          aria-label="New session"
-          disabled={!loaded || paused}
-        >
-          +
-        </button>
+        {(!remote || canStartSessions(remoteTier)) && (
+          <button
+            className="session-tab-new"
+            onClick={addSession}
+            title="New session in this workspace"
+            aria-label="New session"
+            disabled={!loaded || paused}
+          >
+            +
+          </button>
+        )}
+        {remote && (
+          <span className="session-join">
+            <button
+              className="session-tab-join"
+              onClick={() => void openJoin()}
+              title="Open a session that is running on the host"
+              aria-haspopup="menu"
+              aria-expanded={joinOpen}
+              disabled={!loaded}
+            >
+              Join…
+            </button>
+            {joinOpen && (
+              <div className="session-join-menu" role="menu">
+                {joinable === null ? (
+                  <div className="session-join-empty">Loading…</div>
+                ) : joinable.length === 0 ? (
+                  <div className="session-join-empty">No other sessions are running on the host.</div>
+                ) : (
+                  joinable.map((l) => (
+                    <button key={l.id} role="menuitem" onClick={() => joinSession(l.id)}>
+                      {l.id}
+                    </button>
+                  ))
+                )}
+              </div>
+            )}
+          </span>
+        )}
         {/* Per-session durable-mirror toggle for the active tab. */}
         <button
           className={`session-mirror-toggle ${activeMirror === 'on' ? 'on' : 'off'}`}
@@ -922,6 +980,7 @@ export function TerminalPane({
             // later in DOM order won the stacking contest.
             visible={visible && s.id === activeId}
             paused={paused}
+            readOnly={readOnly}
             onLifecycleChange={handleLifecycle}
             onActivityChange={handleActivity}
             reloadToken={reloadTargets[s.id] ?? null}
```

- [ ] **Step 2: Typecheck, test, build**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run src/renderer && npm run build`
Expected: no tsc output; PASS; the electron-vite build succeeds, or is env-blocked in the container (see *Global Constraints*). In that case, CI is the gate.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/TerminalSession.tsx src/renderer/src/App.tsx
git commit -m "feat(remote): watch-only tabs, Join… a host session, New session only for the session tier

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The unreachable banner, the empty pane, and styles

**Files:**
- Modify: `src/renderer/src/App.tsx` (the `remoteBanner` hunks and the "Host unreachable" empty pane), `src/renderer/src/styles.css`

- [ ] **Step 1: Implement** (if not already applied with Task 8's `App.tsx` diff)

```diff
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 203e5f3..cc4aab7 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -109,6 +109,13 @@ body {
 .app.daemon-down {
   grid-template-rows: auto auto 1fr auto;
 }
+/* Same extra track for the remote-unreachable banner; both banners need two. */
+.app.remote-down {
+  grid-template-rows: auto auto 1fr auto;
+}
+.app.daemon-down.remote-down {
+  grid-template-rows: auto auto auto 1fr auto;
+}
 
 .app-body {
   display: grid;
@@ -3782,3 +3789,46 @@ button.switch { padding: 0; cursor: pointer; }
 .device-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
 .device-actions a.btn { text-decoration: none; display: inline-flex; align-items: center; }
 .account-notice { color: var(--warn); }
+
+/* Remote workspaces (remote-workspaces §8). */
+.committee-glyph.cloud { color: var(--info); }
+.tier-badge {
+  font-size: 9px;
+  line-height: 1;
+  padding: 2px 4px;
+  border-radius: 3px;
+  border: 1px solid var(--line, #333);
+  color: var(--ink-2);
+  text-transform: lowercase;
+}
+.tier-badge.tier-steer { color: var(--info); }
+.tier-badge.tier-session { color: var(--ok); }
+.session-tab-watching {
+  margin-left: 6px;
+  font-size: 9px;
+  color: var(--ink-2);
+  text-transform: uppercase;
+  letter-spacing: 0.04em;
+}
+.session-join { position: relative; }
+.session-tab-join { font-size: 11px; padding: 2px 8px; }
+.session-join-menu {
+  position: absolute;
+  top: 100%;
+  right: 0;
+  z-index: 20;
+  min-width: 220px;
+  display: flex;
+  flex-direction: column;
+  background: var(--bg-2, #171a22);
+  border: 1px solid var(--line, #333);
+  border-radius: 6px;
+  padding: 4px;
+}
+.session-join-menu button { text-align: left; font-family: var(--mono, monospace); font-size: 11px; padding: 4px 8px; }
+.session-join-empty { padding: 6px 8px; font-size: 11px; color: var(--ink-2); }
+.remote-form { display: flex; flex-direction: column; gap: 10px; }
+.remote-probe { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--line, #333); border-radius: 6px; }
+.remote-probe-name { font-weight: 600; }
+.remote-probe-desc { color: var(--ink-2); }
+.form-warning { color: var(--warn, #e0b050); font-size: 12px; }
```

The `.app.remote-down` grid track mirrors `.app.daemon-down` (#380). Without it, the banner takes the body's `1fr` row.

- [ ] **Step 2: Full gate**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx tsc -p tsconfig.host.json
npx vitest run
```

Expected: no tsc output; all green.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat(remote): unreachable-host banner and pane

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: SPEC.md

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Edit in place:**

- **§6 *Workspace*:** describe `kind: 'remote'` per channel:
  - `workspace:list` includes remote rows (`running`/`unreachable`).
  - `workspace:remove` forgets the bookmark.
  - `start`/`pause`/`stop`/`ensureImage` reject with "managed by its deployment".
  - Add a *Remote* channel block: `remote:probe`, `remote:add`, `remote:rename`, `remote:liveSessions`, their payloads (`RemoteProbe`), and the rule that no response carries a token.
- **§6 *PTY*:** `pty:attach` on a remote workspace opens the host's `/attach`. CREATE happens only for the `session` tier (E2), and no local mapping row is written (E3).
- **§7 *Workspace manifest*:** `WorkspaceKind` gains `'remote'`. Document the `remote: { url, tier, login, checkedAt }` block, sanitized; a remote manifest without it is ignored. Its id is the host's workspace id (E8).
- **§7 *Workspace shape*:** remote rows carry `remote`, `containerId = id` and `workspaceRoot = ''`.
- **§7 *Backend dispatch*:** add `remote.ts`. `resolveKind` routes `'remote'` there. `workspace:list` merges `remoteBackend.listLiveWorkspaces()` (none in mock mode, E11). Tier refresh is E4.
- **§8:**
  - *Create a workspace*: the Remote kind and its errors (unreachable / no grant / SSO / standby / not signed in).
  - *Chip ⋮ menu*: the remote menu (E10).
  - *Attach a terminal*: watch-only tabs, Join…, and New-session gating (E6, E7).
  - Add a *Remote host unreachable* paragraph: dimmed chip, banner, pane text.
- **§9:**
  - `RemoteClient` sends the bearer token only to a URL the user added, never follows redirects (`redirect: 'error'`, `followRedirects: false`), and puts no token in errors.
  - The renderer never sees it (`bearerToken()` is main-only).
  - Plain `http://` to a non-loopback host shows a warning.
- **§10 Project layout:** list `src/host/`, `src/main/remote*.ts` and `src/preload/remoteTypes.ts`.

- [ ] **Step 2: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): remote workspaces on the desktop (kind 'remote', remote:* IPC, chip, watch-only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

## Verification

- **Validated while writing this plan** (in a scratch worktree at `ee75294` with c1 applied):
  - every main-process task compiles and its tests pass against c1's real endpoint;
  - the renderer compiles under `tsconfig.web.json`, and its pure-module tests pass;
  - the full unit suite is green (212 files).
- **Not validated in the container:** Electron runtime behaviour.
- **Troy's host eyeball after merge**, against a `runner-host` started locally with `docker run -p 8080:8080 -v <cfg>:/etc/fleet-host:ro`:
  1. add `http://localhost:8080`;
  2. check the chip badge;
  3. open a tab as `session`;
  4. Join… it from a second account at `read` and confirm it says "watching" and typing does nothing;
  5. stop the container and see the banner and the dimmed chip;
  6. Forget.

## Self-review

- **Spec (c) desktop items:**
  - `remote.ts` → T5;
  - `RemoteClient` → T2;
  - add-remote UX → T6, T7;
  - the chip → T8;
  - watch-only tabs → T9;
  - the unreachable banner → T10;
  - SPEC → T11.
- **Deferred by the spec:** owners on rows and Mine/Everyone are (f); remote automations in the Inbox are (g); federation is (d).
