# Signed-out failure mode for remote workspaces: design

Status: approved by the owner (Troy) on 2026-11-23. This spec records decisions D169–D177. The plan is `docs/superpowers/plans/2026-11-23-signed-out-ux.md`.

Issue: https://github.com/ImIOImI/claude-fleet/issues/631 (a desktop got 401 on every request after a host rollout; signing in again didn't help).

## Goal

When the desktop loses its GitHub sign-in, or a remote host stops accepting it:

- the user sees one clear signal and has one way to fix it;
- every remote tab recovers by itself once the sign-in is good again.

Each failure has its own message.

## Scope

- **Desktop main:**
  - an app-wide sign-in state and a per-bookmark connection state;
  - one notification per sign-out;
  - reconnecting every remote connection after a sign-in.
- **Desktop renderer:**
  - an app banner with an inline device flow;
  - a per-tab card;
  - remote chip phases;
  - pure helpers for every decision.
- **The #631 PR:** the plumbing under all of this, being built on `fix/remote-401-after-rollout`:
  - the root cause;
  - token refresh;
  - retry once on 401;
  - the 401 reason on the wire and in the host log;
  - reconnect after a re-sign-in.

  This design depends on it. *Interfaces from the #631 PR* lists the contract. The plan repeats each piece as an early task, flagged "may already exist after the #631 PR".
- **Out of scope:**
  - local and container workspaces, which don't use the GitHub sign-in;
  - mock mode, which lists no remote workspaces;
  - new settings: there are none, so the no-env/no-JSON rule has nothing to cover;
  - a redesign of Settings → Account. PR #630 is reworking it now (PAT sign-in), so this design leaves it unchanged.

## Today

- **Every 401 reads the same.** `RemoteClient.statusError` maps every 401 to "GitHub sign-in was rejected by the host; sign in again". That includes a request that carried no token and a token that GitHub still accepts.
- **The kind doesn't reach the renderer.** A failed `pty:attach` reaches it as the string `Error invoking remote method 'pty:attach': RemoteError: …`, because Electron drops the error's fields. Each tab then shows the generic "couldn't attach to the workspace" card, which suggests pulling a runner image.
- **Errors multiply.** Every remote tab fails on its own: N tabs give N attach errors, N `pty-attach-failed` log rows and N 401s to the host. Nothing is app-wide.
- **A socket closed with 4401 looks like a normal exit.** The tab gets a yellow notice line in its terminal, then the ordinary "claude session ended" card.
- **Nothing reacts to a re-sign-in.** Tabs stay on their error card until the user clicks Retry on each one. The `/events` subscription sits in its 30 s unauthorized backoff.
- **The host log can't say which case it saw.** Every 401 logs `status 401, login null`.

## Interfaces from the #631 PR

The UI layer needs the following. The #631 branch had no commits when this was written (it was at `ac5a184`, the same as `main`), so names may change. Whichever lands second adapts to the other. Plan Tasks 1–4 build any piece that is still missing.

1. **The 401 reason** (`remoteClient.ts`). `RemoteError` gains `auth?: 'expired' | 'host-refused'`, set only on `kind: 'unauthorized'`, after the retry-once below has run:
   - `expired`: GitHub itself rejects the token (`GET /user` 401). The identity service has cleared it (D171).
   - `host-refused`: GitHub accepts the token, but the host still answers 401. This covers the host's `missing or malformed bearer token`, a negative-cache hit (`token recently rejected`), and a proxy that strips `Authorization`.
   - The host already sends its reason in the 401 body (`{ error }`). The desktop reads it from the body; it is never shown verbatim.
   - A WebSocket upgrade's 401 is classified the same way, by the same retry path.
2. **Identity change events** (`IdentityService`). `onChange(fn: (c: IdentityChange) => void): () => void`, where `IdentityChange = { cause: 'sign-in' | 'token-refreshed' | 'sign-out' | 'revoked'; signedIn: boolean }`.
   - It fires after the vault write settles, and only when the stored token changed. A profile-only refresh is silent.
   - It never carries the token.
   - `revoked` covers both `status({ refresh: true })` clearing a rejected token and the recovery below.
   - After PR #630, a vault PAT that becomes active or is rejected also fires (`sign-in` / `revoked`).
3. **Recovery on 401** (`IdentityService.recover(sentToken: string): Promise<'retry' | 'expired' | 'host-refused'>`). It runs one flight per token:
   - If the stored token differs from `sentToken`, the answer is `retry`.
   - Else, if a refresh token is held, it refreshes, then answers `retry`.
   - Else it checks GitHub with `GET /user`: a 401 revokes the token (an `onChange` with `revoked`) and answers `expired`; a success or a network error answers `host-refused`.

   `RemoteClient` calls it once per request or socket open on a 401, and retries once on `retry`.
