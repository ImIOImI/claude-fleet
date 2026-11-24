# Signed-out failure mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the desktop's GitHub sign-in is lost or refused, the app shows one banner with an inline device-flow Sign in, a calm card in each remote tab, one notification per involuntary sign-out, and reattaches every remote tab in place after sign-in.

**Architecture:**
- **Main.**
  - A pure monitor (`src/main/remoteAuth.ts`) owns the app-wide `signedOut`, the `epoch`, and per-bookmark connection kinds. It is fed by identity change events, the probe loop, attach failures and `/events` disconnects.
  - It pushes `RemoteAuthState` to the renderer, notifies once per involuntary sign-out, and reconnects every remote connection on sign-in.
- **Renderer.**
  - The renderer renders that state through pure helpers (`signedOutView.ts`), with one shared device-flow controller (`signInFlow.ts`).
  - Remote tab cards replace the generic attach-error card, and tabs reattach when the epoch moves or their block clears.
- **The #631 PR.** Tasks 1–5 are the plumbing the #631 PR is building on `fix/remote-401-after-rollout`; each is flagged "may already exist after the #631 PR".

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React 18, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-signed-out-ux-design.md` (approved by the owner 2026-11-23; decisions D169–D177).

## Global Constraints

Every task's requirements include this section.

**Binding design (owner-approved)**
- **Banner** (app-wide, only while signed out and at least one remote bookmark exists): "Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host." It has a **Sign in** button that runs the device flow inline: the code, Copy, "Open github.com/login/device", the countdown and Cancel. It never sends the user to Settings.
- **Tab card copy, verbatim:**

  | Kind | Title | Body | Action |
  |---|---|---|---|
  | `not-signed-in` | `Not signed in` | `Sign in to reconnect. Your sessions are still running on the host.` | Sign in |
  | `expired` | `Sign-in expired` | (same body) | Sign in |
  | `host-refused` | `<name> didn't accept your sign-in; retrying` | `Your GitHub sign-in is valid. This tab reconnects by itself.` | Retry now |
  | `unreachable` | `Can't reach <name>; retrying` | `Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself.` | Retry now |
  | `forbidden` | `You don't have access to <name>` | `Ask the host's admins to add you to a team with access.`; with SSO: `Authorise claude-fleet for your organisation on GitHub (a one-time step); this tab reconnects by itself.` plus an "Authorise on GitHub" link | none |

- **Precedence (D170):** `not-signed-in`/`expired` > restarting (the existing drain card and chip) > `forbidden` > `host-refused` > `unreachable`.
- **Notification (D172):** exactly one per transition from signed in to signed out with cause `revoked`, only when at least one remote bookmark exists. It goes through `notifyService.request`:
  - `kind: 'signed-out'`, `priority: 'high'`, `source: { kind: 'user', id: null }`, `dedupeKey: 'remote-signed-out'`;
  - title `Signed out of GitHub`;
  - body `Remote workspaces are paused. Your sessions are still running on the host. Open claude-fleet to sign in.`;
  - none for the user's own Sign out, starting signed out, or per-tab and per-host failures.
- **Recovery (D174):** on a sign-in or token refresh, main bumps `epoch`, drops the sign-in-related conns, reconnects every bookmark and pushes. A tab showing a remote card reattaches in place when `epoch` moves or its block clears. Nothing needs a restart or a re-added bookmark.
- **Signed-out tabs don't call `pty:attach` (D176).**

**Repo rules**
- No new user-facing setting.
- Any new modal uses `ModalBackdrop`. This plan adds none: the banner and cards are inline.
- **Palette tokens:**
  - `--wait` (violet, needs your input) for signed-out;
  - `--warn` for retrying;
  - `--danger` for no access;
  - `--ok` stays live.
- Logic that picks a state, card or banner lives in pure helpers with unit tests (`signedOutView.ts`, `remoteAuth.ts`, `signInFlow.ts`), not only in components.

**Security**
- The token never reaches the renderer.
  - `RemoteAuthState` carries kinds, times and an `https://github.com` SSO link only.
  - The device flow uses the existing `identity:*` IPC. The renderer sees `userCode` and `verificationUri`, as Settings → Account already does.
- `remote:authState` takes no arguments.
- Host-supplied text never reaches the cards.

**Process**
- **SPEC.md is updated in the implementation PR (Task 12)** (`.claude/rules/spec-maintenance.md`).
- **Comments are terse and necessary** (`.claude/rules/review-conventions.md`).
- **No display in this environment.** UI is gated by typecheck, unit tests and build; Troy eyeballs it on the host (spec *Testing*).
- **Typecheck both configs separately:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json` (`npm run typecheck` short-circuits after the first failure). Host code: `npx tsc -p tsconfig.host.json`.
- **Work in a git worktree.** Never `cd` into the shared `/workspace/claude-fleet` checkout; use `git -C <worktree>`.

**Dependency on the #631 PR (`fix/remote-401-after-rollout`)**
- **Before Task 1:**
  1. Run `git -C <worktree> fetch origin && git -C <worktree> log --oneline origin/main | head -20` and look for the #631 merge.
  2. If it merged, rebase onto it. For each of Tasks 1–5, check whether its **Produces** interface exists, under any name.
  3. If it exists, skip the task and adapt later tasks to the real names. Record the mapping in the PR body.
- **If the #631 PR is still open:** coordinate on `/shared` with the agent working in `/workspace/claude-fleet/.claude/worktrees/remote-401` rather than duplicating the work. If it stalls, Tasks 1–5 here are the fallback.
- **PR #630 (app vault, PAT sign-in) also edits `identityService.ts` and `AccountSettings.tsx`.** This plan doesn't touch `AccountSettings.tsx`. If PR #630 merges first:
  - a vault PAT that becomes active fires `sign-in`;
  - a PAT that is rejected with no device token left fires `revoked`.

---

### Task 1: Identity change events and 401 recovery (may already exist after the #631 PR)

**Files:**
- Modify: `src/main/identity/identityService.ts`
- Test: `src/main/identity/identityService.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type IdentityChangeCause = 'sign-in' | 'token-refreshed' | 'sign-out' | 'revoked'`
  - `export interface IdentityChange { cause: IdentityChangeCause; signedIn: boolean }`
  - `export type RecoverResult = 'retry' | 'expired' | 'host-refused'`
  - `IdentityService.onChange(fn: (c: IdentityChange) => void): () => void`
  - `IdentityService.recover(sentToken: string): Promise<RecoverResult>`

- [ ] **Step 1: Write the failing tests** (append to `identityService.test.ts`; `setup`, `signIn`, `TOKEN` and `IdentityError` are already in the file)

```ts
describe('IdentityService change events and recovery', () => {
  it('fires sign-in, sign-out and revoked, never with the token', async () => {
    const s = setup({ polls: [DONE] });
    const seen: unknown[] = [];
    s.svc.onChange((c) => seen.push(c));
    await signIn(s);
    await s.svc.signOut();
    await s.svc.signOut();
    expect(seen).toEqual([{ cause: 'sign-in', signedIn: true }, { cause: 'sign-out', signedIn: false }]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it('status refresh that GitHub rejects fires revoked', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    const seen: unknown[] = [];
    s.svc.onChange((c) => seen.push(c));
    s.setProbe(new IdentityError('unauthorized', 'bad credentials', 401));
    await s.svc.status({ refresh: true });
    expect(seen).toEqual([{ cause: 'revoked', signedIn: false }]);
  });

  it('recover: a newer stored token means retry, without asking GitHub', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.github.probe.mockClear();
    expect(await s.svc.recover('gho_older')).toBe('retry');
    expect(s.github.probe).not.toHaveBeenCalled();
  });

  it('recover: GitHub accepts the token, so the host refused it; the token stays', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    expect(await s.svc.recover(TOKEN)).toBe('host-refused');
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('recover: GitHub rejects the token, so it is cleared and revoked fires once (D171)', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    const seen: unknown[] = [];
    s.svc.onChange((c) => seen.push(c));
    s.setProbe(new IdentityError('unauthorized', 'bad credentials', 401));
    const [a, b] = await Promise.all([s.svc.recover(TOKEN), s.svc.recover(TOKEN)]);
    expect([a, b]).toEqual(['expired', 'expired']);
    expect(s.github.probe).toHaveBeenCalledTimes(2); // sign-in's probe + one recovery probe
    expect(await s.svc.bearerToken()).toBeNull();
    expect(seen).toEqual([{ cause: 'revoked', signedIn: false }]);
    expect((await s.svc.status()).notice).toMatch(/revoked or expired/);
  });

  it('recover: a network failure is host-refused and keeps the token', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe(new IdentityError('network', 'offline'));
    expect(await s.svc.recover(TOKEN)).toBe('host-refused');
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('a throwing listener does not break sign-in', async () => {
    const s = setup({ polls: [DONE] });
    s.svc.onChange(() => { throw new Error('listener bug'); });
    expect((await signIn(s)).signedIn).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/identity/identityService.test.ts`
Expected: FAIL with "s.svc.onChange is not a function".

- [ ] **Step 3: Implement**

In `identityService.ts`, after the `IdentityServiceDeps` interface:

```ts
export type IdentityChangeCause = 'sign-in' | 'token-refreshed' | 'sign-out' | 'revoked';
/** Fired after the vault write settles, only when the stored token changed. Never carries the token. */
export interface IdentityChange {
  cause: IdentityChangeCause;
  signedIn: boolean;
}
export type RecoverResult = 'retry' | 'expired' | 'host-refused';
```

Add these fields to `IdentityService`:

```ts
  private readonly listeners = new Set<(c: IdentityChange) => void>();
  /** One recovery per rejected token; concurrent 401s share it. */
  private readonly recovering = new Map<string, Promise<RecoverResult>>();
```

Add these methods:

```ts
  onChange(fn: (c: IdentityChange) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(c: IdentityChange): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(c);
      } catch {
        // A listener's bug must not fail the sign-in or sign-out that fired it.
      }
    }
  }

  /** For RemoteClient after a host 401: `retry` with the stored token, or why not. */
  recover(sentToken: string): Promise<RecoverResult> {
    let p = this.recovering.get(sentToken);
    if (!p) {
      p = this.recoverOnce(sentToken).finally(() => this.recovering.delete(sentToken));
      this.recovering.set(sentToken, p);
    }
    return p;
  }

  private async recoverOnce(sent: string): Promise<RecoverResult> {
    const saved = await this.settled();
    if (!saved || saved.token !== sent) return 'retry';
    try {
      await this.github.probe(sent);
      return 'host-refused';
    } catch (err) {
      if (!(err instanceof IdentityError) || err.kind !== 'unauthorized') return 'host-refused';
      if (await this.revoke(sent)) {
        this.notice = REVOKED_NOTICE;
        this.emit({ cause: 'revoked', signedIn: false });
      }
      return 'expired';
    }
  }
```

In `status()`, in the `unauthorized` branch, after `this.notice = REVOKED_NOTICE;`:

```ts
          this.emit({ cause: 'revoked', signedIn: false });
```

In `finishSignIn`, just before the final `return { state: 'done', … }`:

```ts
    this.emit({ cause: 'sign-in', signedIn: true });
```

Replace `signOut()` with:

```ts
  async signOut(): Promise<void> {
    this.pending = null;
    this.notice = null;
    this.epoch++;
    const had = (await this.settled()) !== null;
    await this.clear();
    if (had) this.emit({ cause: 'sign-out', signedIn: false });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/identity/`
Expected: PASS (including `noElectron.test.ts`: no new imports).

- [ ] **Step 5: Commit**

```bash
git add src/main/identity/identityService.ts src/main/identity/identityService.test.ts
git commit -m "feat(identity): change events and 401 recovery for remote clients"
```

---

### Task 2: RemoteClient 401 reason and retry once (may already exist after the #631 PR)

**Files:**
- Modify: `src/main/remoteClient.ts`
- Modify: `src/main/ipc.ts` (pass `recover`)
- Test: `src/main/remoteClient.test.ts`

**Interfaces:**
- Consumes: `IdentityService.recover(sentToken): Promise<RecoverResult>` (Task 1).
- Produces:
  - `export type RemoteAuthFailure = 'expired' | 'host-refused'`
  - `RemoteError.auth?: RemoteAuthFailure` (a fifth constructor parameter)
  - `RemoteClientOptions.recover?: (sentToken: string) => Promise<'retry' | 'expired' | 'host-refused'>`
  - `RemoteDisconnect.auth?: RemoteAuthFailure`
  - `RemoteBackendDeps.recover?` (same signature), passed to every `RemoteClient`.

- [ ] **Step 1: Write the failing tests** (add `vi` to the `vitest` import in `remoteClient.test.ts`)

```ts
describe('RemoteClient 401 recovery', () => {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('retries once with the stored token after recover says retry', async () => {
    const seen: string[] = [];
    const { url } = await rawServer((req, res) => {
      seen.push(String(req.headers.authorization));
      if (req.headers.authorization === 'Bearer gho_new') json(res, 200, { ok: true, result: 7 });
      else json(res, 401, { error: 'token rejected by GitHub' });
    });
    let tok = 'gho_old';
    const recover = vi.fn(async () => {
      tok = 'gho_new';
      return 'retry' as const;
    });
    const c = new RemoteClient({ url, token: async () => tok, recover });
    expect(await c.rpc('x', [])).toBe(7);
    expect(seen).toEqual(['Bearer gho_old', 'Bearer gho_new']);
    expect(recover).toHaveBeenCalledExactlyOnceWith('gho_old');
  });

  it.each(['expired', 'host-refused'] as const)('surfaces %s without retrying', async (why) => {
    let calls = 0;
    const { url } = await rawServer((_req, res) => {
      calls++;
      json(res, 401, { error: 'missing or malformed bearer token' });
    });
    const c = new RemoteClient({ url, token: async () => 'gho_x', recover: async () => why });
    const err = (await c.whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err).toBeInstanceOf(RemoteError);
    expect([err.kind, err.auth, calls]).toEqual(['unauthorized', why, 1]);
    expect(err.message).not.toContain('gho_x');
  });

  it('a second 401 after a retry is host-refused, and recover runs once', async () => {
    const { url } = await rawServer((_req, res) => json(res, 401, { error: 'token recently rejected' }));
    const recover = vi.fn(async () => 'retry' as const);
    const c = new RemoteClient({ url, token: async () => 'gho_x', recover });
    const err = (await c.whoami().catch((e: unknown) => e)) as RemoteError;
    expect([err.kind, err.auth]).toEqual(['unauthorized', 'host-refused']);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('a socket open answered 401 goes through the same recovery', async () => {
    const { url } = await rawServer(
      (_req, res) => json(res, 404, {}),
      (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    );
    const c = new RemoteClient({ url, token: async () => 'gho_x', recover: async () => 'expired' });
    const err = (await c.openSocket('/events').catch((e: unknown) => e)) as RemoteError;
    expect([err.kind, err.auth]).toEqual(['unauthorized', 'expired']);
  });

  it('without recover, a 401 keeps auth undefined', async () => {
    const { url } = await rawServer((_req, res) => json(res, 401, { error: 'token rejected by GitHub' }));
    const c = new RemoteClient({ url, token: async () => 'gho_x' });
    const err = (await c.whoami().catch((e: unknown) => e)) as RemoteError;
    expect([err.kind, err.auth]).toEqual(['unauthorized', undefined]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/remoteClient.test.ts`
Expected: FAIL. The first test sees one request and an `unauthorized` error; `err.auth` is undefined.

- [ ] **Step 3: Implement** in `remoteClient.ts`

```ts
export type RemoteAuthFailure = 'expired' | 'host-refused';

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    /** `unauthorized` only, after recovery: GitHub rejected the token, or only the host did. */
    readonly auth?: RemoteAuthFailure
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}
```

Add `auth?: RemoteAuthFailure;` to `RemoteDisconnect`. Add this option to `RemoteClientOptions`:

```ts
  /** After a 401: the identity service's verdict on the token that was sent. */
  recover?: (sentToken: string) => Promise<'retry' | 'expired' | 'host-refused'>;
```

Store it in the constructor (`private readonly recover?: RemoteClientOptions['recover'];` and `this.recover = opts.recover;`). Replace the 401 line in `statusError`:

```ts
  if (status === 401) return new RemoteError('unauthorized', 'The host refused the GitHub sign-in', 401);
```

Add these helpers above the class:

```ts
function authFailure(url: string, why: RemoteAuthFailure): RemoteError {
  return why === 'expired'
    ? new RemoteError('unauthorized', 'Your GitHub sign-in expired; sign in again', 401, undefined, 'expired')
    : new RemoteError('unauthorized', `${url} didn't accept your GitHub sign-in; retrying`, 401, undefined, 'host-refused');
}
const isUnauthorized = (e: unknown): boolean => e instanceof RemoteError && e.kind === 'unauthorized';
```

Add this method to the class:

```ts
  /** Runs `once` with the current token; on a 401, asks `recover` and retries once. */
  private async withRecovery<T>(once: (token: string) => Promise<T>): Promise<T> {
    const token = await this.bearer();
    try {
      return await once(token);
    } catch (err) {
      if (!isUnauthorized(err) || !this.recover) throw err;
      const why = await this.recover(token).catch(() => 'host-refused' as const);
      if (why !== 'retry') throw authFailure(this.url, why);
      try {
        return await once(await this.bearer());
      } catch (again) {
        throw isUnauthorized(again) ? authFailure(this.url, 'host-refused') : again;
      }
    }
  }
```

Rename the existing `request(path, init)` to `private send(path, init, token: string | null)`. Delete its `const token = init.auth ? await this.bearer() : null;` line, because the token now arrives as the parameter, and keep `if (token) headers.Authorization = …`. Then add:

```ts
  private request(path: string, init: { method: string; body?: string; auth: boolean; timeoutMs?: number; maxBody: number }): Promise<unknown> {
    return init.auth ? this.withRecovery((t) => this.send(path, init, t)) : this.send(path, init, null);
  }
```

Rename the existing `openSocket` body to `private openSocketWith(path, token: string): Promise<WebSocket>`, dropping its `const token = await this.bearer();` line, then add:

```ts
  async openSocket(path: '/attach' | '/events'): Promise<WebSocket> {
    return this.withRecovery((t) => this.openSocketWith(path, t));
  }
```

In `subscribe`'s failure branch, carry `auth`:

```ts
          down({ kind: e.kind, status: e.status, auth: e.auth }, e.retryAfterMs);
```

In `src/main/remote.ts`, add `recover?: (sentToken: string) => Promise<'retry' | 'expired' | 'host-refused'>;` to `RemoteBackendDeps`, and change `clientFor` to `new RemoteClient({ url, token: deps.token, recover: deps.recover })`. In `src/main/ipc.ts`, next to `remoteToken`:

```ts
let remoteRecover: (sentToken: string) => Promise<'retry' | 'expired' | 'host-refused'> = async () => 'host-refused';
```

Pass `recover: (t) => remoteRecover(t)` into `createRemoteBackend`, and in `registerIpc` after `remoteLogin = …`:

```ts
  remoteRecover = (t) => identity.recover(t);
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/remoteClient.test.ts src/main/remote.test.ts src/main/remoteIpc.test.ts src/main/remoteAttach.test.ts`
Expected: PASS. If an older test asserts the text "GitHub sign-in was rejected by the host", update it to "The host refused the GitHub sign-in" (#631 ask 3).

- [ ] **Step 5: Commit**

```bash
git add src/main/remoteClient.ts src/main/remoteClient.test.ts src/main/remote.ts src/main/ipc.ts
git commit -m "feat(remote): name the 401 and retry once after identity recovery"
```

---

### Task 3: Proactive refresh of expiring GitHub tokens (may already exist after the #631 PR)

**Files:**
- Modify: `src/main/identity/deviceFlow.ts`
- Modify: `src/main/identity/identityService.ts`
- Modify: `src/main/ipc.ts` (call `startRefresh`)
- Test: `src/main/identity/deviceFlow.test.ts`, `src/main/identity/identityService.test.ts`

**Interfaces:**
- Consumes: `IdentityChange`, `emit` and `recoverOnce` (Task 1).
- Produces:
  - `export interface TokenGrant { token: string; scopes: string[]; refreshToken?: string; expiresAt?: number }`
  - `PollResult` `done` becomes `{ status: 'done' } & TokenGrant`
  - `refreshDeviceToken(clientId: string, refreshToken: string, now?: () => number): Promise<TokenGrant>`
  - `GithubSignInApi.refresh?(clientId: string, refreshToken: string): Promise<TokenGrant>`
  - `IdentityServiceDeps.schedule?: (fn: () => void, ms: number) => () => void`
  - `IdentityService.startRefresh(): Promise<void>`
  - `export const REFRESH_KEY = 'REFRESH'`
  - `export const REFRESH_LEAD_MS = 10 * 60_000`

- [ ] **Step 1: Write the failing tests**

In `deviceFlow.test.ts` (it stubs `fetch` with `stub(() => json(...))`):

```ts
describe('expiring tokens', () => {
  it('a token response with refresh_token and expires_in carries both', async () => {
    stub(() => json({ access_token: 'ghu_a', scope: 'read:org', refresh_token: 'ghr_r', expires_in: 28800 }));
    expect(await pollDeviceToken('cid', 'dc', 5000, () => 1_000)).toEqual({
      status: 'done', token: 'ghu_a', scopes: ['read:org'], refreshToken: 'ghr_r', expiresAt: 1_000 + 28_800_000
    });
  });

  it('refreshDeviceToken posts the refresh grant with no client secret', async () => {
    const f = stub(() => json({ access_token: 'ghu_b', refresh_token: 'ghr_s', expires_in: 60 }));
    expect(await refreshDeviceToken('cid', 'ghr_r', () => 0)).toEqual({ token: 'ghu_b', scopes: [], refreshToken: 'ghr_s', expiresAt: 60_000 });
    const body = String((f.mock.calls[0][1] as RequestInit).body);
    expect(body).toBe('client_id=cid&grant_type=refresh_token&refresh_token=ghr_r');
  });

  it('a refused refresh throws a token-free DeviceFlowError', async () => {
    stub(() => json({ error: 'bad_refresh_token' }));
    const err = await refreshDeviceToken('cid', 'ghr_r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(String((err as Error).message)).not.toContain('ghr_r');
  });
});
```

(Import `refreshDeviceToken`. If `stub` doesn't return the `vi.fn`, change it to return it.)

In `identityService.test.ts`, extend `setup` with `refresh?: TokenGrant | Error` and `schedule`. Add these to the `github` fake:

```ts
    refresh: vi.fn(async () => {
      const r = o.refresh;
      if (!r) throw new Error('unexpected refresh');
      if (r instanceof Error) throw r;
      return r;
    })
```

Then pass `schedule: (fn, ms) => { timers.push({ fn, ms }); return () => undefined; }` with `const timers: Array<{ fn: () => void; ms: number }> = [];` returned from `setup`. Tests:

```ts
describe('IdentityService proactive refresh (D177)', () => {
  const EXPIRING: PollResult = { status: 'done', token: TOKEN, scopes: ['read:org'], refreshToken: 'ghr_r', expiresAt: 3_600_000 };

  it('schedules a refresh 10 minutes before expiry and swaps the token', async () => {
    const s = setup({ polls: [EXPIRING], refresh: { token: 'ghu_new', scopes: [], refreshToken: 'ghr_s', expiresAt: 7_200_000 } });
    const seen: unknown[] = [];
    s.svc.onChange((c) => seen.push(c));
    await signIn(s);
    expect(s.timers.at(-1)!.ms).toBe(3_600_000 - 600_000 - 5000);
    s.timers.at(-1)!.fn();
    await expect.poll(() => s.svc.bearerToken()).toBe('ghu_new');
    expect(seen).toEqual([{ cause: 'sign-in', signedIn: true }, { cause: 'token-refreshed', signedIn: true }]);
    expect(s.vault.store.get('identity:github|REFRESH')).toContain('ghr_s');
  });

  it('a non-expiring token schedules nothing', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    expect(s.timers).toHaveLength(0);
  });

  it('a refused refresh keeps the token', async () => {
    const s = setup({ polls: [EXPIRING], refresh: new Error('bad_refresh_token') });
    await signIn(s);
    s.timers.at(-1)!.fn();
    await expect.poll(() => s.github.refresh.mock.calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('recover refreshes first when it can', async () => {
    const s = setup({ polls: [EXPIRING], refresh: { token: 'ghu_new', scopes: [] } });
    await signIn(s);
    expect(await s.svc.recover(TOKEN)).toBe('retry');
    expect(await s.svc.bearerToken()).toBe('ghu_new');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/identity/deviceFlow.test.ts src/main/identity/identityService.test.ts`
Expected: FAIL. `refreshDeviceToken` is not exported, and no timer is scheduled.

- [ ] **Step 3: Implement**

In `deviceFlow.ts`:

```ts
export interface TokenGrant {
  token: string;
  scopes: string[];
  /** Only for expiring tokens (GitHub Apps with expiring user tokens). */
  refreshToken?: string;
  expiresAt?: number;
}

export type PollResult = { status: 'pending'; intervalMs: number } | ({ status: 'done' } & TokenGrant);

function grantOf(b: Record<string, unknown>, now: () => number): TokenGrant {
  const scopes = typeof b.scope === 'string' ? b.scope.split(/[\s,]+/).filter(Boolean) : [];
  const expiresIn = positiveSeconds(b.expires_in);
  const refresh = typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : null;
  return {
    token: b.access_token as string,
    scopes,
    ...(refresh && expiresIn !== null ? { refreshToken: refresh, expiresAt: now() + expiresIn * 1000 } : {})
  };
}

/** No client secret: a desktop can't hold one (D177). */
export async function refreshDeviceToken(clientId: string, refreshToken: string, now: () => number = Date.now): Promise<TokenGrant> {
  const b = await post(GITHUB_TOKEN_URL, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (typeof b.access_token === 'string' && b.access_token) return grantOf(b, now);
  if (typeof b.error === 'string') throw mapError(b.error);
  throw new DeviceFlowError('unexpected', 'GitHub refresh response had neither a token nor an error');
}
```

Change `pollDeviceToken` to take `now: () => number = Date.now` as a fourth parameter, and return `{ status: 'done', ...grantOf(b, now) }` on success.

In `identityService.ts`:

```ts
export const REFRESH_KEY = 'REFRESH';
export const REFRESH_LEAD_MS = 10 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
```

- `Saved` gains `refresh: { refreshToken: string; expiresAt: number } | null`.
- `GithubSignInApi` gains `refresh?(clientId: string, refreshToken: string): Promise<TokenGrant>`.
- `defaultGithub()` adds `refresh: (clientId, rt) => refreshDeviceToken(clientId, rt)`.
- `IdentityServiceDeps` gains `schedule?: (fn: () => void, ms: number) => () => void`. Store it as `this.schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });`.
- Add `private cancelRefresh: (() => void) | null = null;`.

In `load()`, after the profile parse:

```ts
    const rawRefresh = await this.vault.getSecret(GITHUB_IDENTITY_SCOPE, REFRESH_KEY);
    let refresh: Saved['refresh'] = null;
    try {
      const r = rawRefresh ? (JSON.parse(rawRefresh) as { refreshToken?: unknown; expiresAt?: unknown }) : null;
      if (r && typeof r.refreshToken === 'string' && typeof r.expiresAt === 'number') refresh = { refreshToken: r.refreshToken, expiresAt: r.expiresAt };
    } catch {
      refresh = null;
    }
    return isProfile(profile) ? { token, profile, refresh } : null;
```

`memory` paths store the same `Saved`.

Change `save(s, epoch, sameToken = false)` to `save(s, epoch, expectToken?: string)`. The check becomes `if (expectToken !== undefined && (await this.load())?.token !== expectToken) return false;`. The status-refresh caller passes `saved.token`. Write REFRESH between PROFILE and TOKEN; the vault has no single-key delete, so `''` means none:

```ts
      await this.vault.setSecret(GITHUB_IDENTITY_SCOPE, REFRESH_KEY, s.refresh ? JSON.stringify(s.refresh) : '');
```

In `status()`'s refresh branch, keep `refresh: saved.refresh` in `next`. In `finishSignIn`, build `refresh: r.refreshToken && r.expiresAt ? { refreshToken: r.refreshToken, expiresAt: r.expiresAt } : null`; `finishSignIn` now takes the grant instead of `(token, scopes)`. After a successful save, call `this.scheduleRefresh(saved)`. In `clearNow()`, call `this.cancelRefresh?.(); this.cancelRefresh = null;`.

Add:

```ts
  /** App start: schedule the saved token's refresh, if it expires. */
  async startRefresh(): Promise<void> {
    const s = await this.settled();
    if (s) this.scheduleRefresh(s);
  }

  private scheduleRefresh(s: Saved): void {
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    if (!s.refresh) return;
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, s.refresh.expiresAt - REFRESH_LEAD_MS - this.now()));
    this.cancelRefresh = this.schedule(() => void this.refreshNow(), ms);
  }

  /** False when there is nothing to refresh or GitHub refused; the token then stays until rejected. */
  private async refreshNow(): Promise<boolean> {
    const epoch = this.epoch;
    const saved = await this.settled();
    const clientId = await this.clientId();
    if (!saved?.refresh || !clientId || !this.github.refresh) return false;
    let g: TokenGrant;
    try {
      g = await this.github.refresh(clientId, saved.refresh.refreshToken);
    } catch {
      return false;
    }
    const next: Saved = {
      token: g.token,
      profile: saved.profile,
      refresh: g.refreshToken && g.expiresAt ? { refreshToken: g.refreshToken, expiresAt: g.expiresAt } : null
    };
    if (!(await this.save(next, epoch, saved.token))) return false;
    this.scheduleRefresh(next);
    this.emit({ cause: 'token-refreshed', signedIn: true });
    return true;
  }
```

In `recoverOnce`, after the `saved.token !== sent` check:

```ts
    if (saved.refresh && (await this.refreshNow())) return 'retry';
```

In `ipc.ts` `registerIpc`, after `registerIdentityIpc(ipcMain, identity);`:

```ts
  void identity.startRefresh();
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/identity/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/identity/deviceFlow.ts src/main/identity/deviceFlow.test.ts src/main/identity/identityService.ts src/main/identity/identityService.test.ts src/main/ipc.ts
git commit -m "feat(identity): refresh expiring GitHub tokens before they expire"
```

---

### Task 4: The host logs the 401/403 reason (may already exist after the #631 PR)

**Files:**
- Modify: `src/host/auth.ts`
- Modify: `src/host/server.ts`
- Modify: `src/host/testHost.ts` (optional `log` sink)
- Test: `src/host/server.authlog.test.ts` (new)

**Interfaces:**
- Produces: `authReason(error: string): string`. The `request` and `upgrade` log lines gain `reason: string | null`.

- [ ] **Step 1: Write the failing test** (`src/host/server.authlog.test.ts`)

```ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { authReason } from './auth.js';
import { person, TOKEN } from './testFakes.js';
import { startTestHost } from './testHost.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function rig() {
  const lines: Array<Record<string, unknown>> = [];
  const h = await startTestHost({ tokens: { [TOKEN]: person('alice', 1) }, grants: [], log: (l) => lines.push(JSON.parse(l)) });
  closers.push(h.close);
  return { ...h, lines };
}

describe('host auth log reason (#631 ask 2)', () => {
  it('maps refusals to fixed classes', () => {
    expect(authReason('no grant for @alice')).toBe('no grant');
    expect(authReason('token rejected by GitHub')).toBe('token rejected by GitHub');
  });

  it('a request with no bearer logs the missing-token class', async () => {
    const r = await rig();
    await fetch(`${r.url}/whoami`);
    expect(r.lines.find((l) => l.msg === 'request')).toMatchObject({ status: 401, reason: 'missing or malformed bearer token', login: null });
  });

  it('a rejected token and a missing grant log their class, never the token', async () => {
    const r = await rig();
    await fetch(`${r.url}/whoami`, { headers: { Authorization: 'Bearer gho_bad_token_value' } });
    await fetch(`${r.url}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const reqs = r.lines.filter((l) => l.msg === 'request');
    expect(reqs.map((l) => [l.status, l.reason])).toEqual([[401, 'token rejected by GitHub'], [403, 'no grant']]);
    expect(JSON.stringify(r.lines)).not.toContain('gho_bad_token_value');
  });

  it('an upgrade logs its reason', async () => {
    const r = await rig();
    await new Promise<void>((done) => {
      const ws = new WebSocket(`${r.url.replace('http', 'ws')}/events`);
      ws.on('unexpected-response', () => done());
      ws.on('error', () => done());
    });
    expect(r.lines.find((l) => l.msg === 'upgrade')).toMatchObject({ status: 401, reason: 'missing or malformed bearer token' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/host/server.authlog.test.ts`
Expected: FAIL. `authReason` is not exported, and `startTestHost` ignores `log`.

- [ ] **Step 3: Implement**

`src/host/auth.ts`:

```ts
/** A refusal's fixed class for the request log: never a token, and no login. */
export function authReason(error: string): string {
  return error.startsWith('no grant for @') ? 'no grant' : error;
}
```

`src/host/testHost.ts`: add `log?: (line: string) => void` to the options and use `log: createLogger(opts.log ?? (() => undefined)),`.

`src/host/server.ts`: import `authReason`. Inside `createHostServer`, add `const refusals = new WeakMap<ServerResponse, string>();`. In `handle`, before `sendJson(res, auth.status, …)`, add `refusals.set(res, authReason(auth.error));`. Change the request log line to:

```ts
          deps.log.log('info', 'request', { method: req.method, path, status: res.statusCode, login, reason: refusals.get(res) ?? null, ms: Date.now() - started });
```

Change the upgrade log line to:

```ts
        deps.log.log('info', 'upgrade', { path, status: auth.ok ? 101 : auth.status, login: auth.ok ? auth.identity.login : null, reason: auth.ok ? null : authReason(auth.error) });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/host/server.authlog.test.ts src/host/` then `npx tsc -p tsconfig.host.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/host/auth.ts src/host/server.ts src/host/testHost.ts src/host/server.authlog.test.ts
git commit -m "feat(host): log the 401/403 reason class on request and upgrade lines"
```

---

### Task 5: Reconnect every remote connection on demand (may already exist after the #631 PR)

**Files:**
- Modify: `src/main/remote.ts`
- Modify: `src/main/federation/summaryRelay.ts`
- Test: `src/main/remote.test.ts`, `src/main/federation/summaryRelay.test.ts`

**Interfaces:**
- Produces:
  - `RemoteBackend.reconnect(): void`: re-probe every bookmark now, with a fresh `/whoami`.
  - `SummaryRelay.reset(): void`: drop every subscription, then `sync()`.
  - `SummaryRelayDeps.onDisconnected?(origin: string, why: { kind: RemoteDisconnect['kind']; auth?: RemoteAuthFailure; status?: number }): void`
  - The `subscribe` dep's `why` widens to `{ retryInMs: number | null; kind?: RemoteDisconnect['kind']; auth?: RemoteAuthFailure; status?: number }`.

- [ ] **Step 1: Write the failing tests**

`remote.test.ts` (inside `describe('remote backend')`):

```ts
  it('reconnect re-probes every bookmark with a fresh /whoami', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    const before = r.whoamiCalls();
    r.backend.reconnect();
    await r.backend.refresh();
    expect(r.whoamiCalls()).toBe(before + 1);
  });
```

`summaryRelay.test.ts` (inside the `describe`, using its `rig`):

```ts
  it('reset drops every subscription and resubscribes at once', () => {
    const r = rig();
    r.relay.sync();
    r.relay.reset();
    expect(r.subs.map((s) => s.stopped)).toEqual([true, false]);
  });

  it('reports a disconnect kind to onDisconnected', () => {
    const seen: unknown[] = [];
    let state: ((c: boolean, why?: { retryInMs: number | null; kind?: string; auth?: string }) => void) | null = null;
    const relay = createSummaryRelay({
      sources: () => [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read', state: 'running' }],
      subscribe: (_u, _on, s) => { state = s as never; return () => undefined; },
      fetchSummary: async () => null,
      broadcast: () => undefined,
      onDisconnected: (o, why) => void seen.push([o, why])
    });
    relay.sync();
    state!(false, { retryInMs: 30_000, kind: 'unauthorized', auth: 'expired' });
    expect(seen).toEqual([[A, { kind: 'unauthorized', auth: 'expired', status: undefined }]]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/remote.test.ts src/main/federation/summaryRelay.test.ts`
Expected: FAIL with "reconnect is not a function" and "reset is not a function".

- [ ] **Step 3: Implement**

`remote.ts`: add `/** Re-probe every bookmark now with a fresh /whoami (after a sign-in). */ reconnect(): void;` to `RemoteBackend`, and to the returned object:

```ts
    reconnect() {
      if (stopped) return;
      lastWhoami.clear();
      for (const w of watches.values()) void probe(w);
    },
```

`summaryRelay.ts`: import `type { RemoteAuthFailure, RemoteDisconnect } from '../remoteClient.js'`. Widen the `subscribe` dep's `why` type to `{ retryInMs: number | null; kind?: RemoteDisconnect['kind']; auth?: RemoteAuthFailure; status?: number }`. Add:

```ts
  /** /events for that host went down; `kind` says why. */
  onDisconnected?(origin: string, why: { kind: RemoteDisconnect['kind']; auth?: RemoteAuthFailure; status?: number }): void;
```

In the `onState` callback:

```ts
            if (!connected && why?.kind && subs.get(id) === entry) d.onDisconnected?.(id, { kind: why.kind, auth: why.auth, status: why.status });
```

Change the return type to `{ sync(): void; stop(): void; reset(): void }`. Hoist `sync` into a named `function sync()`, and return `{ sync, stop, reset() { for (const id of [...subs.keys()]) drop(id); sync(); } }`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/remote.test.ts src/main/federation/summaryRelay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote.ts src/main/remote.test.ts src/main/federation/summaryRelay.ts src/main/federation/summaryRelay.test.ts
git commit -m "feat(remote): reconnect every bookmark and /events subscription on demand"
```

---

### Task 6: Shared types and the main-side monitor

**Files:**
- Create: `src/preload/remoteAuth.ts`
- Create: `src/main/remoteAuth.ts`
- Test: `src/main/remoteAuth.test.ts`

**Interfaces:**
- Consumes: `RemoteError` with `auth` (Task 2); `IdentityChange` (Task 1).
- Produces:
  - `src/preload/remoteAuth.ts`:
    - `RemoteBlockKind`, `RemoteConnKind`, `RemoteConn`, `RemoteAuthState`;
    - `EMPTY_REMOTE_AUTH`;
    - `remoteAttachTag(kind): string`;
    - `parseRemoteAttachTag(message): RemoteBlockKind | null`.
  - `src/main/remoteAuth.ts`:
    - `connKindOf(err: unknown): RemoteConnKind | null`;
    - `SIGNED_OUT_NOTICE`;
    - `createRemoteAuthMonitor(deps: RemoteAuthMonitorDeps): RemoteAuthMonitor`, with `start()`, `observe(id, err)`, `identityChanged(c)` and `snapshot()`.

- [ ] **Step 1: Write the failing tests** (`src/main/remoteAuth.test.ts`)

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseRemoteAttachTag, remoteAttachTag, type RemoteAuthState } from '../preload/remoteAuth.js';
import { RemoteError } from './remoteClient.js';
import { connKindOf, createRemoteAuthMonitor, SIGNED_OUT_NOTICE, type RemoteAuthMonitorDeps } from './remoteAuth.js';

const W = '01JC0000000000000000000000';

function rig(o: { signedIn?: boolean; bookmarks?: number } = {}) {
  const sent: RemoteAuthState[] = [];
  const deps: RemoteAuthMonitorDeps = {
    signedIn: async () => o.signedIn ?? true,
    bookmarkCount: async () => o.bookmarks ?? 1,
    send: (s) => void sent.push(s),
    notify: vi.fn(),
    reconnect: vi.fn(),
    ssoUrl: async () => 'https://github.com/orgs/acme/sso',
    log: vi.fn(),
    now: () => 1000
  };
  return { m: createRemoteAuthMonitor(deps), deps, sent, last: () => sent.at(-1)! };
}

describe('attach tag (D175)', () => {
  it('round-trips every block kind and ignores untagged text', () => {
    for (const k of ['not-signed-in', 'expired', 'host-refused', 'unreachable', 'forbidden'] as const) {
      expect(parseRemoteAttachTag(`${remoteAttachTag(k)}whatever`)).toBe(k);
    }
    expect(parseRemoteAttachTag('host attach failed: nope')).toBeNull();
    expect(parseRemoteAttachTag('x remote-expired: y')).toBeNull();
  });
});

describe('connKindOf', () => {
  it('maps RemoteError kinds; anything else is not a connection state', () => {
    expect(connKindOf(null)).toBe('ok');
    expect(connKindOf(new RemoteError('not-signed-in', 'x'))).toBe('not-signed-in');
    expect(connKindOf(new RemoteError('unauthorized', 'x', 401, undefined, 'expired'))).toBe('expired');
    expect(connKindOf(new RemoteError('unauthorized', 'x', 401))).toBe('host-refused');
    expect(connKindOf(new RemoteError('forbidden', 'x', 403))).toBe('forbidden');
    expect(connKindOf(new RemoteError('standby', 'x', 503))).toBe('unreachable');
    expect(connKindOf(new RemoteError('unreachable', 'x'))).toBe('unreachable');
    expect(connKindOf(new RemoteError('protocol', 'x'))).toBeNull();
    expect(connKindOf(new Error('x'))).toBeNull();
  });
});

describe('RemoteAuthMonitor', () => {
  it('starts signed out without notifying', async () => {
    const r = rig({ signedIn: false });
    await r.m.start();
    expect(r.last().signedOut).toEqual({ reason: 'not-signed-in', since: 1000 });
    expect(r.deps.notify).not.toHaveBeenCalled();
  });

  it('notifies once per involuntary sign-out, only with a bookmark (D172)', async () => {
    const r = rig();
    await r.m.start();
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(r.deps.notify).toHaveBeenCalledExactlyOnceWith(SIGNED_OUT_NOTICE);
    expect(r.last().signedOut?.reason).toBe('expired');
    const none = rig({ bookmarks: 0 });
    await none.m.identityChanged({ cause: 'revoked', signedIn: false });
    expect(none.deps.notify).not.toHaveBeenCalled();
  });

  it("the user's own sign-out doesn't notify", async () => {
    const r = rig();
    await r.m.identityChanged({ cause: 'sign-out', signedIn: false });
    expect(r.last().signedOut?.reason).toBe('not-signed-in');
    expect(r.deps.notify).not.toHaveBeenCalled();
  });

  it('a sign-in clears signed-out, bumps the epoch, drops sign-in conns and reconnects (D174)', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unauthorized', 'x', 401));
    await r.m.observe('other', new RemoteError('unreachable', 'x'));
    await r.m.identityChanged({ cause: 'revoked', signedIn: false });
    await r.m.identityChanged({ cause: 'sign-in', signedIn: true });
    expect(r.last()).toEqual({ signedOut: null, epoch: 1, conns: { other: { kind: 'unreachable', since: 1000 } } });
    expect(r.deps.reconnect).toHaveBeenCalledOnce();
  });

  it('observe pushes only on change; ok removes the entry; forbidden carries the SSO link', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unreachable', 'x'));
    await r.m.observe(W, new RemoteError('unreachable', 'y'));
    expect(r.sent).toHaveLength(1);
    await r.m.observe(W, null);
    expect(r.last().conns).toEqual({});
    await r.m.observe(W, new RemoteError('forbidden', 'x', 403));
    expect(r.last().conns[W]).toEqual({ kind: 'forbidden', since: 1000, ssoUrl: 'https://github.com/orgs/acme/sso' });
    await r.m.observe(W, new RemoteError('protocol', 'x'));
    expect(r.sent).toHaveLength(3);
  });

  it('logs transitions with the kind and never a message', async () => {
    const r = rig();
    await r.m.observe(W, new RemoteError('unauthorized', 'gho_leak', 401));
    expect(r.deps.log).toHaveBeenCalledWith({ level: 'warn', message: 'remote connection blocked', extra: { workspaceId: W, kind: 'host-refused' } });
    expect(JSON.stringify((r.deps.log as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('gho_leak');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/remoteAuth.test.ts`
Expected: FAIL with "Cannot find module './remoteAuth.js'".

- [ ] **Step 3: Implement**

`src/preload/remoteAuth.ts`:

```ts
// Remote sign-in and connection state (D169–D176). Main imports it; the renderer via preload.

export type RemoteBlockKind = 'not-signed-in' | 'expired' | 'host-refused' | 'unreachable' | 'forbidden';
export type RemoteConnKind = 'ok' | RemoteBlockKind;

export interface RemoteConn {
  kind: RemoteConnKind;
  since: number;
  /** `forbidden` only: GitHub's SSO authorise link from AccountStatus.sso. */
  ssoUrl?: string | null;
}

export interface RemoteAuthState {
  signedOut: { reason: 'not-signed-in' | 'expired'; since: number } | null;
  /** Bumped on every sign-in or token refresh; remote tabs on a card reattach when it moves. */
  epoch: number;
  /** Absent means ok. */
  conns: Record<string, RemoteConn>;
}

export const EMPTY_REMOTE_AUTH: RemoteAuthState = { signedOut: null, epoch: 0, conns: {} };

const TAG_RE = /^remote-(not-signed-in|expired|host-refused|unreachable|forbidden): /;

/** Electron drops error fields over IPC, so the kind rides at the start of the message. */
export function remoteAttachTag(kind: RemoteBlockKind): string {
  return `remote-${kind}: `;
}

export function parseRemoteAttachTag(message: string): RemoteBlockKind | null {
  const m = TAG_RE.exec(message);
  return m ? (m[1] as RemoteBlockKind) : null;
}
```

`src/main/remoteAuth.ts`:

```ts
// App-wide GitHub sign-in state and per-bookmark connection state for remote workspaces (D169–D174).
// Pure: ipc.ts injects the identity reads, the push, the notification sink and reconnect.
import type { IdentityChange } from './identity/identityService.js';
import { RemoteError } from './remoteClient.js';
import type { RemoteAuthState, RemoteConn, RemoteConnKind } from '../preload/remoteAuth.js';

const SIGN_IN_KINDS: ReadonlySet<RemoteConnKind> = new Set(['not-signed-in', 'expired', 'host-refused']);

export const SIGNED_OUT_NOTICE = {
  title: 'Signed out of GitHub',
  body: 'Remote workspaces are paused. Your sessions are still running on the host. Open claude-fleet to sign in.'
} as const;

/** null: not a connection state (protocol, disabled, model, a non-remote error). */
export function connKindOf(err: unknown): RemoteConnKind | null {
  if (err === null) return 'ok';
  if (!(err instanceof RemoteError)) return null;
  switch (err.kind) {
    case 'not-signed-in':
      return 'not-signed-in';
    case 'unauthorized':
      return err.auth === 'expired' ? 'expired' : 'host-refused';
    case 'forbidden':
      return 'forbidden';
    case 'unreachable':
    case 'standby':
      return 'unreachable';
    default:
      return null;
  }
}

export interface RemoteAuthMonitorDeps {
  signedIn(): Promise<boolean>;
  bookmarkCount(): Promise<number>;
  send(s: RemoteAuthState): void;
  notify(n: { title: string; body: string }): void;
  reconnect(): void;
  ssoUrl?(): Promise<string | null>;
  log(e: { level: 'info' | 'warn'; message: string; extra: Record<string, unknown> }): void;
  now?: () => number;
}

export interface RemoteAuthMonitor {
  start(): Promise<void>;
  /** `err` null means the bookmark answered fine. */
  observe(workspaceId: string, err: unknown): Promise<void>;
  identityChanged(c: IdentityChange): Promise<void>;
  snapshot(): RemoteAuthState;
}

export function createRemoteAuthMonitor(d: RemoteAuthMonitorDeps): RemoteAuthMonitor {
  const now = d.now ?? Date.now;
  let signedOut: RemoteAuthState['signedOut'] = null;
  let epoch = 0;
  const conns = new Map<string, RemoteConn>();
  const snapshot = (): RemoteAuthState => ({ signedOut, epoch, conns: Object.fromEntries(conns) });
  const push = (): void => d.send(snapshot());

  return {
    snapshot,
    async start() {
      if (!(await d.signedIn().catch(() => false))) signedOut = { reason: 'not-signed-in', since: now() };
      push();
    },
    async observe(id, err) {
      const kind = connKindOf(err);
      if (kind === null) return;
      if (kind === 'ok') {
        if (!conns.delete(id)) return;
        d.log({ level: 'info', message: 'remote connection ok', extra: { workspaceId: id } });
        push();
        return;
      }
      if (conns.get(id)?.kind === kind) return;
      const conn: RemoteConn = { kind, since: now() };
      if (kind === 'forbidden') conn.ssoUrl = (await d.ssoUrl?.().catch(() => null)) ?? null;
      conns.set(id, conn);
      d.log({ level: 'warn', message: 'remote connection blocked', extra: { workspaceId: id, kind } });
      push();
    },
    async identityChanged(c) {
      if (c.signedIn) {
        signedOut = null;
        epoch++;
        for (const [id, conn] of conns) if (SIGN_IN_KINDS.has(conn.kind)) conns.delete(id);
        d.log({ level: 'info', message: 'remote sign-in changed', extra: { cause: c.cause, epoch } });
        d.reconnect();
        push();
        return;
      }
      const first = signedOut === null;
      signedOut = { reason: c.cause === 'revoked' ? 'expired' : 'not-signed-in', since: signedOut?.since ?? now() };
      d.log({ level: 'warn', message: 'remote signed out', extra: { cause: c.cause } });
      if (first && c.cause === 'revoked' && (await d.bookmarkCount().catch(() => 0)) > 0) d.notify({ ...SIGNED_OUT_NOTICE });
      push();
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/remoteAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/remoteAuth.ts src/main/remoteAuth.ts src/main/remoteAuth.test.ts
git commit -m "feat(remote): app-wide sign-in and per-bookmark connection monitor"
```

---

### Task 7: Wire the monitor in main: observation, attach tags, IPC, notification

**Files:**
- Modify: `src/main/remote.ts` (the `observe` dep, attach tagging, host close)
- Modify: `src/main/remoteAttach.ts` (`onHostClose`)
- Modify: `src/main/remoteIpc.ts` (`remote:authState`)
- Modify: `src/main/ipc.ts` (the monitor, push, sinks)
- Modify: `src/main/index.ts` (the notification sink)
- Modify: `src/preload/index.ts` (`remote.authState`, `remote.onAuth`)
- Modify: `src/preload/inboxTypes.ts` (`NotificationKind` gains `'signed-out'`)
- Test: `src/main/remote.test.ts`, `src/main/remoteAttach.test.ts`, `src/main/remoteIpc.test.ts`

**Interfaces:**
- Consumes:
  - `createRemoteAuthMonitor`, `connKindOf` (Task 6);
  - `remoteAttachTag` (Task 6);
  - `RemoteBackend.reconnect`, `SummaryRelay.reset`, `onDisconnected` (Task 5);
  - `IdentityService.onChange` (Task 1).
- Produces:
  - `RemoteBackendDeps.observe?: (workspaceId: string, err: unknown) => void`;
  - `RemoteAttachOptions.onHostClose?: (code: number) => void`;
  - `RemoteIpcDeps.authState?(): RemoteAuthState`;
  - the channel `remote:authState` in `REMOTE_CHANNELS`;
  - the push `remote:auth`;
  - preload `window.api.remote.authState(): Promise<RemoteAuthState>` and `window.api.remote.onAuth(cb): () => void`;
  - `setSignedOutNotifier(fn | null)` exported from `ipc.ts`.

- [ ] **Step 1: Write the failing tests**

In `remote.test.ts`, give `rig` an `observe` option: add `observe?: (id: string, err: unknown) => void` to its `o` type and pass `observe: o.observe` into `createRemoteBackend`. Then:

```ts
  it('the probe loop reports a good /whoami as ok', async () => {
    const seen: Array<[string, unknown]> = [];
    const r = await rig('read', { observe: (id, err) => void seen.push([id, err]) });
    await r.backend.refresh();
    expect(seen).toContainEqual([ID, null]);
  });

  it('tags a remote attach failure with its kind and reports it (D175)', async () => {
    const seen: Array<[string, unknown]> = [];
    const r = await rig('session', { observe: (id, err) => void seen.push([id, err]) });
    vi.spyOn(RemoteClient.prototype, 'whoami').mockRejectedValue(new RemoteError('unauthorized', 'nope', 401, undefined, 'expired'));
    const err = (await r.backend.attachPty(ID, 'main', 80, 24).catch((e: unknown) => e)) as RemoteError;
    expect(err.message).toMatch(/^remote-expired: /);
    expect([err.kind, err.auth]).toEqual(['unauthorized', 'expired']);
    expect(seen.at(-1)?.[0]).toBe(ID);
  });

  it('an untagged attach failure is rethrown unchanged', async () => {
    const r = await rig('session');
    vi.spyOn(RemoteClient.prototype, 'whoami').mockRejectedValue(new RemoteError('protocol', 'odd reply'));
    await expect(r.backend.attachPty(ID, 'main', 80, 24)).rejects.toThrow(/^odd reply$/);
  });
```

In `remoteIpc.test.ts`:

```ts
describe('remote:authState', () => {
  it('returns the monitor snapshot', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc = { handle: (c: string, h: (...a: unknown[]) => unknown) => void handlers.set(c, h) };
    const snap = { signedOut: null, epoch: 3, conns: {} };
    registerRemoteIpc(ipc as never, {
      backend: {} as never,
      accountStatus: async () => ({}) as never,
      readManifest: async () => null,
      listManifests: async () => [],
      confirm: async () => false,
      writeManifest: async () => undefined,
      findByName: async () => null,
      invalidate: () => undefined,
      authState: () => snap
    });
    expect(REMOTE_CHANNELS).toContain('remote:authState');
    expect(await handlers.get('remote:authState')!({}, 'ignored')).toEqual(snap);
  });
});
```

In `remoteAttach.test.ts`, inside `describe('attachRemotePty')` next to the `host close %i` test (it uses that file's `rig`, `collect`, `READER` and `host.halt`):

```ts
  it('reports a host-initiated close code, and not our own detach', async () => {
    const codes: number[] = [];
    const onHostClose = (c: number) => void codes.push(c);
    const { host, client } = await rig(['s1', 's2']);
    const mine = await attachRemotePty({ client: client(READER), sessionId: 's2', cols: 80, rows: 24, canCreate: false, onHostClose });
    const outMine = collect(mine);
    mine.detach();
    await expect.poll(() => outMine.ended()).toBe(true);
    expect(codes).toEqual([]);

    const h = await attachRemotePty({ client: client(READER), sessionId: 's1', cols: 80, rows: 24, canCreate: false, onHostClose });
    const out = collect(h);
    host.halt(4401, 'x');
    await expect.poll(() => out.ended()).toBe(true);
    expect(codes).toEqual([4401]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/remote.test.ts src/main/remoteIpc.test.ts src/main/remoteAttach.test.ts`
Expected: FAIL. Nothing is observed, the message has no tag, and the channel is missing.

- [ ] **Step 3: Implement**

`remoteAttach.ts`: add to `RemoteAttachOptions`:

```ts
  /** The host closed the socket (we didn't): its close code. */
  onHostClose?: (code: number) => void;
```

In `ws.once('close', …)`, after `closedWith = code;`:

```ts
    if (!closing) o.onHostClose?.(code);
```

`remote.ts`: import `closeKind` from `./remoteClient.js`, `connKindOf` from `./remoteAuth.js`, and `remoteAttachTag` from `../preload/remoteAuth.js`. Add to `RemoteBackendDeps`:

```ts
  /** Each connection outcome for the sign-in monitor (D169); `err` null means ok. */
  observe?: (workspaceId: string, err: unknown) => void;
```

In `probeState`, report the `/whoami` outcome:

```ts
    if (await whoamiFresh(spec.id)) return { state: 'running', retryAfterMs: 0 };
    try {
      await refreshTier(spec);
      deps.observe?.(spec.id, null);
      return { state: 'running', retryAfterMs: 0 };
    } catch (err) {
      deps.observe?.(spec.id, err);
      return { state: err instanceof WrongWorkspaceError ? 'unreachable' : 'running', retryAfterMs: retryAfter(err) };
    }
```

Add this helper inside `createRemoteBackend`:

```ts
  /** A block kind rides in the message across IPC (D175); the monitor hears it first. */
  function tagged(id: string, err: unknown): unknown {
    const kind = connKindOf(err);
    if (kind === null || kind === 'ok') return err;
    deps.observe?.(id, err);
    const e = err as RemoteError;
    return new RemoteError(e.kind, remoteAttachTag(kind) + e.message, e.status, e.retryAfterMs, e.auth);
  }
```

Replace `attachPty` with:

```ts
    async attachPty(containerId, sessionId, cols, rows, resumeOf) {
      const spec = await bookmark(containerId);
      try {
        const who = await refreshTier(spec);
        deps.observe?.(spec.id, null);
        const client = clientFor(spec.remote.url);
        return await attachRemotePty({
          client, sessionId, cols, rows, resumeOf,
          canCreate: who.tier === 'session',
          drained: () => fetchDrained(client),
          onHostClose: (code) => {
            const k = closeKind(code);
            if (k === 'unauthorized' || k === 'forbidden') deps.observe?.(spec.id, new RemoteError(k, 'closed by the host', code));
          }
        });
      } catch (err) {
        throw tagged(spec.id, err);
      }
    },
```

`remoteIpc.ts`: add `'remote:authState'` to `REMOTE_CHANNELS`, add `/** App-wide sign-in and per-bookmark connection state (D169). */ authState?(): RemoteAuthState;` to `RemoteIpcDeps` (type import from `../preload/remoteAuth.js`), and register it after `remote:drainStates`:

```ts
  ipc.handle('remote:authState', async () => deps.authState?.() ?? EMPTY_REMOTE_AUTH);
```

`src/preload/inboxTypes.ts`: append `| 'signed-out'` to `NotificationKind`.

`src/preload/index.ts`: import `type RemoteAuthState` from `./remoteAuth`. In `remote:` after `onDrain`:

```ts
    /** App-wide sign-in and per-bookmark connection state (D169). */
    authState: (): Promise<RemoteAuthState> => ipcRenderer.invoke('remote:authState'),
    /** The whole state, on every change. */
    onAuth: (cb: (s: RemoteAuthState) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, s: RemoteAuthState) => cb(s);
      ipcRenderer.on('remote:auth', h);
      return () => ipcRenderer.removeListener('remote:auth', h);
    },
```

Re-export the `RemoteAuthState`, `RemoteBlockKind` and `EMPTY_REMOTE_AUTH` types and values from the preload barrel, wherever `RemoteDrain` is re-exported.

`ipc.ts`:
- Import `createRemoteAuthMonitor` from `./remoteAuth.js` and `RemoteError` from `./remoteClient.js`.
- Pass `observe: (id, err) => void remoteAuth.observe(id, err)` into `createRemoteBackend`; the closure runs after `remoteAuth` exists.
- Add `onDisconnected` to `createSummaryRelay`:

```ts
  onDisconnected: (origin, why) => {
    if (why.kind === 'unauthorized' || why.kind === 'forbidden' || why.kind === 'not-signed-in') {
      void remoteAuth.observe(origin, new RemoteError(why.kind, 'events closed', why.status, undefined, why.auth));
    }
  },
```

After `summaryRelay`:

```ts
let signedOutNotifier: ((n: { title: string; body: string }) => void) | null = null;
/** Set by the inbox services while they run; one notification per involuntary sign-out (D172). */
export function setSignedOutNotifier(fn: ((n: { title: string; body: string }) => void) | null): void {
  signedOutNotifier = fn;
}
let remoteSso: () => Promise<string | null> = async () => null;
const remoteAuth = createRemoteAuthMonitor({
  signedIn: async () => (await remoteToken()) !== null,
  bookmarkCount: async () => (MOCK_MODE ? 0 : (await listWorkspaceManifests()).filter((m) => m.kind === 'remote').length),
  send: (s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      try { w.webContents.send('remote:auth', s); } catch { /* mid-teardown */ }
    }
  },
  notify: (n) => signedOutNotifier?.(n),
  reconnect: () => {
    remoteBackend.reconnect();
    summaryRelay.reset();
  },
  ssoUrl: () => remoteSso(),
  log: (e) => logError({ source: 'main', type: 'remote-auth', level: e.level, message: e.message, extra: e.extra })
});
```

In `registerIpc`, after `remoteRecover = …`:

```ts
  remoteSso = async () => {
    const sso = (await identity.status().catch(() => null))?.sso;
    return sso ? sso.url ?? sso.appSettingsUrl : null;
  };
  identity.onChange((c) => void remoteAuth.identityChanged(c));
  void remoteAuth.start();
```

Add `authState: () => remoteAuth.snapshot()` to the `registerRemoteIpc` deps.

`index.ts`: import `setSignedOutNotifier` from `./ipc.js`. Inside `if (notifySvc && !MOCK_MODE) {` after `setRemoteNoticeSink(notifier);`:

```ts
      setSignedOutNotifier((n) =>
        void svc
          .request({ kind: 'signed-out', title: n.title, body: n.body, priority: 'high', source: { kind: 'user', id: null }, dedupeKey: 'remote-signed-out' })
          .catch((e) => logError({ source: 'main', type: 'remote-auth', level: 'warn', message: String(e) }))
      );
      inboxTeardown.push(() => setSignedOutNotifier(null));
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/remote.test.ts src/main/remoteIpc.test.ts src/main/remoteAttach.test.ts src/main/remoteAuth.test.ts src/main/ipcFederationWiring.test.ts` then `npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS, no type errors. If a `Record<NotificationKind, …>` fails the web typecheck later, add `'signed-out': 'Signed out'` there.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote.ts src/main/remote.test.ts src/main/remoteAttach.ts src/main/remoteAttach.test.ts src/main/remoteIpc.ts src/main/remoteIpc.test.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts src/preload/inboxTypes.ts
git commit -m "feat(remote): push sign-in state, tag attach failures, notify once on sign-out"
```

---

### Task 8: Renderer pure helpers: banner, block, cards, end kind, reattach, chip

**Files:**
- Create: `src/renderer/src/signedOutView.ts`
- Modify: `src/renderer/src/remoteView.ts` (`remoteChip` phases, `remotePane` hint)
- Test: `src/renderer/src/signedOutView.test.ts`, `src/renderer/src/remoteView.test.ts`

**Interfaces:**
- Consumes: `RemoteAuthState`, `RemoteBlockKind`, `parseRemoteAttachTag` (Task 6); `ipcErrorText` (`remoteView.ts`).
- Produces:
  - `SIGNED_OUT_BANNER: string`
  - `signedOutBanner(s: RemoteAuthState | null, remoteCount: number): string | null`
  - `blockFor(s: RemoteAuthState | null, workspaceId: string): RemoteBlockKind | null`
  - `isSignInBlock(b: RemoteBlockKind | null): boolean`
  - `interface RemoteCard { tone: 'wait' | 'warn' | 'danger'; title: string; body: string; action: 'sign-in' | 'retry' | null; linkUrl: string | null }`
  - `remoteCard(kind: RemoteBlockKind, name: string, ssoUrl?: string | null): RemoteCard`
  - `attachErrorBlock(err: unknown): RemoteBlockKind | null`
  - `type TabEnd = { kind: 'natural' } | { kind: 'restarting' } | { kind: 'remote'; block: RemoteBlockKind } | { kind: 'attach-error'; message: string }`
  - `remoteEndKind(restarting: boolean, block: RemoteBlockKind | null): TabEnd`
  - `shownRemoteBlock(remote: boolean, ended: TabEnd | null, block: RemoteBlockKind | null): RemoteBlockKind | null`
  - `shouldReattach(showing: RemoteBlockKind | null, prev: AuthView, next: AuthView): boolean`, where `AuthView = { epoch: number; block: RemoteBlockKind | null }`
  - `skipAttach(remote: boolean, block: RemoteBlockKind | null): boolean`
  - `remoteChip(w, drain?, block?: RemoteBlockKind | null)`, now with phases `'signed-out' | 'no-access'`

- [ ] **Step 1: Write the failing tests** (`src/renderer/src/signedOutView.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_REMOTE_AUTH, remoteAttachTag, type RemoteAuthState } from '../../preload/remoteAuth';
import { attachErrorBlock, blockFor, remoteCard, remoteEndKind, shouldReattach, shownRemoteBlock, signedOutBanner, SIGNED_OUT_BANNER, skipAttach } from './signedOutView';

const W = '01JC0000000000000000000000';
const out = (reason: 'not-signed-in' | 'expired'): RemoteAuthState => ({ ...EMPTY_REMOTE_AUTH, signedOut: { reason, since: 1 } });
const conn = (kind: 'unreachable' | 'forbidden' | 'host-refused'): RemoteAuthState => ({ ...EMPTY_REMOTE_AUTH, conns: { [W]: { kind, since: 1 } } });

describe('signed-out banner', () => {
  it('shows only while signed out with at least one remote bookmark', () => {
    expect(signedOutBanner(out('expired'), 1)).toBe(SIGNED_OUT_BANNER);
    expect(SIGNED_OUT_BANNER).toBe('Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host.');
    expect(signedOutBanner(out('expired'), 0)).toBeNull();
    expect(signedOutBanner(EMPTY_REMOTE_AUTH, 3)).toBeNull();
    expect(signedOutBanner(null, 3)).toBeNull();
  });
});

describe('blockFor (D170)', () => {
  it('app-wide sign-out wins over the bookmark; ok is no block', () => {
    expect(blockFor({ ...conn('forbidden'), signedOut: { reason: 'expired', since: 1 } }, W)).toBe('expired');
    expect(blockFor(conn('unreachable'), W)).toBe('unreachable');
    expect(blockFor({ ...EMPTY_REMOTE_AUTH, conns: { [W]: { kind: 'ok', since: 1 } } }, W)).toBeNull();
    expect(blockFor(EMPTY_REMOTE_AUTH, W)).toBeNull();
  });
});

describe('remoteCard copy', () => {
  it('matches the approved table', () => {
    expect(remoteCard('not-signed-in', 'rb')).toEqual({ tone: 'wait', title: 'Not signed in', body: 'Sign in to reconnect. Your sessions are still running on the host.', action: 'sign-in', linkUrl: null });
    expect(remoteCard('expired', 'rb').title).toBe('Sign-in expired');
    expect(remoteCard('host-refused', 'rb')).toMatchObject({ tone: 'warn', title: "rb didn't accept your sign-in; retrying", action: 'retry' });
    expect(remoteCard('unreachable', 'rb')).toMatchObject({ tone: 'warn', title: "Can't reach rb; retrying", body: 'Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself.', action: 'retry' });
    expect(remoteCard('forbidden', 'rb')).toEqual({ tone: 'danger', title: "You don't have access to rb", body: "Ask the host's admins to add you to a team with access.", action: null, linkUrl: null });
    expect(remoteCard('forbidden', 'rb', 'https://github.com/orgs/acme/sso').linkUrl).toBe('https://github.com/orgs/acme/sso');
  });
});

describe('attach errors (D175)', () => {
  it('reads the tag through the Electron prefix; untagged is null', () => {
    const e = new Error(`Error invoking remote method 'pty:attach': RemoteError: ${remoteAttachTag('expired')}Your GitHub sign-in expired`);
    expect(attachErrorBlock(e)).toBe('expired');
    expect(attachErrorBlock(new Error("Error invoking remote method 'pty:attach': Error: host attach failed: x"))).toBeNull();
  });
});

describe('tab end and card (D170, D176)', () => {
  it('sign-in blocks beat restarting; restarting beats other blocks', () => {
    expect(remoteEndKind(true, 'expired')).toEqual({ kind: 'remote', block: 'expired' });
    expect(remoteEndKind(true, 'unreachable')).toEqual({ kind: 'restarting' });
    expect(remoteEndKind(false, 'forbidden')).toEqual({ kind: 'remote', block: 'forbidden' });
    expect(remoteEndKind(false, null)).toEqual({ kind: 'natural' });
  });

  it('a natural end upgrades to a later sign-in or refusal block, never to unreachable', () => {
    expect(shownRemoteBlock(true, { kind: 'natural' }, 'host-refused')).toBe('host-refused');
    expect(shownRemoteBlock(true, { kind: 'natural' }, 'unreachable')).toBeNull();
    expect(shownRemoteBlock(false, { kind: 'natural' }, 'expired')).toBeNull();
    expect(shownRemoteBlock(true, { kind: 'remote', block: 'unreachable' }, null)).toBe('unreachable');
    expect(shownRemoteBlock(true, { kind: 'remote', block: 'expired' }, 'host-refused')).toBe('host-refused');
  });

  it('only remote tabs with a sign-in block skip the attach', () => {
    expect(skipAttach(true, 'not-signed-in')).toBe(true);
    expect(skipAttach(true, 'unreachable')).toBe(false);
    expect(skipAttach(false, 'expired')).toBe(false);
  });
});

describe('shouldReattach (D174)', () => {
  it('on an epoch move or a cleared block, only for a tab on a remote card', () => {
    expect(shouldReattach('expired', { epoch: 0, block: 'expired' }, { epoch: 1, block: null })).toBe(true);
    expect(shouldReattach('unreachable', { epoch: 2, block: 'unreachable' }, { epoch: 2, block: null })).toBe(true);
    expect(shouldReattach('unreachable', { epoch: 2, block: 'unreachable' }, { epoch: 2, block: 'unreachable' })).toBe(false);
    expect(shouldReattach(null, { epoch: 0, block: null }, { epoch: 1, block: null })).toBe(false);
    expect(shouldReattach('expired', { epoch: 0, block: 'expired' }, { epoch: 1, block: 'not-signed-in' })).toBe(false);
  });
});
```

Append to `remoteView.test.ts`:

```ts
describe('remote chip sign-in phases', () => {
  const w = { kind: 'remote', state: 'running' };
  it('signed-out beats restarting; no-access sits under restarting', () => {
    expect(remoteChip(w, { phase: 'draining', softAt: null, hardAt: null, instance: null }, 'expired')).toEqual({ phase: 'signed-out', sub: 'signed out' });
    expect(remoteChip(w, null, 'forbidden')).toEqual({ phase: 'no-access', sub: 'no access' });
    expect(remoteChip(w, { phase: 'draining', softAt: null, hardAt: null, instance: null }, 'forbidden')?.phase).toBe('restarting');
    expect(remoteChip(w, null, 'host-refused')).toEqual({ phase: 'live', sub: null });
  });
  it('the unreachable pane carries the VPN hint', () => {
    expect(remotePane({ kind: 'remote', state: 'unreachable', name: 'rb', remote: { url: 'https://h' } })?.body).toBe(
      "rb (https://h) isn't answering. Check your network, or that your VPN (Twingate) is connected. Its sessions reappear when it's back."
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/renderer/src/signedOutView.test.ts src/renderer/src/remoteView.test.ts`
Expected: FAIL with "Cannot find module './signedOutView'", and the chip assertions fail.

- [ ] **Step 3: Implement**

`src/renderer/src/signedOutView.ts`:

```ts
// Pure rules for the signed-out banner, remote tab cards and their reattach (D169–D176).
import { parseRemoteAttachTag, type RemoteAuthState, type RemoteBlockKind } from '../../preload/remoteAuth';
import { ipcErrorText } from './remoteView';

export const SIGNED_OUT_BANNER = 'Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host.';

export function signedOutBanner(s: RemoteAuthState | null, remoteCount: number): string | null {
  return s?.signedOut && remoteCount > 0 ? SIGNED_OUT_BANNER : null;
}

/** The app-wide sign-out wins over any per-bookmark kind (D170). */
export function blockFor(s: RemoteAuthState | null, workspaceId: string): RemoteBlockKind | null {
  if (s?.signedOut) return s.signedOut.reason;
  const k = s?.conns[workspaceId]?.kind;
  return k && k !== 'ok' ? k : null;
}

export const isSignInBlock = (b: RemoteBlockKind | null): boolean => b === 'not-signed-in' || b === 'expired';

export interface RemoteCard {
  tone: 'wait' | 'warn' | 'danger';
  title: string;
  body: string;
  action: 'sign-in' | 'retry' | null;
  linkUrl: string | null;
}

const SIGN_IN_BODY = 'Sign in to reconnect. Your sessions are still running on the host.';

export function remoteCard(kind: RemoteBlockKind, name: string, ssoUrl: string | null = null): RemoteCard {
  switch (kind) {
    case 'not-signed-in':
      return { tone: 'wait', title: 'Not signed in', body: SIGN_IN_BODY, action: 'sign-in', linkUrl: null };
    case 'expired':
      return { tone: 'wait', title: 'Sign-in expired', body: SIGN_IN_BODY, action: 'sign-in', linkUrl: null };
    case 'host-refused':
      return { tone: 'warn', title: `${name} didn't accept your sign-in; retrying`, body: 'Your GitHub sign-in is valid. This tab reconnects by itself.', action: 'retry', linkUrl: null };
    case 'unreachable':
      return {
        tone: 'warn',
        title: `Can't reach ${name}; retrying`,
        body: 'Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself.',
        action: 'retry',
        linkUrl: null
      };
    case 'forbidden':
      return {
        tone: 'danger',
        title: `You don't have access to ${name}`,
        body: ssoUrl
          ? 'Authorise claude-fleet for your organisation on GitHub (a one-time step); this tab reconnects by itself.'
          : "Ask the host's admins to add you to a team with access.",
        action: null,
        linkUrl: ssoUrl
      };
  }
}

export function attachErrorBlock(err: unknown): RemoteBlockKind | null {
  return parseRemoteAttachTag(ipcErrorText(err));
}

export type TabEnd = { kind: 'natural' } | { kind: 'restarting' } | { kind: 'remote'; block: RemoteBlockKind } | { kind: 'attach-error'; message: string };

export function remoteEndKind(restarting: boolean, block: RemoteBlockKind | null): TabEnd {
  if (block && isSignInBlock(block)) return { kind: 'remote', block };
  if (restarting) return { kind: 'restarting' };
  if (block) return { kind: 'remote', block };
  return { kind: 'natural' };
}

/** A host close (4401/4403) can beat the state push, so a natural end upgrades to a block that arrives after it; unreachable never does. */
const UPGRADES: ReadonlySet<RemoteBlockKind> = new Set(['not-signed-in', 'expired', 'host-refused', 'forbidden']);

export function shownRemoteBlock(remote: boolean, ended: TabEnd | null, block: RemoteBlockKind | null): RemoteBlockKind | null {
  if (!remote || !ended) return null;
  if (ended.kind === 'remote') return block ?? ended.block;
  if (ended.kind === 'natural' && block && UPGRADES.has(block)) return block;
  return null;
}

export interface AuthView {
  epoch: number;
  block: RemoteBlockKind | null;
}

export function shouldReattach(showing: RemoteBlockKind | null, prev: AuthView, next: AuthView): boolean {
  if (showing === null || isSignInBlock(next.block)) return false;
  return next.epoch !== prev.epoch || (prev.block !== null && next.block === null);
}

export function skipAttach(remote: boolean, block: RemoteBlockKind | null): boolean {
  return remote && isSignInBlock(block);
}
```

`remoteView.ts`: import `type RemoteBlockKind` from `../../preload/remoteAuth`. Widen `RemoteChip['phase']` to `'live' | 'checking' | 'unreachable' | 'restarting' | 'signed-out' | 'no-access'`. Replace `remoteChip` with:

```ts
export function remoteChip(w: { kind: string; state: string; status?: string }, drain?: RemoteDrain | null, block?: RemoteBlockKind | null): RemoteChip | null {
  if (w.kind !== 'remote') return null;
  if (w.state !== 'unreachable') {
    if (block === 'not-signed-in' || block === 'expired') return { phase: 'signed-out', sub: 'signed out' };
    if (drain?.phase === 'draining') return { phase: 'restarting', sub: 'restarting · input paused' };
    if (drain?.phase === 'unknown') return { phase: 'restarting', sub: 'waiting for the workspace pod' };
    if (block === 'forbidden') return { phase: 'no-access', sub: 'no access' };
    return { phase: 'live', sub: null };
  }
  if (w.status === CHECKING_STATUS) return { phase: 'checking', sub: 'checking host…' };
  return { phase: 'unreachable', sub: 'host unreachable' };
}
```

In `remotePane`, change the unreachable body to:

```ts
`${where} isn't answering. Check your network, or that your VPN (Twingate) is connected. Its sessions reappear when it's back.`
```

Update any existing `remotePane` expectation in `remoteView.test.ts` to the new body.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/renderer/src/signedOutView.test.ts src/renderer/src/remoteView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/signedOutView.ts src/renderer/src/signedOutView.test.ts src/renderer/src/remoteView.ts src/renderer/src/remoteView.test.ts
git commit -m "feat(remote): pure rules for the signed-out banner, tab cards and reattach"
```

---

### Task 9: One shared device-flow controller and its panel

**Files:**
- Create: `src/renderer/src/signInFlow.ts`
- Create: `src/renderer/src/signInFlowInstance.ts`
- Create: `src/renderer/src/components/DeviceCodePanel.tsx`
- Test: `src/renderer/src/signInFlow.test.ts`

**Interfaces:**
- Consumes: `driveSignIn`, `parseIdentityError`, `countdown`, `SignInRun` (`accountView.ts`); `window.api.identity.signInStart/signInPoll/signInCancel`; `window.api.clipboard.write`.
- Produces:
  - `type SignInFlowState = { phase: 'idle' } | { phase: 'starting' } | { phase: 'waiting'; userCode: string; verificationUri: string; expiresAt: number } | { phase: 'error'; message: string }`
  - `interface SignInFlowApi { start(): Promise<SignInStart>; poll(): Promise<SignInPoll>; cancel(): Promise<void>; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void }`
  - `createSignInFlow(api): SignInFlow`, with `get()`, `subscribe(fn)`, `start()`, `cancel()` and `reset()`
  - `signInFlow` (the app singleton)
  - `useSignInFlow(): SignInFlowState`
  - `<DeviceCodePanel />`

- [ ] **Step 1: Write the failing tests** (`src/renderer/src/signInFlow.test.ts`)

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AccountStatus, SignInPoll } from '../../preload/identityTypes';
import { createSignInFlow, type SignInFlowApi, type SignInFlowState } from './signInFlow';

const START = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000, intervalMs: 5 };

function rig(polls: Array<SignInPoll | Error>, start: () => Promise<typeof START> = async () => START) {
  const api: SignInFlowApi = {
    start: vi.fn(start),
    poll: vi.fn(async () => {
      const p = polls.shift();
      if (!p) return new Promise<never>(() => undefined);
      if (p instanceof Error) throw p;
      return p;
    }),
    cancel: vi.fn(async () => undefined),
    now: () => 0,
    setTimer: (fn) => (queueMicrotask(fn), 0),
    clearTimer: () => undefined
  };
  const flow = createSignInFlow(api);
  const snaps: SignInFlowState[] = [];
  flow.subscribe(() => snaps.push(flow.get()));
  return { flow, api, snaps, states: () => snaps.map((s) => s.phase) };
}

describe('signInFlow (D173)', () => {
  it('shows the code while waiting and returns to idle on done', async () => {
    const r = rig([{ state: 'pending', intervalMs: 5 }, { state: 'done', status: {} as AccountStatus }]);
    await r.flow.start();
    expect(r.states()).toEqual(['starting', 'waiting', 'idle']);
    expect(r.snaps[1]).toEqual({ phase: 'waiting', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000 });
    expect(JSON.stringify(r.snaps)).not.toMatch(/token/i);
  });

  it('a cancel while main is still starting the flow never shows its code', async () => {
    let release: (v: typeof START) => void = () => undefined;
    const r = rig([], () => new Promise((ok) => (release = ok)));
    const p = r.flow.start();
    r.flow.cancel();
    release(START);
    await p;
    expect(r.states()).toEqual(['starting', 'idle']);
  });

  it('a second start while one runs is ignored', async () => {
    const r = rig([]);
    void r.flow.start();
    void r.flow.start();
    await Promise.resolve();
    expect(r.api.start).toHaveBeenCalledOnce();
  });

  it('an error from GitHub or from start shows its message', async () => {
    const r = rig([{ state: 'error', message: 'Sign-in was cancelled on GitHub.' }]);
    await r.flow.start();
    expect(r.flow.get()).toEqual({ phase: 'error', message: 'Sign-in was cancelled on GitHub.' });
    const n = rig([], async () => {
      throw new Error("Error invoking remote method 'identity:signInStart': Error: not-configured: Set the GitHub client ID");
    });
    await n.flow.start();
    expect(n.flow.get()).toEqual({ phase: 'error', message: 'Set the GitHub client ID' });
  });

  it('cancel stops polling, tells main, and goes idle', async () => {
    const r = rig([]);
    const p = r.flow.start();
    await Promise.resolve();
    r.flow.cancel();
    await p;
    expect(r.flow.get().phase).toBe('idle');
    expect(r.api.cancel).toHaveBeenCalledOnce();
  });

  it('reset drops a pending flow without cancelling main (signed in elsewhere)', async () => {
    const r = rig([]);
    const p = r.flow.start();
    await Promise.resolve();
    r.flow.reset();
    await p;
    expect(r.flow.get().phase).toBe('idle');
    expect(r.api.cancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/signInFlow.test.ts`
Expected: FAIL with "Cannot find module './signInFlow'".

- [ ] **Step 3: Implement**

`src/renderer/src/signInFlow.ts`:

```ts
// One device-flow sign-in shared by the signed-out banner and every remote tab card (D173).
// Main keeps one pending flow, so a start in Settings → Account replaces this one.
import type { SignInPoll, SignInStart } from '../../preload/identityTypes';
import { driveSignIn, parseIdentityError, type SignInRun } from './accountView';

export type SignInFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: 'error'; message: string };

export interface SignInFlowApi {
  start(): Promise<SignInStart>;
  poll(): Promise<SignInPoll>;
  cancel(): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export interface SignInFlow {
  get(): SignInFlowState;
  subscribe(fn: () => void): () => void;
  start(): Promise<void>;
  cancel(): void;
  /** Signed in some other way: stop polling without cancelling main's flow. */
  reset(): void;
}

export function createSignInFlow(api: SignInFlowApi): SignInFlow {
  let state: SignInFlowState = { phase: 'idle' };
  const subs = new Set<() => void>();
  let run: (SignInRun & { wake: () => void }) | null = null;
  /** Bumped by cancel and reset, so a start still in flight doesn't come back to life. */
  let gen = 0;
  const set = (s: SignInFlowState): void => {
    state = s;
    for (const fn of [...subs]) fn();
  };
  const stop = (): void => {
    if (!run) return;
    run.cancelled = true;
    run.wake();
    run = null;
  };
  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    async start() {
      if (state.phase === 'starting' || state.phase === 'waiting') return;
      const my = ++gen;
      set({ phase: 'starting' });
      let f: SignInStart;
      try {
        f = await api.start();
      } catch (e) {
        if (my === gen) set({ phase: 'error', message: parseIdentityError(e).message });
        return;
      }
      if (my !== gen) return;
      const r: SignInRun & { wake: () => void } = { cancelled: false, wake: () => undefined };
      run = r;
      set({ phase: 'waiting', userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt });
      const outcome = await driveSignIn(
        f,
        {
          now: api.now,
          poll: api.poll,
          wait: (ms) =>
            new Promise<void>((resolve) => {
              const h = api.setTimer(resolve, ms);
              r.wake = () => {
                api.clearTimer(h);
                resolve();
              };
            })
        },
        r
      );
      if (my !== gen) return;
      run = null;
      set(outcome.kind === 'error' ? { phase: 'error', message: outcome.message } : { phase: 'idle' });
    },
    cancel() {
      gen++;
      stop();
      set({ phase: 'idle' });
      void api.cancel().catch(() => undefined);
    },
    reset() {
      gen++;
      stop();
      if (state.phase !== 'idle') set({ phase: 'idle' });
    }
  };
}
```

`src/renderer/src/signInFlowInstance.ts`:

```ts
// The app's one sign-in flow, over the existing identity:* IPC (D173).
import { createSignInFlow } from './signInFlow';

export const signInFlow = createSignInFlow({
  start: () => window.api.identity.signInStart(),
  poll: () => window.api.identity.signInPoll(),
  cancel: async () => {
    await window.api.identity.signInCancel();
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
});
```

`src/renderer/src/components/DeviceCodePanel.tsx`:

```tsx
// Inline GitHub device-flow step for the signed-out banner and remote tab cards (D173).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { countdown } from '../accountView';
import type { SignInFlowState } from '../signInFlow';
import { signInFlow } from '../signInFlowInstance';

export function useSignInFlow(): SignInFlowState {
  return useSyncExternalStore(signInFlow.subscribe, signInFlow.get);
}

export function DeviceCodePanel() {
  const s = useSignInFlow();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (s.phase !== 'waiting') return;
    setCopied(false);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.phase]);

  if (s.phase === 'waiting') {
    return (
      <div className="device-flow inline">
        <span className="device-code" aria-label="Device code">{s.userCode}</span>
        <div className="device-actions">
          <button type="button" className="btn" onClick={() => void window.api.clipboard.write(s.userCode).then(() => setCopied(true), () => undefined)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a className="btn primary" href={s.verificationUri} target="_blank" rel="noreferrer">
            Open github.com/login/device
          </a>
          <button type="button" className="btn" onClick={() => signInFlow.cancel()}>
            Cancel
          </button>
        </div>
        <span className="device-countdown">Waiting for GitHub. The code expires in {countdown(s.expiresAt, now)}.</span>
      </div>
    );
  }
  return (
    <span className="device-flow-start">
      {s.phase === 'error' && <span className="device-flow-error">{s.message}</span>}
      <button type="button" className="btn primary" disabled={s.phase === 'starting'} onClick={() => void signInFlow.start()}>
        Sign in
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/signInFlow.test.ts src/renderer/src/accountView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/signInFlow.ts src/renderer/src/signInFlow.test.ts src/renderer/src/signInFlowInstance.ts src/renderer/src/components/DeviceCodePanel.tsx
git commit -m "feat(remote): one shared inline device-flow sign-in for banner and tabs"
```

---

### Task 10: App banner, state subscription and chip phases

**Files:**
- Create: `src/renderer/src/components/SignedOutBanner.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `src/renderer/src/remoteComponents.test.ts` (source guards)

**Interfaces:**
- Consumes:
  - `window.api.remote.authState`, `onAuth` (Task 7);
  - `signedOutBanner`, `blockFor`, `remoteChip(w, drain, block)` (Task 8);
  - `signInFlow`, `DeviceCodePanel` (Task 9);
  - `EMPTY_REMOTE_AUTH` (Task 6).
- Produces:
  - `<SignedOutBanner text />`;
  - the App state `remoteAuth: RemoteAuthState`;
  - `WorkspaceTabStrip` prop `remoteAuth: RemoteAuthState`;
  - CSS classes `.signed-out-banner`, `.ws-chip-group.signed-out`, `.ws-chip-group.no-access`, `.session-ended-card.remote.{wait,warn,danger}`, `.device-flow.inline`.

- [ ] **Step 1: Write the failing source guards** (append to `remoteComponents.test.ts`)

```ts
describe('signed-out UI (D173)', () => {
  const read = (p: string) => readFileSync(`src/renderer/src/${p}`, 'utf8');

  it('the banner and panel render text only and sign in through identity:* only', () => {
    for (const f of ['components/SignedOutBanner.tsx', 'components/DeviceCodePanel.tsx', 'signInFlowInstance.ts']) {
      const s = read(f);
      expect(s).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(s).not.toMatch(/\btoken\b/i);
    }
    expect(read('signInFlowInstance.ts').match(/window\.api\.[a-zA-Z]+/g)).toEqual([
      'window.api.identity', 'window.api.identity', 'window.api.identity'
    ]);
  });

  it('App shows the banner from the pure helper and resets the flow when signed back in', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/signedOutBanner\(remoteAuth, /);
    expect(app).toMatch(/if \(!remoteAuth\.signedOut\) signInFlow\.reset\(\)/);
    expect(app).toMatch(/<SignedOutBanner text=\{signedOutText\} \/>/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/remoteComponents.test.ts`
Expected: FAIL with ENOENT for `SignedOutBanner.tsx`.

- [ ] **Step 3: Implement**

`src/renderer/src/components/SignedOutBanner.tsx`:

```tsx
// App-wide signed-out banner with the inline device flow (D173).
import { DeviceCodePanel } from './DeviceCodePanel';

export function SignedOutBanner({ text }: { text: string }) {
  return (
    <div className="daemon-banner signed-out-banner" role="status">
      <span className="dot" aria-hidden="true" />
      <span className="signed-out-text">{text}</span>
      <DeviceCodePanel />
    </div>
  );
}
```

`App.tsx`:
- Import `SignedOutBanner`, `signInFlow` (from `./signInFlowInstance`), `signedOutBanner` (from `./signedOutView`), and `EMPTY_REMOTE_AUTH`/`type RemoteAuthState` (from `../../preload/remoteAuth`).
- After the `drains` effect:

```tsx
  const [remoteAuth, setRemoteAuth] = useState<RemoteAuthState>(EMPTY_REMOTE_AUTH);
  useEffect(() => {
    // A push that lands before the snapshot is newer than it.
    let pushed = false;
    void window.api.remote.authState().then((s) => { if (!pushed) setRemoteAuth(s); }).catch(() => undefined);
    return window.api.remote.onAuth((s) => { pushed = true; setRemoteAuth(s); });
  }, []);
  useEffect(() => {
    if (!remoteAuth.signedOut) signInFlow.reset();
  }, [remoteAuth.signedOut]);
```

- Next to `remoteBanner`:

```tsx
  const signedOutText = signedOutBanner(remoteAuth, workspaces.filter((w) => w.kind === 'remote').length);
  const hasBanners = backendReady === false || !!remoteBanner || !!storeBanner || !!signedOutText;
```

- Inside `.app-banners`, after the store banner: `{signedOutText && <SignedOutBanner text={signedOutText} />}`.
- Pass `remoteAuth={remoteAuth}` to `<WorkspaceTabStrip>`.

`WorkspaceTabStrip.tsx`:
- Import `blockFor` from `../signedOutView` and `type RemoteAuthState` from `../../../preload/remoteAuth`.
- Add the prop `/** Sign-in and connection state for remote chips (D170). */ remoteAuth: RemoteAuthState;`.
- Change `const rc = remoteChip(w, drains[w.id]);` to `const rc = remoteChip(w, drains[w.id], blockFor(remoteAuth, w.id));`.
- After `${rc?.phase === 'restarting' ? 'restarting' : ''}` in the className, add `${rc?.phase === 'signed-out' ? 'signed-out' : ''} ${rc?.phase === 'no-access' ? 'no-access' : ''}`.

`styles.css`, after the D152 block:

```css
/* Remote workspace signed out / no access (D170, D173). */
.daemon-banner.signed-out-banner {
  color: var(--wait);
  background: color-mix(in oklab, var(--wait) 10%, var(--bg));
  border-bottom-color: color-mix(in oklab, var(--wait) 30%, transparent);
  flex-wrap: wrap;
}
.daemon-banner.signed-out-banner .dot { background: var(--wait); animation: none; }
.device-flow.inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.device-flow.inline .device-code { font-size: 15px; padding: 0; }
.device-flow.inline .device-actions { margin-bottom: 0; }
.device-countdown { font-size: 12px; color: var(--ink-2); }
.device-flow-error { font-size: 12px; color: var(--danger); margin-right: 8px; }
.ws-chip-group.signed-out .ws-chip-sub { color: var(--wait); }
.ws-chip-group.signed-out .dot { background: var(--wait); }
.ws-chip-group.no-access .ws-chip-sub { color: var(--danger); }
.session-ended-card.remote.wait .session-ended-title { color: var(--wait); }
.session-ended-card.remote.warn .session-ended-title { color: var(--warn); }
.session-ended-card.remote.danger .session-ended-title { color: var(--danger); }
.session-ended-card.remote .device-flow.inline,
.session-ended-card.remote .device-flow-start { justify-content: center; align-self: center; }
```

- [ ] **Step 4: Run to verify**

Run: `npx vitest run src/renderer/src/remoteComponents.test.ts src/renderer/src/remoteView.test.ts` then `npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/SignedOutBanner.tsx src/renderer/src/App.tsx src/renderer/src/components/WorkspaceTabStrip.tsx src/renderer/src/styles.css src/renderer/src/remoteComponents.test.ts
git commit -m "feat(remote): signed-out banner with inline sign-in, and chip phases"
```

---

### Task 11: Remote tab cards, the attach gate and in-place reattach

**Files:**
- Modify: `src/renderer/src/App.tsx` (pass the per-workspace props)
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/components/TerminalSession.tsx`
- Test: `src/renderer/src/remoteComponents.test.ts` (source guards; the logic is covered in Task 8)

**Interfaces:**
- Consumes:
  - `skipAttach`, `attachErrorBlock`, `remoteEndKind`, `shownRemoteBlock`, `shouldReattach`, `remoteCard`, `type TabEnd` (Task 8);
  - `DeviceCodePanel` (Task 9).
- Produces:
  - `TerminalPane` props `remoteBlock?: RemoteBlockKind | null`, `authEpoch?: number`, `ssoUrl?: string | null`, `remoteName?: string`;
  - the same four props on `TerminalSession`.

- [ ] **Step 1: Write the failing source guards** (append to `remoteComponents.test.ts`)

```ts
describe('remote tab cards (D174–D176)', () => {
  const ts = () => readFileSync('src/renderer/src/components/TerminalSession.tsx', 'utf8');

  it('gates the attach on a sign-in block, as on paused', () => {
    expect(ts()).toMatch(/if \(skipAttach\(remoteRef\.current, remoteBlockRef\.current\)\)/);
  });

  it('maps a tagged attach error to the remote card and pty:end through remoteEndKind', () => {
    const s = ts();
    expect(s).toMatch(/attachErrorBlock\(err\)/);
    expect(s).toMatch(/remoteEndKind\(restartingRef\.current, remoteRef\.current \? remoteBlockRef\.current : null\)/);
  });

  it('reattaches through shouldReattach and renders fixed card copy only', () => {
    const s = ts();
    expect(s).toMatch(/shouldReattach\(/);
    expect(s).toMatch(/remoteCard\(shown, remoteName \?\? 'the host', ssoUrl \?\? null\)/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/remoteComponents.test.ts`
Expected: FAIL (patterns not found).

- [ ] **Step 3: Implement**

`App.tsx`: import `blockFor` from `./signedOutView` (next to `signedOutBanner`), and pass these to each `<TerminalPane>` next to `drain=`:

```tsx
                  remoteBlock={w.kind === 'remote' ? blockFor(remoteAuth, w.id) : null}
                  authEpoch={remoteAuth.epoch}
                  ssoUrl={w.kind === 'remote' ? remoteAuth.conns[w.id]?.ssoUrl ?? null : null}
                  remoteName={w.name}
```

`TerminalPane.tsx`: import `type RemoteBlockKind` from `../../../preload/remoteAuth`. Add to the props interface:

```ts
  /** Remote only: the tab card to show when attaching can't work (D170). */
  remoteBlock?: RemoteBlockKind | null;
  /** Bumped on every sign-in; remote tabs on a card reattach (D174). */
  authEpoch?: number;
  ssoUrl?: string | null;
  remoteName?: string;
```

Destructure them, and pass all four to each `<TerminalSession>` next to `restarting={rules.restarting}`:

```tsx
            remoteBlock={rules.remote ? remoteBlock ?? null : null}
            authEpoch={authEpoch ?? 0}
            ssoUrl={ssoUrl ?? null}
            remoteName={remoteName}
```

`TerminalSession.tsx`:
- Import `attachErrorBlock`, `remoteCard`, `remoteEndKind`, `shouldReattach`, `shownRemoteBlock`, `skipAttach` and `type TabEnd` from `../signedOutView`; `DeviceCodePanel` from `./DeviceCodePanel`; and `type RemoteBlockKind` from `../../../preload/remoteAuth`. Remove the now-unused `sessionEndKind` import if nothing else uses it.
- Add the same four props to `Props` and destructure them with defaults `remoteBlock = null, authEpoch = 0, ssoUrl = null, remoteName`.
- Next to `restartingRef`:

```ts
  const remoteBlockRef = useRef(remoteBlock);
  remoteBlockRef.current = remoteBlock;
```

- Change the `endedReason` state type to `useState<TabEnd | null>(null)`.
- In the attach effect, right after `if (paused) return;`:

```ts
      // Signed out: no attach until a sign-in moves authEpoch (D176).
      if (skipAttach(remoteRef.current, remoteBlockRef.current)) {
        setEndedReason({ kind: 'remote', block: remoteBlockRef.current! });
        onLifecycleChange?.(sessionId, 'ended');
        return;
      }
```

- In the `pty.onEnd` handler, replace the three lines from `const kind = sessionEndKind(…)` through `setEndedReason({ kind });` with:

```ts
            const end = remoteEndKind(restartingRef.current, remoteRef.current ? remoteBlockRef.current : null);
            endedInDrainRef.current = end.kind === 'restarting';
            setEndedReason(end);
```

- In the attach `catch`, replace `setEndedReason({ kind: 'attach-error', message: msg });` with:

```ts
          const block = remoteRef.current ? attachErrorBlock(err) : null;
          setEndedReason(block ? { kind: 'remote', block } : { kind: 'attach-error', message: msg });
```

- After the `resumeToken` effect:

```ts
  const shown = shownRemoteBlock(remote, endedReason, remoteBlock);
  const prevAuthRef = useRef({ epoch: authEpoch, block: remoteBlock });
  useEffect(() => {
    const prev = prevAuthRef.current;
    const next = { epoch: authEpoch, block: remoteBlock };
    prevAuthRef.current = next;
    if (shouldReattach(shownRemoteBlock(remote, endedReason, prev.block), prev, next)) setSessionEpoch((e) => e + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authEpoch, remoteBlock]);
```

- In the JSX, change the natural card's condition to `{endedReason?.kind === 'natural' && !shown && (`. Add before it:

```tsx
        {shown && (() => {
          const c = remoteCard(shown, remoteName ?? 'the host', ssoUrl ?? null);
          return (
            <div className="session-ended-overlay" role="status" aria-label={c.title}>
              <div className={`session-ended-card remote ${c.tone}`}>
                <div className="session-ended-title">{c.title}</div>
                <div className="session-ended-help">{c.body}</div>
                {c.action === 'sign-in' && <DeviceCodePanel />}
                {c.action === 'retry' && (
                  <button className="btn" onClick={() => setSessionEpoch((e) => e + 1)}>
                    Retry now
                  </button>
                )}
                {c.linkUrl && (
                  <a className="btn" href={c.linkUrl} target="_blank" rel="noreferrer">
                    Authorise on GitHub
                  </a>
                )}
              </div>
            </div>
          );
        })()}
```

- [ ] **Step 4: Run to verify**

Run:
```bash
npx vitest run src/renderer/src/
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build
```
Expected: all PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/TerminalSession.tsx src/renderer/src/remoteComponents.test.ts
git commit -m "feat(remote): calm per-tab cards, signed-out attach gate, reattach in place"
```

---

### Task 12: SPEC.md and the full gate

**Files:**
- Modify: `docs/SPEC.md`

**Interfaces:**
- Consumes: everything above.
- Produces: SPEC sections that match the code.

- [ ] **Step 1: Update `docs/SPEC.md`**

For each item below, edit the named section in the SPEC's existing style (plain bullets, decision numbers in parentheses). For the parts the #631 PR already documented, check its wording and add only what is missing.

- **§6 *Identity*:**
  - `IdentityService.onChange` (causes `sign-in`, `token-refreshed`, `sign-out`, `revoked`; fired after the vault write, only when the stored token changed; no token);
  - `recover(sentToken)` → `retry | expired | host-refused`, one flight per token, a GitHub 401 clears the token (D171);
  - expiring tokens: `REFRESH` stored next to `TOKEN`, refreshed 10 min before expiry without a client secret; a refused refresh keeps the token (D177).
- **§6 *Remote*:**
  - `remote:authState()` → `RemoteAuthState { signedOut, epoch, conns }` and the `remote:auth` push (D169);
  - the `remote-<kind>: ` attach-error tag (D175);
  - `RemoteError.auth` and retry-once on 401 for requests and socket opens;
  - the 401 message "The host refused the GitHub sign-in".
- **§7 *Vault layout*:** the `REFRESH` key under `identity:github` (JSON `{ refreshToken, expiresAt }`, `''` when none).
- **§7 *Remote host*:** the `reason` field on `request` and `upgrade` log lines (`authReason`: the fixed class, `no grant` without the login).
- **§8 *Remote panes*:**
  - a signed-out tab doesn't attach (D176);
  - tab cards per kind;
  - a natural end upgrades to a later sign-in or refusal block;
  - reattach on an epoch move or a cleared block (D174).
- **§8, new *Remote workspace signed out*** (after *Remote workspace restarting*):
  - the banner text and when it shows;
  - the inline device flow (one controller, superseded by a start in Settings);
  - chip phases `signed-out` (`--wait`) and `no-access` (`--danger`);
  - the precedence (D170);
  - the six-kind table.
- **§8 *Remote host unreachable*:** the pane body gains "Check your network, or that your VPN (Twingate) is connected."
- **§8 *Notifications*:** the `signed-out` kind, once per involuntary sign-out with a bookmark, through the policy, `dedupeKey: 'remote-signed-out'` (D172).
- **§9:**
  - `RemoteAuthState` carries no token and no host text;
  - the device flow uses the existing `identity:*` IPC;
  - a host can't sign the desktop out by itself (only GitHub's own 401 clears the token).
- **§10:**
  - `src/main/remoteAuth.ts`, `src/preload/remoteAuth.ts`;
  - `src/renderer/src/signedOutView.ts`, `signInFlow.ts`, `signInFlowInstance.ts`;
  - `components/DeviceCodePanel.tsx`, `components/SignedOutBanner.tsx`.
- **§11 *Remote host: what remains*:** a host checklist line for the six eyeball checks in the spec's *Testing* section.

- [ ] **Step 2: Run the full gate**

```bash
npx vitest run src/main src/renderer src/host
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx tsc -p tsconfig.host.json
npm run build
```
Expected: all PASS. Playwright doesn't run here (no display); CI runs it.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): signed-out failure mode for remote workspaces"
```

The PR body is factual: what changed, where, how to test, and the host eyeball checklist from the spec's *Testing* section. Also list the Tasks 1–5 interfaces that were taken from the #631 PR instead of built here. End the body with the attribution footer.