4. **Proactive refresh.** This applies only when GitHub issued an expiring token (`expires_in` plus `refresh_token` in the device-flow token response; GitHub Apps with expiring user tokens do this, OAuth Apps don't).
   - The vault keeps the refresh token and expiry next to `TOKEN`.
   - The service refreshes 10 minutes before expiry and fires `token-refreshed`. A failed refresh leaves the token in place until it is rejected (D177).
5. **Reconnect** (`RemoteBackend.reconnect(): void`). It re-probes every bookmark now and resets the summary relay (`SummaryRelay.reset()`: drop every subscription, then `sync`), which cancels the 30 s unauthorized backoff.
6. **The host log** (`src/host/server.ts`). The `request` and `upgrade` lines carry `reason`: the `AuthResult.error` class (`missing or malformed bearer token`, `token rejected by GitHub`, `token recently rejected`, `no grant`, `machine not permitted`). For `no grant`, the fixed class is logged, not the login-bearing message. No token material is logged.

## Design

### One app-wide state, owned by main (D169)

A new pure module, `src/main/remoteAuth.ts` (`createRemoteAuthMonitor`), owns:

- `signedOut: { reason: 'not-signed-in' | 'expired'; since } | null`. It comes only from the identity service: its state at start, then `onChange`. `revoked` gives `expired`; `sign-out`, or no token at start, gives `not-signed-in`.
- `epoch`: bumped on every `sign-in` and `token-refreshed`.
- `conns[workspaceId]: { kind, since, ssoUrl? }`, the last connection outcome per bookmark. It comes from three places:
  - the probe loop (`/healthz` plus `/whoami`, every 15 s);
  - remote attach failures;
  - `/events` disconnects.

`connKindOf(err)` maps a `RemoteError` to a kind: `not-signed-in`; `unauthorized` gives `expired` or `host-refused` by `err.auth`; `forbidden`; `unreachable` and `standby` give `unreachable`. Anything else (protocol, disabled, model) isn't a connection state and is ignored.

Main pushes the whole state, `RemoteAuthState { signedOut, epoch, conns }`, on every change:

- `remote:authState()` → `RemoteAuthState` (invoke, no arguments);
- `remote:auth` (push, main → renderer).

The state is small: one row per bookmark. The renderer only renders it. Every rule for which card or banner to show is a pure helper (`src/renderer/src/signedOutView.ts`).

### Six connection kinds and their precedence (D170)

The approved table has five cases. This design adds `host-refused` as a sixth kind. It is the #631 failure: a valid sign-in that the host refuses. Telling that user to sign in again sends them in circles (#631 ask 3).

| Kind | Tab card title | Body | Action | Tone |
|---|---|---|---|---|
| `not-signed-in` | Not signed in | Sign in to reconnect. Your sessions are still running on the host. | **Sign in** (inline device flow) | `--wait` |
| `expired` | Sign-in expired | Sign in to reconnect. Your sessions are still running on the host. | **Sign in** | `--wait` |
| `host-refused` | `<name>` didn't accept your sign-in; retrying | Your GitHub sign-in is valid. This tab reconnects by itself. | **Retry now** | `--warn` |
| `unreachable` | Can't reach `<name>`; retrying | Check your network, or that your VPN (Twingate) is connected. This tab reconnects by itself. | **Retry now** | `--warn` |
| `forbidden` | You don't have access to `<name>` | Ask the host's admins to add you to a team with access. | **Authorise on GitHub** link when SSO applies, else none | `--danger` |
| restarting (drain) | the existing "waiting for the host to restart" card and chip (D152) | | — | `--warn` |

Precedence for one tab, highest first:

1. `not-signed-in` / `expired`: the app-wide `signedOut` wins over any per-bookmark kind.
2. restarting.
3. `forbidden`.
4. `host-refused`.
5. `unreachable`.

The two sign-in kinds come first because nothing else can recover while they hold.

The chip in the top strip gains two phases:

- `signed-out`: sub-line `signed out`, `--wait` dot;
- `no-access`: sub-line `no access`, `--danger`.

`unreachable` and `checking` keep their current look. `host-refused` doesn't change the chip.

The existing unreachable pane (`remotePane`) gains the VPN (Twingate) hint.

### A GitHub-confirmed rejection signs the desktop out (D171)

When GitHub itself answers 401 for the stored token, the identity service clears it. `identity:status({ refresh: true })` already does this, and recovery on a host 401 (interface 3) now does it too. The cause is `revoked` and the reason shown is `expired`.

A 401 from the host alone never clears the token (`host-refused`). The host may be wrong, as in #631, and signing out wouldn't help.

### One notification per involuntary sign-out (D172)

The monitor calls its `notify` sink once per transition from signed in to signed out, and only when:

- the cause is `revoked`;
- at least one remote bookmark exists.

There is no notification for:

- the user's own Sign out;
- starting signed out;
- a second `revoked` while already signed out;
- any per-tab or per-host failure.

The sink goes through the normal notification policy (`notifyService.request`). Pause, downtime and rules apply, and the Activity tab records it. Its fields:

- `kind`: `signed-out` (a new `NotificationKind`; `notifications.kind` has no CHECK constraint, so it is a type-only change);
- `priority`: `high`;
- `source`: `{ kind: 'user', id: null }`;
- `dedupeKey`: `remote-signed-out`;
- title: "Signed out of GitHub";
- body: "Remote workspaces are paused. Your sessions are still running on the host. Open claude-fleet to sign in."

Delivery follows the usual rule: an OS notification when the window isn't focused, an in-app toast when it is.

### Sign in from the banner or a tab card (D173)

**The banner.** It sits in `.app-banners`, under the Docker, remote and store banners, and shows only while `signedOut` is set and at least one remote bookmark exists:

> Signed out of GitHub — remote workspaces are paused. Your sessions are still running on the host. **[Sign in]**

**One renderer controller.** `src/renderer/src/signInFlow.ts` (`createSignInFlow`) drives the existing `identity:signInStart` / `signInPoll` / `signInCancel` IPC through `accountView.driveSignIn`. The banner and every tab card share one instance. Its states are:

- `idle`;
- `starting`;
- `waiting { userCode, verificationUri, expiresAt }`;
- `error { message }`.

**What the panel shows.** While waiting, a shared `DeviceCodePanel` shows:

- the code;
- **Copy**;
- **Open github.com/login/device**: an `https://github.com` link that the window-open handler sends to the browser;
- the countdown;
- **Cancel**.

**Concurrent flows.** Main keeps one pending flow. Starting one in Settings → Account replaces the banner's; the banner's next poll then fails, and it shows the error with **Sign in** again. If the Settings sign-in succeeds, the `remote:auth` push clears the banner anyway.

**Account settings.** Settings → Account is unchanged. PR #630 is editing it, and keeping it unchanged avoids a conflict. It shares `driveSignIn` already.

**Token exposure.** None. The renderer sees `userCode` and `verificationUri`, as Settings → Account already does. The device code and the token stay in main.

### Recovery is driven by main (D174)

On an `onChange` with `signedIn: true` (`sign-in` or `token-refreshed`), the monitor:

1. clears `signedOut`;
2. bumps `epoch`;
3. drops every `conns` entry whose kind is `not-signed-in`, `expired` or `host-refused` (unknown until the next observation);
4. calls `reconnect()` (interface 5);
5. pushes the new state.

In the renderer, a tab that shows a remote card reattaches in place (a session-epoch bump, as Retry does) when either:

- `epoch` moved; or
- its bookmark's block cleared (any kind → none). This is how `unreachable`, `host-refused` and `forbidden` retry: the probe loop's next good `/whoami` clears the block, and the tab reattaches.

Live tabs are untouched. There is no restart, and no bookmark needs re-adding. While `host-refused` or `unreachable` holds, **Retry now** reattaches at once, and the probe loop retries every 15 s.

### Attach errors cross IPC with a stable tag (D175)

The remote backend's `attachPty` catches a `RemoteError` whose `connKindOf` is a block kind and does two things:

1. reports it to the monitor;
2. rethrows it with the message prefixed `remote-<kind>: ` (`src/preload/remoteAuth.ts` `remoteAttachTag`).

The renderer strips the Electron prefix (`remoteView.ipcErrorText`), then `parseRemoteAttachTag` reads the kind. An untagged error keeps today's attach-error card. This is the same pattern as `not-configured: …` for identity errors.

### Signed-out tabs don't attach (D176)

While the tab's block is `not-signed-in` or `expired`, `TerminalSession` sets up xterm but skips `pty:attach`, as it does while paused, and shows the card. This avoids N failing attaches, N log rows and N 401s to the host. The attach effect re-runs when the session epoch moves (D174).

A live tab whose socket the host closes with 4401 gets `pty:end`. The pure `remoteEndKind(restarting, block)` then picks the remote card instead of "claude session ended". If the push hasn't landed yet, the card is chosen when the block arrives: a tab that ended `natural` on a remote workspace and now has a block shows the block's card.

### Token refresh only for expiring tokens (D177)

GitHub OAuth App tokens don't expire, so with an OAuth App client, proactive refresh does nothing and `expired` means revoked. With a GitHub App client that issues expiring tokens:

- the service refreshes them with `grant_type=refresh_token`, sending the client id and no secret, since a desktop can't hold one;
- if GitHub refuses (for example `incorrect_client_credentials`), the token is kept until it is rejected, and the user then signs in once.

Open question for Troy: which kind of app is the org's client id?

## Failure modes

- **A push lost between main and renderer.** The renderer re-reads `remote:authState()` on mount, and every push carries the full state.
- **`/whoami` flapping between ok and unreachable.** Each transition re-pushes, and a tab on the unreachable card reattaches on the ok edge. That is at most one attempt per probe cycle (15 s) per host. Transitions are logged with `type: 'remote-auth'`, `level` `warn` for any block and `info` for ok.
- **A sign-in that succeeds while every host is down.** `epoch` moves and the tabs reattach. Attaches fail `unreachable`, and the tabs show that card and retry on the probe loop.
- **A second desktop window.** Every window gets the same push; the flow controller is per window.
- **PR #630's PAT.** A vault PAT that GitHub rejects falls back to the device token (PR #630). The change event fires `revoked` only when no usable token is left. Otherwise it fires `sign-in` with the device token, which reads as a token change.

## Security (§9 additions)

- No new token exposure.
  - `RemoteAuthState` carries kinds, times, an `https://github.com` SSO link (from `AccountStatus.sso`, already shown) and nothing else.
  - The device flow uses the existing `identity:*` IPC.
- `remote:authState` takes no arguments.
- Host-supplied text never reaches the cards. The 401 body is read only to classify it, and every card is fixed copy plus the local bookmark name.
- Clearing the token on a GitHub-confirmed 401 can only sign this desktop out. A host can't trigger it alone: the check is GitHub's `GET /user`, not the host's answer.

## Testing

- **Unit (vitest).**
  - Main: `remoteAuth.test.ts` (classification, transitions, notification once, recovery), and additions to `remote.test.ts` (tagging and observation) and `summaryRelay.test.ts` (`reset`).
  - Renderer: `signedOutView.test.ts` and `signInFlow.test.ts`.
  - Source guards in `remoteComponents.test.ts`: no host text in cards, and Sign in goes through `identity:*` only.
- **Gates.** Typecheck node and web separately, unit tests, and `npm run build`.
- **Host eyeball (Troy).** No display here.
  1. Sign out in Settings while a remote tab is open: banner, tab card, chip, and no OS notification.
  2. Revoke the app on GitHub, then wait or Refresh: exactly one notification, and the card reads "Sign-in expired".
  3. Use Sign in from the banner: the tabs reattach in place.
  4. Disconnect Twingate: unreachable card, then auto-reattach when it reconnects.
  5. A bookmark you have no grant on: "You don't have access".
  6. Roll the host: the drain chip shows, not a sign-in prompt.

## SPEC.md changes (same PR as the code)

- **§6 *Identity*:**
  - `onChange` and `recover`, and the refresh token next to `TOKEN` (if the #631 PR hasn't added them);
  - a GitHub-confirmed rejection clears the token (D171).
- **§6 *Remote*:**
  - `remote:authState()` and the `remote:auth` push, with the `RemoteAuthState` shape;
  - the attach-error tag (D175);
  - `RemoteError.auth` (if not added already).
- **§7 *Vault layout*:** the refresh-token and expiry keys under `identity:github` (if not added already).
- **§7 *Remote host*:** the `reason` field on `request` and `upgrade` log lines (if not added already).
- **§8 *Remote panes*:** signed-out tabs don't attach (D176); tab cards per kind; reattach on epoch or a cleared block (D174).
- **§8, a new *Remote workspace signed out* section** next to *Remote host unreachable* and *Remote workspace restarting*: the banner, the inline device flow, chip phases, precedence (D170), and the VPN hint added to *Remote host unreachable*.
- **§8 *Notifications*:** the `signed-out` kind, once per involuntary sign-out (D172).
- **§9:** the bullets in *Security* above.
- **§10:** new files `remoteAuth.ts`, `preload/remoteAuth.ts`, `signedOutView.ts`, `signInFlow.ts`, `DeviceCodePanel.tsx`, `SignedOutBanner.tsx`.
