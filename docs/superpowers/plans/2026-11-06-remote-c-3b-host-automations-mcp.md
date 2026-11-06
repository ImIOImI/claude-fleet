# Remote workspaces (c3b): host automations and the fleet-state MCP on the host socket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lease-holding `fleet-host` runs its workspace's automations (scheduler, runner, inbox, proposals) and serves the `claude-fleet-state` MCP tools to the container's sessions over a Unix socket, with every write fenced by the lease.

**Architecture:** `mcpServer.ts` splits into `mcpCore.ts` (protocol, caps, tools, handler seams; no Electron, no OpenTelemetry) and the desktop's `mcpServer.ts` (per-workspace sockets, Windows TCP, the SQLite default and the perf tools), which re-exports the core so every desktop import and the `tools/list` bytes stay the same. On the holder, after the fenced stores open, `fleet-host` starts the automation services on the fenced inbox store and serves the core on `FLEET_HOST_MCP_SOCKET`, with every connection's caller fixed to the hosted workspace. Both stop before the stores close. Sessions reach the socket through the existing container bridge, which `fleet-host` passes to every `claude` it creates as an inline `--mcp-config`.

**Tech Stack:** TypeScript (NodeNext for `src/host`), Node 22, `pg` + Kysely (part 3), vitest on SQLite and on PG 16 (`scripts/pg-test-server.sh`, `vitest.pg.config.ts`), Vite SSR multi-entry host bundle, bash.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §2 (automations run on their host), §3, §4, §7, §9, §11 item (c). `docs/SPEC.md` §7 *Remote host*, §8 *Automations*, §9, §11 *Remote host automations*, *In-container SQLite access via MCP*. The c3b outline at the end of `2026-11-04-remote-c-3-host-store.md`. Part 4a (`ReadSource`, #511), part 4b (#513). Container split: `superpowers/specs/2026-11-05-host-container-split-design.md` (D3, D4). `/shared/remote-agent-design/design-state.md`, `threads/001-kickoff.md` (2026-11-05T17:47Z: infra assumes the two-pod layout; transport pending Troy).

## Global Constraints

Every task implicitly includes these.

- **Spec, verbatim:**
  - "A remote workspace's automations, runs, proposals and todos live in its host's DB, and the host's scheduler runs them. Their steps target that workspace (`runIn: $self`, prompt steps to its own sessions). `runIn: host` and steps that target other workspaces are refused on a remote host, because it has no other workspaces and no desktop shell." (design §2)
  - "Until it holds the lease, the process is **standby**. It runs no scheduler or ingest, serves no RPC or attach, and creates no broker sessions." (design §3)
  - "Every write transaction checks `epoch` against the lease row inside the transaction. A stale holder's write fails, and the process drops to standby and exits." (design §3)
  - "**The host's MCP server** keeps the §11 invariants: read-only, scoped visibility, identity ambient from the socket." (design §9)
  - "A remote workspace is never a committee target or manager in the first release (`decideControl` keeps requiring `kind: 'container'`)." (design §9)
- **The desktop stays byte-for-byte.** `initialize` and `tools/list` are pinned by a snapshot taken before the split (Task 1). Every existing `src/main/mcp*.test.ts`, `roleBrief.test.ts` and `automationIpc.test.ts` passes unchanged. The desktop's refusal of remote automation targets ("remote automations run on their host", `backendRouter.REMOTE_AUTOMATION_MSG`) is untouched.
- **MCP caps, as on the desktop:** request lines ≤ 1 MiB (`MAX_LINE_BYTES`), ≤ 16 requests in flight per connection (`MAX_IN_FLIGHT_PER_CONNECTION`), tool errors clipped to 4 KiB, the 10 s stall breadcrumb. The host adds a cap of 64 open connections (B6).
- **Secrets:** nothing new reads a secret. MCP log rows go through the host logger, which redacts token shapes. Never log tool arguments beyond the core's existing 300-character excerpt.
- **c1–c3 seams unchanged:** `runHost`, `LeaseManager`, `startHolder` (extended, not replaced), `EventHub.publish` with `EVENT_CHANNELS`, `RpcChannel`, `HostServerDeps`. The config parser still refuses unknown keys; c3b adds exactly `automations`.
- **Part 3 rules:** dialect branches only in `src/main/store/*`; every list read has a total `ORDER BY`; errors name keys, never values.
- **Repo rules:** comments terse and necessary (`/workspace/.claude/rules/review-conventions.md`); SPEC.md updated in this PR (Task 8); every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Environment:**
  - Work in your own worktree: `W=/workspace/claude-fleet/.claude/worktrees/<name>`; use `git -C "$W"`; never `cd /workspace/claude-fleet`; never stage `.superpowers/`.
  - `npm ci --ignore-scripts --no-audit --no-fund` in the worktree, then `printf 'electron-stub' > node_modules/electron/path.txt`.
  - Typecheck the three configs separately: `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npx tsc -p tsconfig.host.json`.
  - Postgres tests: `scripts/pg-test-server.sh start`, export the `PG_TEST_URL` it prints, then `npx vitest run -c vitest.pg.config.ts <file>`.
  - Secret hygiene: never `bash -x`/`set -x`, `env` or `printenv`; this container holds a live `GH_TOKEN`.

## Decisions (recorded in SPEC.md by Task 8)

> As built, SPEC §7 *Host MCP* and *Host automations* supersede B2, B4 and B10 below: the split-mode socket is `/run/fleet/mcp/mcp.sock` in a fleet-host-owned 2750 `mcp/` dir, 13 tools are served (no propose tools), and definitions come only from the host config.

- **B1 — `mcpServer.ts` splits into `mcpCore.ts` and the desktop shell.**
  - `mcpCore.ts` holds the protocol (`initialize`, `tools/list`, `tools/call`), dispatch and caps, every tool except the three perf tools, the handler seams (`set*Handlers`, `setReadScopeResolver`, …), the read-source state and `serveMcpConnection(sock, callerId)`. It imports only pure modules: `mcpLines`, `store/readSource`, `pricing`, `clipText` (new, moved out of `errorLog.ts`), `vectors` (`EmbedFn` moves there from `transcriptIndex.ts`), `claims/searchHits`.
  - It reaches no logger: `setMcpLogSink(fn)` receives the rows the desktop wrote with `logError`. The desktop shell calls `setMcpLogSink(logError)` at load.
  - `mcpServer.ts` keeps the per-workspace Unix listeners, the Windows TCP listener and tokens, the MCP health status, `startMcpServer`'s SQLite default and `_setDbForTests`, and the perf tools (they reach `perf.ts`, `config.ts` and `perfSentinel.ts`), spliced into `TOOLS` right after `query` so `tools/list` keeps its order. It ends with `export * from './mcpCore.js'`, so no importer changes.
  - `setExposedTools(names | null)` limits `tools/list` and `tools/call` to a set. The desktop never calls it.
  - **Validated** in a scratch worktree on origin/main `624a31f`, removed afterwards: the snapshot test written before the split passes after it; `tsc -p tsconfig.node.json` is clean; the nine MCP, transcript-index, error-log, role-brief and automation-IPC test files pass (121 tests); the import walk from `mcpCore.ts` reaches only the five pure modules above (no `electron`, no `@opentelemetry/*`); a host bundle with a probe entry, copied outside `node_modules`, served `initialize`, a filtered `tools/list` and refused `perf_status` as `Unknown tool` under plain Node.
- **B2 — Transport: one Unix socket, holder only.**
  - `FLEET_HOST_MCP_SOCKET` (default `/run/fleet/mcp.sock`). Without `FLEET_HOST_MCP_SOCKET_GROUP`, the directory is created 0700 and the socket is 0600; sessions share fleet-host's uid in the single-container layout, so they can connect.
  - With `FLEET_HOST_MCP_SOCKET_GROUP=<gid>` (the container split), fleet-host leaves the directory alone, refuses to start unless it is a real directory in that group with group rwx and no access for others, and creates the socket 0660 in that group. This is the split's `cred.sock` rule (split D4), so the MCP socket sits beside `cred.sock` in `/run/fleet` with the same trust boundary: any session in the workspace container can connect, nothing else can.
  - **Two pods (Troy's pending decision; infra's identities assume it):** not built here. The core serves any stream whose caller the transport established (`serveMcpConnection`). The two-pod spec that carries `broker.sock` and `cred.sock` across pods (Istio mTLS with an `AuthorizationPolicy` admitting only the workspace pod's service account) adds an MCP listener the same way; nothing in the tools changes. The container bridge already speaks TCP with a first-line token (`CLAUDE_FLEET_MCP_TCP`, `CLAUDE_FLEET_MCP_TOKEN_FILE`), so the workspace side needs no new code.
  - Served only by the holder, after its stores open, and closed before they close. A standby has no socket; the bridge reconnects with backoff until the holder serves it.
- **B3 — Caller identity and scope.** Every connection on the host socket is the hosted workspace: `callerId` is the `host_meta` workspace id, fixed by fleet-host, never read from the wire. The read scope is exactly `{ workspaceId }`. The host config's `grants` map people to tiers, not workspaces to workspaces, so there are no read grants. Published partitions widen the scope in (e). Committee grants across hosts, and any committee tool on a host, belong to a later sub-project.
- **B4 — The host serves a fixed tool set.** `HOST_MCP_TOOLS`:
  - history, on `pgReadSource({ isolation: null })` over the holder's store: `list_sessions`, `get_session`, `get_cost`, `list_events`, `session_summary`;
  - inbox: `post_todo`, `update_todo`, `list_todos`;
  - automations: `list_automations`, `get_automation`, `list_runs`, `run_automation`, `schedule_next`, `propose_automation`, `propose_automation_change`, `get_proposal`.
  - Not served (`Unknown tool`), with where each goes: `query` ((d): role + RLS on the host), `search_transcripts` ((d): no embedder on the host), `list_errors` (the host logs to stdout, not the `errors` table), `notify` ((g): delivery goes through desktop policy), `mark_useful` ((e)), `committee_*` (later), `perf_*`, `plan_usage`, skills, claims, capture settings, `expose_port`, `get_config`, and the hook tools `signal_input_wait`, `report_session_mapping`, `report_summary_status` ((f)).
- **B5 — Fencing.** The MCP's writes (todos, proposals, `run_automation`) and the scheduler's go through the holder's fenced inbox store (c3 G5). A write after a takeover throws `LeaseLostError`, which ends the process (c3). Reads go through `readTransaction` and take no fence.
- **B6 — Caps and logging.** The core's caps are unchanged (Global Constraints). The host also refuses connections past 64 open ones, closing the new one. MCP log rows go to the host logger at their own level; `mcp-conn` and `mcp-conn-closed` are `debug` on the host, so a session's reconnect loop can't flood stdout.
- **B7 — Sessions get the tools through `--mcp-config`.** When `db:` is set, fleet-host appends `--mcp-config <inline JSON>` to every broker `CREATE` it sends (viewer CREATEs through `AttachHub`, and fresh automation sessions). The JSON names server `claude-fleet-state` (the prefix `INBOX_TOOLS` uses), runs `node /usr/local/lib/fleet-host/mcp-bridge.cjs`, and sets `CLAUDE_FLEET_MCP_UNIX` to the socket path. The bridge is written at image build by `fleet-host write-mcp-bridge <path>` from `mcpContainerBridge.ts`, so it has one source. `~/.claude.json` on the shared volume isn't touched.
- **B8 — The automation runtime on the holder** (`hostAutomations.ts`). Built on the fenced `stores.inbox`:
  - `createInboxService` with no `notifications` (delivery is (g)); `createAutomationService` and `createProposalService` with the deps below; `inbox.onTodoCreated` feeds `todo.created` events.
  - Workspaces: only the hosted one resolves, by id or by `workspace.name`. `workspaceState` is `running` for it and `null` otherwise; `ensureRunning` is a no-op; `busy` is false; `post` throws (live steps are refused, B9).
  - Fresh steps: `BrokerOps.create('auto-<runId>-<stepId>', 120, 40, [...args, '--session-id', <uuid>, ...mcpArgs])`; `freshState` from `BrokerOps.list()`; `closeFresh` attaches and closes, best-effort (a viewer may hold the session).
  - No `execScript`, no `secret`. Run failures and interrupted runs are logged; no notification is sent ((g)).
  - `recover()` at start, a 30 s tick, and `stop()` that clears the tick, cancels pending debounces and waits at most 2 s for in-flight runs. A run still in flight then fails its next write (stores closed or fenced) and is marked `interrupted` by the next holder's `recover()`.
  - The hosted workspace's sessions are `privileged` for the automation tools: every automation on the host belongs to that workspace.
  - Proposals: `trusted` is false, so every proposal waits for approval. Approving needs (g)'s RPC.
- **B9 — What a remote host refuses at validation.** `ResolveCtx` gains an optional `check(def)` hook, run after the existing validation (the desktop passes none). The host's check (`remoteHostRefusals`) refuses: script steps (no way yet to run them in the workspace container once the split lands; a broker exec op is follow-up work), `prompt.mode: live` (a multi-person host has no single "workspace session" to type into, and no busy detector), and `session.idle` / `workspace.started` events (no detector on the host). Other workspaces never resolve, so cross-workspace targets and `allowFrom` entries fail as "unknown workspace"; `runIn: host` is a script step and is refused with them.
- **B10 — Where host automations come from: the host config.** `automations:` in `config.yaml` is a list of `{ definition, enabled? }`. On start (after the stores open) and on every accepted reload, the holder reconciles them: it creates, updates (new version only when the normalized YAML differs), enables/disables and removes automations whose `origin` is `{ source: 'host-config' }`, keyed by name. `$self` in a definition means the hosted workspace. A definition that fails validation is logged and skipped, leaving its current row as it was. A name already used by an automation from elsewhere (an approved proposal) is logged and skipped. Sessions can still propose; those wait for (g). **Question for Troy** below.
- **B11 — Events.** `automations:changed` (`null`), `proposals:changed` (`null`) and `inbox:changed` (the counts) go to the `EventHub` (already allowlisted) on every change.
- **B12 — What (g) gets from the seam.** `startHolder` returns `automations: HostAutomations | null` with `{ automations, proposals, inbox }` (the service objects the desktop's IPC handlers call), so (g) registers `automations:*`, `proposals:*` and `inbox:*` as `RpcChannel`s without touching this runtime. c3b registers no RPC channel.

## Out of scope (where it goes)

| Item | Goes to |
|---|---|
| `query` on the host (role + RLS provisioning on Aurora), `search_transcripts` (embeddings on the host) | (d) |
| Published partitions in the MCP scope, `mark_useful` counting | (e) |
| Hook tools (`signal_input_wait`, `report_session_mapping`, `report_summary_status`), `broker_sessions` mapping for `auto-*`, per-owner attribution | (f) |
| `automations:*`, `proposals:*`, `inbox:*` RPC; approving host proposals; `notify` and run-failed notifications through desktop policy | (g) |
| Committee tools and cross-host committee grants | later sub-project |
| Script steps on the host (a broker exec op into the workspace container) | follow-up |
| The two-pod MCP listener | the two-pod transport spec (B2) |

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/main/clipText.ts` | create | `clipText` (moved from `errorLog.ts`, which re-exports it) |
| `src/main/vectors.ts` | modify | `EmbedFn` type (moved from `transcriptIndex.ts`, which re-exports it) |
| `src/main/mcpCore.ts` | create | protocol, caps, tools, seams, read-source state, `serveMcpConnection`, `setMcpLogSink`, `setExposedTools` |
| `src/main/mcpServer.ts` | rewrite | desktop transports, SQLite default, perf tools, `export *` of the core |
| `src/main/mcpServer.contract.test.ts` (+ `__snapshots__/mcpServer.contract.json`) | create | pins `initialize` + `tools/list` |
| `src/main/automations/definition.ts` | modify | `ResolveCtx.check` hook |
| `src/main/automations/automationService.ts`, `proposalService.ts` | modify | pass `deps.checkDefinition` into the ctx |
| `src/host/hostDefinition.ts` (+ test) | create | `remoteHostRefusals`, `hostResolver`, `substituteSelf` |
| `src/host/socketDir.ts` (+ test) | create | prepare a socket path: private dir, or a checked shared group dir |
| `src/host/hostMcp.ts` (+ test) | create | `startHostMcp`, `HOST_MCP_TOOLS`, `hostMcpArgs`, `HOST_MCP_BRIDGE` |
| `src/host/config.ts` (+ test) | modify | `HostEnv.mcpSocket`/`mcpSocketGroup`; `automations` block |
| `src/host/attachHub.ts` (+ test) | modify | `createArgs` option appended to viewer CREATEs |
| `src/host/mcpBridgeFile.ts` (+ test), `src/host/cli.ts` | create, modify | `write-mcp-bridge <path>` |
| `src/host/hostAutomations.ts` (+ test, + `.pg.test.ts`) | create | the runtime (B8), reconcile (B10), events (B11) |
| `src/host/holder.ts`, `src/host/main.ts` (+ `main.pg.test.ts`) | modify | start/stop order, reload hook, broker args |
| `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/{publish-runner,test-runner-images}.yml` | modify | new pure modules in the host graph |
| `docker/host/Dockerfile`, `docker/host/smoke.test.sh` | modify | `/run/fleet`, the bridge file |
| `docs/SPEC.md` | modify | §4, §7, §8, §9, §11 |

---

### Task 1: Split `mcpServer.ts` into `mcpCore.ts` and the desktop shell

The riskiest task: a mechanical move that must leave the desktop byte-for-byte. Validated end to end before this plan was written (B1).

**Files:**
- Create: `src/main/clipText.ts`, `src/main/mcpCore.ts`, `src/main/mcpServer.contract.test.ts`, `src/main/__snapshots__/mcpServer.contract.json` (generated)
- Modify: `src/main/errorLog.ts`, `src/main/vectors.ts`, `src/main/transcriptIndex.ts`, `src/main/mcpServer.ts`
- Modify: `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`

**Interfaces:**
- Produces (all from `src/main/mcpCore.ts`, also re-exported by `mcpServer.ts`):
  - everything `mcpServer.ts` exports today except `startMcpServer`, `stopMcpServer`, `ensureWorkspaceSocket`, `removeWorkspaceSocket`, `setMcpStatusListener`, `currentMcpStatus`, `_setDbForTests` (those stay in `mcpServer.ts`);
  - `interface McpLogEntry { source: 'main'; type: string; message: string; stack?: string; extra?: Record<string, unknown>; workspaceId?: string; sessionId?: string; level?: 'error' | 'warn' | 'info' }`;
  - `setMcpLogSink(fn: ((e: McpLogEntry) => void) | null): void`;
  - `setExposedTools(names: ReadonlySet<string> | null): void`;
  - `initReadSource(rs: OwnedReadSource | null): void` (null = storeless), `releaseReadSource(): void`, `currentReadSource(): OwnedReadSource | null`, `_setReadSourceForTests(rs: OwnedReadSource | null): void`;
  - `serveMcpConnection(sock: Socket, callerId: string): void`;
  - `trackConnection`, `dispatchLine`, `send`, `OVERSIZE_ERROR`, `type Out` (for the desktop's TCP handler).

- [ ] **Step 1: Write the contract test on the unmodified tree**

`src/main/mcpServer.contract.test.ts`:

```ts
// Pins the desktop MCP surface byte-for-byte across the mcpCore split.
import { describe, expect, it } from 'vitest';
import { handleMcpRequestForTests, TOOLS } from './mcpServer.js';

describe('desktop MCP contract', () => {
  it('initialize and tools/list are unchanged', async () => {
    const init = handleMcpRequestForTests('initialize');
    const list = handleMcpRequestForTests('tools/list');
    await expect(JSON.stringify({ init, list }, null, 2)).toMatchFileSnapshot('__snapshots__/mcpServer.contract.json');
    expect(TOOLS.map((t) => t.name).slice(8, 12)).toEqual(['query', 'perf_status', 'perf_set', 'perf_sentinel_set']);
  });
});
```

- [ ] **Step 2: Run it to write the snapshot, then commit both**

Run: `npx vitest run src/main/mcpServer.contract.test.ts`
Expected: PASS, `Snapshots 1 written`.

```bash
git -C "$W" add src/main/mcpServer.contract.test.ts src/main/__snapshots__/mcpServer.contract.json
git -C "$W" commit -m "test(mcp): pin the desktop initialize and tools/list output

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Move `clipText` and `EmbedFn` to pure modules**

`src/main/clipText.ts`:

```ts
/** `text` cut to `max` chars, marked when cut. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}
```

In `src/main/errorLog.ts`, delete the `clipText` function and its doc comment, add `import { clipText } from './clipText.js';` after the `ErrorRow` import, and put `export { clipText };` where the function was.

Append to `src/main/vectors.ts`:

```ts
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;
```

In `src/main/transcriptIndex.ts`, replace `export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;` with `export type { EmbedFn };`, and add `type EmbedFn` to its existing `./vectors.js` import: `import { encodeVector, decodeVector, topK, EMBED_MODEL_ID, EMBED_DIM, type EmbedFn } from './vectors.js';`.

- [ ] **Step 4: Create `mcpCore.ts` from `mcpServer.ts`**

Copy `src/main/mcpServer.ts` to `src/main/mcpCore.ts`, then edit the copy:

1. Replace the import block (from `import { createServer …` through `import { armSentinel … }`) with:

```ts
import type { Socket } from 'node:net';
import { lineSplitter, MAX_LINE_BYTES } from './mcpLines.js';
import { LIST_EVENT_COLS, LIST_EVENT_COL_ALLOWLIST, MAX_QUERY_BYTES, type OwnedReadSource, type ReadSource, type TokenGroup } from './store/readSource.js';
import { costFor } from './pricing.js';
import { clipText } from './clipText.js';
import { type EmbedFn } from './vectors.js';
import { sessionIdsFromClaimResults, sessionIdsFromQueryRows, sessionIdsFromTranscriptHits, type SearchHitEvent } from './claims/searchHits.js';
```

2. Delete the Windows comment and `const isWindows = …`.
3. Replace `reportListenerError` and its doc comment with:

```ts
/** One error-log row; the desktop routes it to errorLog.ts, fleet-host to its logger. */
export interface McpLogEntry {
  source: 'main';
  type: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: 'error' | 'warn' | 'info';
}
let logSink: ((e: McpLogEntry) => void) | null = null;
export function setMcpLogSink(fn: ((e: McpLogEntry) => void) | null): void {
  logSink = fn;
}
function logError(e: McpLogEntry): void {
  logSink?.(e);
}

/** Tools this process serves; null serves every tool. */
let exposedTools: ReadonlySet<string> | null = null;
export function setExposedTools(names: ReadonlySet<string> | null): void {
  exposedTools = names;
}
function servedTools(): Tool[] {
  return exposedTools ? TOOLS.filter((t) => exposedTools!.has(t.name)) : TOOLS;
}
```

4. Delete `let userDataDir …`. Keep `readSource`, `storeless` and `STATE_DB_TOOLS`.
5. Delete everything from `// One listening socket per workspace` up to (not including) `const OVERSIZE_ERROR`, **except** `setReadSource` (keep it as is). In its place add:

```ts
/** Attach a read source at startup; null starts storeless (STATE_DB_TOOLS report unavailable). */
export function initReadSource(rs: OwnedReadSource | null): void {
  readSource = rs;
  storeless = rs === null;
}

/** Close and drop the read source (server stop). */
export function releaseReadSource(): void {
  void readSource?.close().catch(() => undefined);
  readSource = null;
  storeless = false;
}

export function currentReadSource(): OwnedReadSource | null {
  return readSource;
}

/** Test-only: replace the read source without changing storeless. */
export function _setReadSourceForTests(rs: OwnedReadSource | null): void {
  readSource = rs;
}
```

6. `const OVERSIZE_ERROR` → `export const OVERSIZE_ERROR`. Rename `function handleConnection(` to `export function serveMcpConnection(` with the doc comment `/** Serve one connection whose caller id the transport established. */`. `function trackConnection(` → `export function trackConnection(`.
7. Delete `handleTcpConnection` and its doc comment.
8. `function dispatchLine(` → `export function dispatchLine(`; `function send(sock` → `export function send(sock`; `type Out =` → `export type Out =`.
9. In `handleMethod`, `tools: TOOLS.map(` → `tools: servedTools().map(`. In `callTool`, `TOOLS.find((t) => t.name === name)` → `servedTools().find((t) => t.name === name)`.
10. Delete `_setDbForTests` and its doc comment.
11. Delete the three perf tools: from the `// Perf-telemetry tools.` comment up to (not including) `// Cross-workspace committee control`.

- [ ] **Step 5: Rewrite `mcpServer.ts` as the desktop shell**

Replace the file with: the header and imports below; then, moved verbatim from the old file, the Windows comment and `const isWindows`, `reportListenerError` (with its comment), `let userDataDir: string | null = null;`, the `listeners`/`tcpListener`/token maps, the MCP status block, `startMcpServer`, `ensureWorkspaceSocket`, `ensureWorkspaceToken`, `removeWorkspaceSocket`, `stopMcpServer` and `handleTcpConnection`; then the tail below.

```ts
// The desktop's fleet-state MCP transport: one Unix listener per workspace
// (Windows: one loopback TCP listener, token per workspace) over mcpCore.ts,
// plus the tools that reach Electron (perf). SPEC §11 *Fleet-state MCP*.
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sqliteReadSource } from './sqliteReadSource.js';
import { lineSplitter } from './mcpLines.js';
import type { OwnedReadSource, ReadSource } from './store/readSource.js';
import { logError } from './errorLog.js';
import { ensureContainerBridgeScript } from './mcpContainerBridge.js';
import { describeListenerError, type ListenerScope } from './mcpListenerError.js';
import { type McpStatus } from './mcpStatusBroadcast.js';
import { mcpWorkspaceSocketDir, mcpWorkspaceSocketPath, mcpWorkspaceTokenPath, MCP_TCP_PORT } from './mcpSocket.js';
import { getPerfStatus, reconfigurePerf, getEffectivePerf } from './perf.js';
import { getPerfTelemetry, setPerfTelemetry, getPerfOtlp } from './config.js';
import { resolvePerfConfig } from './perfConfig.js';
import { armSentinel, disarmSentinel } from './perfSentinel.js';
import {
  currentReadSource, dispatchLine, initReadSource, OVERSIZE_ERROR, releaseReadSource, send, serveMcpConnection, setMcpLogSink, trackConnection,
  _setReadSourceForTests, TOOLS, type Tool
} from './mcpCore.js';

export * from './mcpCore.js';

setMcpLogSink(logError);
```

Edits inside the moved functions:
- `startMcpServer`: replace the `if (opts.readSource === null) { storeless = true; } else { readSource = … }` block with
  `initReadSource(opts.readSource === null ? null : opts.readSource ?? sqliteReadSource(new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true })));`
- `ensureWorkspaceSocket`: `createServer((sock) => handleConnection(sock, id))` → `createServer((sock) => serveMcpConnection(sock, id))`.
- `removeWorkspaceSocket`: `void readSource?.forgetCaller(id)` → `void currentReadSource()?.forgetCaller(id)`.
- `stopMcpServer`: replace the three lines `void readSource?.close()…; readSource = null; storeless = false;` with `releaseReadSource();`.

Tail of the file:

```ts
/** Test-only: swap the read-only DB handle without a real listener. */
export function _setDbForTests(db: Database.Database | null): void {
  _setReadSourceForTests(db ? sqliteReadSource(db) : null);
}

// Perf tools reach Electron and OpenTelemetry, so they live here, listed right after `query`.
const PERF_TOOLS: Tool[] = [
  // (the three perf tool objects, moved verbatim from the old TOOLS array, comment included)
];
TOOLS.splice(TOOLS.findIndex((t) => t.name === 'query') + 1, 0, ...PERF_TOOLS);
```

The `PERF_TOOLS` body is the old file's lines from `// Perf-telemetry tools.` through the closing `},` of `perf_sentinel_set`, unchanged.

- [ ] **Step 6: Typecheck and run the desktop MCP tests**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no output.

Run: `npx vitest run src/main/mcpServer.contract.test.ts src/main/mcpServer.test.ts src/main/mcpReadSource.test.ts src/main/mcpServer.planUsage.test.ts src/main/mcpListenerError.test.ts src/main/automations/roleBrief.test.ts src/main/automations/automationIpc.test.ts src/main/transcriptIndex.test.ts src/main/errorLog.test.ts`
Expected: 9 files, all PASS. The contract snapshot is unchanged (`git -C "$W" diff --exit-code src/main/__snapshots__/mcpServer.contract.json`).

- [ ] **Step 7: Put the core in the host import graph**

In `src/host/importGraph.test.ts`, add `join(SRC, 'main', 'mcpCore.ts')` to `ENTRIES`, and extend `MAIN_ALLOWED`:

```ts
  /^main\/(db|asyncCache|contextWindow|pricing|usageAnchors|userPromptText|vectors|mcpCore|mcpLines|clipText)\.ts$/,
  /^main\/claims\/searchHits\.ts$/,
  /^main\/store\/(kysely|postgres|pgMigrate|storeConfig|passwordProvider|pgSsl|pgScramOnly|sqliteFiles|pgStores|pgVectorSearch|stateSchema|inboxSchema|readSource)\.ts$/,
```

(the first and third lines replace the existing `db|…|vectors` and `store/(…)` lines). Add the same five files to `.dockerignore` (after `!src/main/vectors.ts`) and to the `paths` lists of `publish-runner.yml` (`on.push.paths`) and `test-runner-images.yml` (`on.pull_request.paths`):

```
!src/main/mcpCore.ts
!src/main/mcpLines.ts
!src/main/clipText.ts
!src/main/claims/searchHits.ts
!src/main/store/readSource.ts
```

(workflow entries are the same paths without `!`, quoted, e.g. `      - 'src/main/mcpCore.ts'`).

Run: `npx vitest run src/host/importGraph.test.ts`
Expected: PASS (5 tests). If it lists a file outside the allowlist, the split left an Electron path behind; fix the import, never the allowlist.

- [ ] **Step 8: Commit**

```bash
git -C "$W" add src/main/clipText.ts src/main/errorLog.ts src/main/vectors.ts src/main/transcriptIndex.ts src/main/mcpCore.ts src/main/mcpServer.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml
git -C "$W" commit -m "refactor(mcp): split the tool server into an Electron-free mcpCore

mcpServer.ts keeps the desktop transports, the SQLite default and the perf
tools, and re-exports the core; tools/list is unchanged (contract snapshot).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: What a remote host refuses in a definition

**Files:**
- Modify: `src/main/automations/definition.ts` (`ResolveCtx`, end of `validateDefinition`)
- Modify: `src/main/automations/automationService.ts` (`AutomationDeps`, the `ctx` const), `src/main/automations/proposalService.ts` (`ProposalDeps`, the `ctx` const)
- Create: `src/host/hostDefinition.ts`, `src/host/hostDefinition.test.ts`
- Test: `src/main/automations/definition.test.ts`

**Interfaces:**
- Produces:
  - `ResolveCtx.check?(def: AutomationDef): string[]` (definition.ts);
  - `AutomationDeps.checkDefinition?(def: AutomationDef): string[]`, `ProposalDeps.checkDefinition?(def: AutomationDef): string[]`;
  - `remoteHostRefusals(def: AutomationDef): string[]`;
  - `hostResolver(workspace: { id: string; name: string }): (idOrName: string) => string | null`;
  - `substituteSelf(def: unknown, workspaceId: string): unknown`.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/automations/definition.test.ts`:

```ts
describe('ResolveCtx.check', () => {
  const base = { name: 'nightly', triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: 'ws', mode: 'fresh', message: 'hi' } }] };
  it('runs after validation and its errors fail the definition', () => {
    const r = validateDefinition(base, { workspace: (v) => (v === 'ws' ? 'W1' : null), check: (d) => (d.steps.length ? ['nope'] : []) });
    expect(r).toEqual({ ok: false, errors: ['nope'] });
  });
  it('is skipped when validation already failed', () => {
    const check = vi.fn(() => ['never']);
    const r = validateDefinition({ ...base, name: 'Bad Name' }, { workspace: () => 'W1', check });
    expect(r.ok).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
```

(add `vi` to the file's vitest import if it isn't there.)

`src/host/hostDefinition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateDefinition } from '../main/automations/definition.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const ctx = { workspace: hostResolver(WS), check: remoteHostRefusals };
const fresh = { id: 'go', prompt: { workspace: 'review-bot', mode: 'fresh', message: 'review' } };

describe('remote host definitions', () => {
  it('accepts a scheduled fresh prompt step on the hosted workspace, by name or id', () => {
    expect(validateDefinition({ name: 'a', triggers: [{ schedule: { cron: '0 9 * * 1-5' } }], steps: [fresh] }, ctx).ok).toBe(true);
    expect(validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: WS.id } }] }, ctx).ok).toBe(true);
  });
  it('refuses another workspace', () => {
    const r = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: 'other' } }] }, ctx);
    expect(r).toEqual({ ok: false, errors: ['steps[0].prompt.workspace: unknown workspace "other"'] });
  });
  it('refuses live steps, script steps and the idle/started events', () => {
    const live = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ ...fresh, prompt: { ...fresh.prompt, mode: 'live' } }] }, ctx);
    expect(live).toEqual({ ok: false, errors: ['steps[0] (go): mode: live is not available on a remote host; use mode: fresh'] });
    const script = validateDefinition({ name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', script: { run: 'echo hi' } }] }, { ...ctx, hostShells: ['bash'] });
    expect(script).toEqual({ ok: false, errors: ['steps[0] (s): script steps are not available on a remote host yet'] });
    const idle = validateDefinition({ name: 'a', triggers: [{ event: { on: 'session.idle' } }], steps: [fresh] }, ctx);
    expect(idle).toEqual({ ok: false, errors: ['triggers[0]: session.idle events are not available on a remote host'] });
  });
  it('substitutes $self in prompt workspaces, event workspaces and allowFrom', () => {
    const d = substituteSelf({ name: 'a', triggers: [{ manual: { allowFrom: ['$self'] } }, { event: { on: 'todo.created', workspace: '$self' } }], steps: [{ ...fresh, prompt: { ...fresh.prompt, workspace: '$self' } }] }, WS.id) as {
      triggers: Array<{ manual?: { allowFrom: string[] }; event?: { workspace: string } }>; steps: Array<{ prompt: { workspace: string } }>;
    };
    expect(d.triggers[0].manual!.allowFrom).toEqual([WS.id]);
    expect(d.triggers[1].event!.workspace).toBe(WS.id);
    expect(d.steps[0].prompt.workspace).toBe(WS.id);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/automations/definition.test.ts src/host/hostDefinition.test.ts`
Expected: FAIL — `check` is not called (definition test) and `Cannot find module './hostDefinition.js'`.

- [ ] **Step 3: Add the hook**

In `src/main/automations/definition.ts`, add to `ResolveCtx`:

```ts
  /** Extra refusals for where this definition will run (fleet-host); runs only on an otherwise valid definition. */
  check?(def: AutomationDef): string[];
```

and in `validateDefinition`, replace `return { ok: true, value: def };` with:

```ts
  const refused = ctx.check?.(def) ?? [];
  return refused.length ? { ok: false, errors: refused } : { ok: true, value: def };
```

In `automationService.ts`, add to `AutomationDeps`:

```ts
  /** Refusals for this runtime (fleet-host's remoteHostRefusals). */
  checkDefinition?(def: AutomationDef): string[];
```

and change the `ctx` const to:

```ts
  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v), get hostShells() { return deps.hostShells?.(); }, check: deps.checkDefinition };
```

In `proposalService.ts`, add the same field to `ProposalDeps` (import `AutomationDef` as a type from `../../preload/inboxTypes.js` if the file doesn't already) and the same `check: deps.checkDefinition` to its `ctx` const.

- [ ] **Step 4: Write `src/host/hostDefinition.ts`**

```ts
// What a definition may do on a remote host (SPEC §7 *Host automations*).
import type { AutomationDef } from '../preload/inboxTypes.js';

const NO_EVENTS = new Set(['session.idle', 'workspace.started']);

export function remoteHostRefusals(def: AutomationDef): string[] {
  const errors: string[] = [];
  def.triggers.forEach((t, i) => {
    if ('event' in t && NO_EVENTS.has(t.event.on)) errors.push(`triggers[${i}]: ${t.event.on} events are not available on a remote host`);
  });
  def.steps.forEach((s, i) => {
    if ('script' in s) errors.push(`steps[${i}] (${s.id}): script steps are not available on a remote host yet`);
    else if ((s.prompt.mode ?? 'live') === 'live') errors.push(`steps[${i}] (${s.id}): mode: live is not available on a remote host; use mode: fresh`);
  });
  return errors;
}

/** Only the hosted workspace resolves, by id or name. */
export function hostResolver(workspace: { id: string; name: string }): (idOrName: string) => string | null {
  return (v) => (v === workspace.id || v === workspace.name ? workspace.id : null);
}

/** `$self` (as in loadout automations) means the hosted workspace. */
export function substituteSelf(def: unknown, workspaceId: string): unknown {
  return JSON.parse(JSON.stringify(def ?? null), (_k, v: unknown) => (v === '$self' ? workspaceId : v));
}
```

`validateSteps` stores `mode` with the parser's default (`p.mode ?? 'live'`), so the `??` only guards hand-built defs.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/main/automations/ src/host/hostDefinition.test.ts`
Expected: PASS (all automation tests unchanged, plus the new ones).

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/main/automations/definition.ts src/main/automations/definition.test.ts src/main/automations/automationService.ts src/main/automations/proposalService.ts src/host/hostDefinition.ts src/host/hostDefinition.test.ts
git -C "$W" commit -m "feat(automations): a check hook on definitions; what a remote host refuses

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The host MCP socket

**Files:**
- Create: `src/host/socketDir.ts`, `src/host/socketDir.test.ts`, `src/host/hostMcp.ts`, `src/host/hostMcp.test.ts`
- Modify: `src/host/config.ts` (`HostEnv`, `readHostEnv`), `src/host/config.test.ts`

**Interfaces:**
- Consumes: Task 1's `serveMcpConnection`, `setMcpLogSink`, `setExposedTools`, `initReadSource`, `releaseReadSource`, `setReadScopeResolver`, `McpLogEntry`.
- Produces:
  - `HostEnv.mcpSocket: string` (env `FLEET_HOST_MCP_SOCKET`, default `/run/fleet/mcp.sock`), `HostEnv.mcpSocketGroup: number | null` (env `FLEET_HOST_MCP_SOCKET_GROUP`);
  - `prepareSocketPath(path: string, group: number | null): Promise<void>`, `finishSocket(path: string, group: number | null): Promise<void>`;
  - `HOST_MCP_TOOLS: ReadonlySet<string>`, `MAX_HOST_MCP_CONNECTIONS = 64`;
  - `startHostMcp(o: { socketPath: string; socketGroup: number | null; workspaceId: string; readSource: OwnedReadSource; log: Logger; maxConnections?: number }): Promise<HostMcp>`, `interface HostMcp { close(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

`src/host/socketDir.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishSocket, prepareSocketPath } from './socketDir.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sd-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const listen = (p: string) => new Promise<() => void>((r) => { const s = createServer().listen(p, () => r(() => s.close())); });

describe('prepareSocketPath / finishSocket', () => {
  it('private mode: makes the directory 0700 and the socket 0600', async () => {
    const p = join(tmp(), 'run', 'mcp.sock');
    await prepareSocketPath(p, null);
    const close = await listen(p);
    await finishSocket(p, null);
    expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    close();
  });
  it('replaces a stale socket and refuses a regular file in its place', async () => {
    const d = tmp();
    const p = join(d, 'mcp.sock');
    const close = await listen(p);
    close();
    await expect(prepareSocketPath(p, null)).resolves.toBeUndefined();
    writeFileSync(p, 'x');
    await expect(prepareSocketPath(p, null)).rejects.toThrow(/exists and is not a socket/);
  });
  it('group mode: needs a real directory in the group with no access for others, and makes the socket 0660', async () => {
    const gid = process.getgid!();
    const d = join(tmp(), 'run');
    mkdirSync(d);
    chmodSync(d, 0o770);
    const p = join(d, 'mcp.sock');
    await prepareSocketPath(p, gid);
    const close = await listen(p);
    await finishSocket(p, gid);
    const st = statSync(p);
    expect([st.mode & 0o777, st.gid]).toEqual([0o660, gid]);
    close();
    chmodSync(d, 0o777);
    await expect(prepareSocketPath(p, gid)).rejects.toThrow(/fleet-host-entry prep/);
    const link = join(tmp(), 'link');
    symlinkSync(d, link);
    await expect(prepareSocketPath(join(link, 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
    await expect(prepareSocketPath(join(tmp(), 'missing', 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
  });
});
```

`src/host/hostMcp.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInboxHandlers } from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import { createLogger } from './log.js';
import { HOST_MCP_TOOLS, startHostMcp, type HostMcp } from './hostMcp.js';

const WS = '01JC0000000000000000000000';
const rs = { queryFlavor: null, close: async () => undefined, forgetCaller: async () => undefined } as unknown as OwnedReadSource;

let mcp: HostMcp | null = null;
let dir = '';
afterEach(async () => {
  await mcp?.close();
  mcp = null;
  setInboxHandlers(null);
  rmSync(dir, { recursive: true, force: true });
});

async function start(lines: string[], maxConnections?: number) {
  dir = mkdtempSync(join(tmpdir(), 'hm-'));
  const socketPath = join(dir, 'run', 'mcp.sock');
  mcp = await startHostMcp({ socketPath, socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger((l) => lines.push(l)), maxConnections });
  return socketPath;
}

function rpc(path: string, msgs: object[]): Promise<Array<Record<string, any>>> {
  return new Promise((resolve, reject) => {
    const c: Socket = connect(path);
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      buf += d;
      const lines = buf.trim().split('\n').filter(Boolean);
      if (lines.length >= msgs.length) { c.destroy(); resolve(lines.map((l) => JSON.parse(l))); }
    });
    c.on('error', reject);
    for (const m of msgs) c.write(JSON.stringify(m) + '\n');
  });
}

describe('startHostMcp', () => {
  it('serves only the host tool set, as the hosted workspace', async () => {
    const seen: string[] = [];
    setInboxHandlers({
      post: async (callerId) => { seen.push(callerId); return { id: 't1' }; },
      update: async () => ({}), list: async () => [], notify: async () => ({})
    });
    const p = await start([]);
    const [init, list, perf, post] = await rpc(p, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'perf_status', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'post_todo', arguments: { title: 'x' } } }
    ]);
    expect(init.result.serverInfo.name).toBe('claude-fleet-state');
    expect(new Set(list.result.tools.map((t: { name: string }) => t.name))).toEqual(HOST_MCP_TOOLS);
    expect(perf.error.message).toBe('Unknown tool: perf_status');
    expect(post.result.isError).toBeUndefined();
    expect(seen).toEqual([WS]);
  });

  it('refuses connections past the cap', async () => {
    const p = await start([], 1);
    const first = connect(p);
    await new Promise((r) => first.once('connect', r));
    const second = connect(p);
    await new Promise<void>((r) => second.once('close', () => r()));
    first.destroy();
  });

  it('logs connection rows at debug and keeps the 1 MiB line cap', async () => {
    const lines: string[] = [];
    const p = await start(lines);
    const [over] = await rpc(p, [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1 << 20) } }]);
    expect(over.error.code).toBe(-32600);
    expect(lines.some((l) => /"level":"debug".*"msg":"mcp-conn"/.test(l))).toBe(true);
  });
});
```

Add to `src/host/config.test.ts` in the `readHostEnv` describe:

```ts
  it('reads the MCP socket and its group', () => {
    expect(readHostEnv({}).mcpSocket).toBe('/run/fleet/mcp.sock');
    expect(readHostEnv({}).mcpSocketGroup).toBeNull();
    expect(readHostEnv({ FLEET_HOST_MCP_SOCKET: '/x/m.sock', FLEET_HOST_MCP_SOCKET_GROUP: '1500' })).toMatchObject({ mcpSocket: '/x/m.sock', mcpSocketGroup: 1500 });
    expect(() => readHostEnv({ FLEET_HOST_MCP_SOCKET_GROUP: 'staff' })).toThrow(/FLEET_HOST_MCP_SOCKET_GROUP/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/socketDir.test.ts src/host/hostMcp.test.ts src/host/config.test.ts`
Expected: FAIL — missing modules and `mcpSocket` undefined.

- [ ] **Step 3: Implement `readHostEnv` fields**

In `src/host/config.ts`, add to `HostEnv`:

```ts
  /** The fleet-state MCP socket the holder serves to sessions. */
  mcpSocket: string;
  /** Shared-group mode (container split): the directory is prepped and checked, the socket is 0660 in this group. */
  mcpSocketGroup: number | null;
```

and in `readHostEnv`, before `return`:

```ts
  const groupText = env.FLEET_HOST_MCP_SOCKET_GROUP;
  if (groupText !== undefined && groupText !== '' && !/^\d{1,9}$/.test(groupText)) throw new HostConfigError('FLEET_HOST_MCP_SOCKET_GROUP must be a numeric gid');
```

and in the returned object:

```ts
    mcpSocket: env.FLEET_HOST_MCP_SOCKET || '/run/fleet/mcp.sock',
    mcpSocketGroup: groupText ? Number(groupText) : null
```

- [ ] **Step 4: Implement `src/host/socketDir.ts`**

```ts
// Socket files the holder serves to sessions: a private directory when sessions
// share fleet-host's uid, else the split's prepped group directory (SPEC §9).
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareSocketPath(path: string, group: number | null): Promise<void> {
  const dir = dirname(path);
  if (group === null) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } else {
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`${dir} is not a directory; run fleet-host-entry prep first`);
    if (st.gid !== group || (st.mode & 0o070) !== 0o070 || (st.mode & 0o007) !== 0) {
      throw new Error(`${dir} must be group ${group} with group rwx and no access for others; run fleet-host-entry prep first`);
    }
  }
  const st = await lstat(path).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    await unlink(path);
  }
}

export async function finishSocket(path: string, group: number | null): Promise<void> {
  if (group === null) return chmod(path, 0o600);
  await chown(path, -1, group);
  await chmod(path, 0o660);
}
```

The group-directory test case `missing` hits `lstat` → null → "is not a directory"; the symlink case hits `isDirectory()` false on the link itself.

- [ ] **Step 5: Implement `src/host/hostMcp.ts`**

```ts
// The fleet-state MCP tools for this workspace's sessions, on the holder (SPEC §7 *Host MCP*).
import { createServer, type Server, type Socket } from 'node:net';
import {
  initReadSource, releaseReadSource, serveMcpConnection, setExposedTools, setMcpLogSink, setReadScopeResolver, type McpLogEntry
} from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import type { Logger } from './log.js';
import { finishSocket, prepareSocketPath } from './socketDir.js';

export const HOST_MCP_TOOLS: ReadonlySet<string> = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'session_summary',
  'post_todo', 'update_todo', 'list_todos',
  'list_automations', 'get_automation', 'list_runs', 'run_automation', 'schedule_next',
  'propose_automation', 'propose_automation_change', 'get_proposal'
]);
export const MAX_HOST_MCP_CONNECTIONS = 64;
const QUIET = new Set(['mcp-conn', 'mcp-conn-closed']);

export interface HostMcp { close(): Promise<void> }

export async function startHostMcp(o: {
  socketPath: string;
  socketGroup: number | null;
  workspaceId: string;
  readSource: OwnedReadSource;
  log: Logger;
  maxConnections?: number;
}): Promise<HostMcp> {
  const max = o.maxConnections ?? MAX_HOST_MCP_CONNECTIONS;
  setMcpLogSink((e: McpLogEntry) =>
    o.log.log(QUIET.has(e.type) ? 'debug' : e.level ?? 'error', e.type, { message: e.message, ...(e.extra ? { extra: e.extra } : {}), ...(e.stack ? { stack: e.stack } : {}) })
  );
  setReadScopeResolver(async () => [o.workspaceId]);
  setExposedTools(HOST_MCP_TOOLS);
  initReadSource(o.readSource);
  const socks = new Set<Socket>();
  const server: Server = createServer((sock) => {
    if (socks.size >= max) {
      o.log.log('warn', 'mcp connection refused: too many open', { max });
      sock.destroy();
      return;
    }
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    serveMcpConnection(sock, o.workspaceId);
  });
  try {
    await prepareSocketPath(o.socketPath, o.socketGroup);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await finishSocket(o.socketPath, o.socketGroup);
  } catch (err) {
    server.close();
    reset();
    throw err;
  }
  server.on('error', (err) => o.log.log('warn', 'mcp listener error', { error: err.message }));
  o.log.log('info', 'mcp serving', { socket: o.socketPath });
  function reset(): void {
    releaseReadSource();
    setExposedTools(null);
    setMcpLogSink(null);
  }
  let closing: Promise<void> | null = null;
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const s of socks) s.destroy();
        server.close(() => {
          reset();
          resolve();
        });
      });
      return closing;
    }
  };
}
```

`setReadScopeResolver` stays set after close: it only ever returns the hosted id, and nothing else serves in this process.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/host/socketDir.test.ts src/host/hostMcp.test.ts src/host/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C "$W" add src/host/socketDir.ts src/host/socketDir.test.ts src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/config.ts src/host/config.test.ts
git -C "$W" commit -m "feat(host): serve the fleet-state MCP core on a Unix socket

Caller is the hosted workspace; scope is that workspace; a fixed tool set;
private or shared-group socket; 64-connection cap.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Sessions reach the socket (`--mcp-config`, the bridge file)

**Files:**
- Modify: `src/host/hostMcp.ts` (`HOST_MCP_BRIDGE`, `hostMcpArgs`), `src/host/hostMcp.test.ts`
- Modify: `src/host/attachHub.ts` (`AttachHubOptions.createArgs`, `create`), `src/host/attachHub.test.ts`
- Modify: `src/host/cli.ts`; Create: `src/host/mcpBridgeFile.ts`, `src/host/mcpBridgeFile.test.ts`
- Modify: `docker/host/Dockerfile`, `docker/host/smoke.test.sh`
- Modify: `src/host/importGraph.test.ts` (`mcpContainerBridge` to `MAIN_ALLOWED`), `.dockerignore`, both workflows' paths

**Interfaces:**
- Consumes: `CONTAINER_BRIDGE_FILENAME`, `ensureContainerBridgeScript(dir)` from `src/main/mcpContainerBridge.ts` (pure: `node:fs`, `node:path`).
- Produces:
  - `HOST_MCP_BRIDGE = '/usr/local/lib/fleet-host/mcp-bridge.cjs'`;
  - `hostMcpArgs(socketPath: string, bridge?: string): string[]` → `['--mcp-config', <json>]`;
  - `AttachHubOptions.createArgs?: (args: string[]) => string[]`;
  - `writeMcpBridge(path: string): void`; CLI `fleet-host write-mcp-bridge <path>` (exit 0; exit 2 without a path).

- [ ] **Step 1: Write the failing tests**

Append to `src/host/hostMcp.test.ts`:

```ts
import { HOST_MCP_BRIDGE, hostMcpArgs } from './hostMcp.js';

describe('hostMcpArgs', () => {
  it('names claude-fleet-state and points the bridge at the socket', () => {
    const [flag, json] = hostMcpArgs('/run/fleet/mcp.sock');
    expect(flag).toBe('--mcp-config');
    expect(JSON.parse(json)).toEqual({
      mcpServers: { 'claude-fleet-state': { type: 'stdio', command: 'node', args: [HOST_MCP_BRIDGE], env: { CLAUDE_FLEET_MCP_UNIX: '/run/fleet/mcp.sock' } } }
    });
  });
});
```

Append to `src/host/attachHub.test.ts` (follow the file's existing CREATE test; it already builds a hub over `fakeBroker` and sends a CREATE frame through a viewer). The new case constructs the hub with `{ createArgs: (a) => [...a, '--mcp-config', '{}'] }` and asserts:

```ts
    expect(broker.created.at(-1)!.args).toEqual(['--settings', RUNNER_HOOK_SETTINGS, '--mcp-config', '{}']);
```

(import `RUNNER_HOOK_SETTINGS` from `../main/claudeArgs.js`).

`src/host/mcpBridgeFile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpBridge } from './mcpBridgeFile.js';

describe('writeMcpBridge', () => {
  it('writes the container bridge, 0644, to the named path', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'br-')), 'mcp-bridge.cjs');
    writeMcpBridge(out);
    expect(readFileSync(out, 'utf8')).toMatch(/CLAUDE_FLEET_MCP_UNIX/);
    expect(statSync(out).mode & 0o777).toBe(0o644);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/hostMcp.test.ts src/host/attachHub.test.ts src/host/mcpBridgeFile.test.ts`
Expected: FAIL — `hostMcpArgs` missing, the CREATE args lack `--mcp-config`, `Cannot find module './mcpBridgeFile.js'`.

- [ ] **Step 3: Implement `hostMcpArgs` and the hub option**

Append to `src/host/hostMcp.ts`:

```ts
/** Written into the image at build (`fleet-host write-mcp-bridge`). */
export const HOST_MCP_BRIDGE = '/usr/local/lib/fleet-host/mcp-bridge.cjs';

/** Appended to every claude fleet-host creates; the name is the prefix INBOX_TOOLS uses. */
export function hostMcpArgs(socketPath: string, bridge: string = HOST_MCP_BRIDGE): string[] {
  const entry = { type: 'stdio', command: 'node', args: [bridge], env: { CLAUDE_FLEET_MCP_UNIX: socketPath } };
  return ['--mcp-config', JSON.stringify({ mcpServers: { 'claude-fleet-state': entry } })];
}
```

In `src/host/attachHub.ts`, add to `AttachHubOptions`:

```ts
  /** Extends a gated CREATE's args (the MCP config). */
  createArgs?: (args: string[]) => string[];
```

store it in the constructor as the class already stores `hostPort`/`log` (e.g. `readonly createArgs: (a: string[]) => string[]`, defaulting to `(a) => a`), and in `create(req)` change the broker call to:

```ts
    const r = await this.hub.ops.create(id, dim(req.cols, 80), dim(req.rows, 24), this.hub.createArgs(args));
```

(the viewer reaches the hub as `this.hub`, as it does for `ops`.)

- [ ] **Step 4: The `write-mcp-bridge` subcommand**

`src/host/mcpBridgeFile.ts`:

```ts
// The container MCP bridge as an image file: same source as the desktop's per-workspace copy.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_BRIDGE_FILENAME, ensureContainerBridgeScript } from '../main/mcpContainerBridge.js';

export function writeMcpBridge(path: string): void {
  const tmp = mkdtempSync(join(tmpdir(), 'bridge-'));
  try {
    ensureContainerBridgeScript(tmp);
    copyFileSync(join(tmp, CONTAINER_BRIDGE_FILENAME), path);
    chmodSync(path, 0o644);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

In `src/host/cli.ts`, import `writeMcpBridge` from `./mcpBridgeFile.js` and add before the `argv.length > 0` branch:

```ts
  if (argv[0] === 'write-mcp-bridge') {
    if (!argv[1]) {
      process.stderr.write('usage: fleet-host write-mcp-bridge <path>\n');
      process.exit(2);
    }
    writeMcpBridge(argv[1]);
    return;
  }
```

Update the file's header comment to list `write-mcp-bridge` with the other one-shot commands.

Add `/^main\/mcpContainerBridge\.ts$/` to `MAIN_ALLOWED` in `src/host/importGraph.test.ts`, `!src/main/mcpContainerBridge.ts` to `.dockerignore`, and `'src/main/mcpContainerBridge.ts'` to both workflows' path lists.

- [ ] **Step 5: The image**

In `docker/host/Dockerfile`, after the `chmod 0755 /usr/local/bin/fleet-host /usr/local/bin/fleet-host-cred` line's `&&` chain, add to the same `RUN`:

```dockerfile
 && node /usr/local/lib/fleet-host/fleet-host.mjs write-mcp-bridge /usr/local/lib/fleet-host/mcp-bridge.cjs \
 && mkdir -p /run/fleet && chown fleet:fleet /run/fleet && chmod 0700 /run/fleet
```

(the existing `mkdir -p /etc/fleet-host /run/fleet-host` line stays). The container split mounts its emptyDir over `/run/fleet`, so the image directory only serves the single-container layout.

In `docker/host/smoke.test.sh` (`set -euo pipefail`; a failing `test` ends it), add after the `rds-global-bundle.pem` check:

```bash
docker exec "$cid" sh -c 'test -s /usr/local/lib/fleet-host/mcp-bridge.cjs && grep -q CLAUDE_FLEET_MCP_UNIX /usr/local/lib/fleet-host/mcp-bridge.cjs'
test "$(docker exec "$cid" stat -c '%a %U' /run/fleet)" = '700 fleet'
```

The smoke test runs without `db:`, so no socket is served there; Task 7's PG test covers serving.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/host/hostMcp.test.ts src/host/attachHub.test.ts src/host/mcpBridgeFile.test.ts src/host/importGraph.test.ts`
Expected: PASS.

Run: `npx vite build --config vite.host.config.ts && node out/host/fleet-host.mjs write-mcp-bridge "$(mktemp -d)/b.cjs"; echo $?`
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git -C "$W" add src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/attachHub.ts src/host/attachHub.test.ts src/host/cli.ts src/host/mcpBridgeFile.test.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml docker/host/Dockerfile docker/host/smoke.test.sh
git -C "$W" commit -m "feat(host): sessions get the fleet-state MCP through --mcp-config and the image's bridge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `automations:` in the host config

**Files:**
- Modify: `src/host/config.ts` (`HostConfig.automations`, `parseAutomations`, `onlyKeys` list), `src/host/config.test.ts`

**Interfaces:**
- Produces: `interface HostAutomationEntry { definition: Record<string, unknown>; enabled: boolean }`; `HostConfig.automations: HostAutomationEntry[]` (`[]` when absent); `MAX_HOST_AUTOMATIONS = 100`.

Deep validation needs the workspace id (known after the DB opens), so the config parser only checks shape; the holder validates each definition (Task 6). Reload already accepts any change that isn't `workspace.id`, `github.app` or `db`, so `automations` changes apply on reload with no `configReload.ts` change.

- [ ] **Step 1: Write the failing tests**

Append to `src/host/config.test.ts`:

```ts
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
    expect(() => parseHostConfig({ ...base, automations: Array.from({ length: 101 }, (_, i) => ({ definition: def(`a${i}`) })) })).toThrow(/at most 100/);
  });
});
```

(use the grant shape the file's other tests use if `{ team, tier }` differs.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/config.test.ts`
Expected: FAIL — `host config has unknown key automations`.

- [ ] **Step 3: Implement**

In `src/host/config.ts`:

```ts
export const MAX_HOST_AUTOMATIONS = 100;

/** A definition the holder reconciles into the store (SPEC §7 *Host automations*). */
export interface HostAutomationEntry {
  definition: Record<string, unknown>;
  enabled: boolean;
}

function parseAutomations(v: unknown): HostAutomationEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HostConfigError('automations must be a list');
  if (v.length > MAX_HOST_AUTOMATIONS) throw new HostConfigError(`automations: at most ${MAX_HOST_AUTOMATIONS}`);
  const names = new Set<string>();
  return v.map((raw, i) => {
    const e = record(raw, `automations[${i}]`);
    onlyKeys(e, `automations[${i}]`, ['definition', 'enabled']);
    const definition = record(e.definition, `automations[${i}].definition`);
    if (typeof definition.name !== 'string' || !definition.name) throw new HostConfigError(`automations[${i}].definition.name must be a string`);
    if (names.has(definition.name)) throw new HostConfigError(`duplicate automation name ${definition.name}`);
    names.add(definition.name);
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new HostConfigError(`automations[${i}].enabled must be true or false`);
    return { definition, enabled: e.enabled !== false };
  });
}
```

Add `'automations'` to the top-level `onlyKeys` list, `automations: HostAutomationEntry[];` to `HostConfig`, and `automations: parseAutomations(o.automations),` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/config.test.ts src/host/configReload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/config.ts src/host/config.test.ts
git -C "$W" commit -m "feat(host): automations block in the host config

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The automation runtime on the holder

**Files:**
- Create: `src/host/hostAutomations.ts`, `src/host/hostAutomations.test.ts`

**Interfaces:**
- Consumes: Task 2's `remoteHostRefusals`, `hostResolver`, `substituteSelf`; Task 4's `hostMcpArgs`; Task 5's `HostAutomationEntry`; `createInboxService` (`src/main/inbox/inboxService.ts`), `createAutomationService` (`automationService.ts`), `createProposalService` (`proposalService.ts`), `AutomationStore`, `ProposalStore`, `InboxStore`, `setInboxHandlers`/`setAutomationHandlers` (mcpCore), `BrokerOps`, `EventHub`.
- Produces:
  - `HOST_CONFIG_ORIGIN = { source: 'host-config' }`;
  - `startHostAutomations(o: HostAutomationsOptions): Promise<HostAutomations>`;
  - `interface HostAutomationsOptions { inbox: InboxStore; workspace: () => { id: string; name: string }; ops: BrokerOps; mcpArgs: string[]; events: Pick<EventHub, 'publish'>; log: Logger; now?: () => number; tickMs?: number; settleMs?: number }`;
  - `interface HostAutomations { automations: AutomationService; proposals: ProposalService; inbox: ReturnType<typeof createInboxService>; reconcile(entries: HostAutomationEntry[]): Promise<void>; tick(): Promise<void>; stop(): Promise<void> }`.

Exported today: `createAutomationService` and `type AutomationService` (automationService.ts), `createProposalService` and `type ProposalService` (proposalService.ts), `createInboxService` (inboxService.ts).

- [ ] **Step 1: Write the failing tests (SQLite inbox store)**

`src/host/hostAutomations.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationStore } from '../main/automations/automationStore.js';
import { InboxStore } from '../main/inbox/inboxDb.js';
import { callTool, initReadSource, releaseReadSource, setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import { createLogger } from './log.js';
import { fakeBroker } from './testFakes.js';
import { HOST_CONFIG_ORIGIN, startHostAutomations, type HostAutomations } from './hostAutomations.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const fresh = (name: string, extra: Record<string, unknown> = {}) => ({
  definition: { name, triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'review' } }], ...extra },
  enabled: true
});

let h: HostAutomations | null = null;
let inbox: InboxStore | null = null;
let dir = '';
afterEach(async () => {
  await h?.stop();
  h = null;
  await inbox?.close();
  inbox = null;
  rmSync(dir, { recursive: true, force: true });
  setInboxHandlers(null);
  setAutomationHandlers(null);
  releaseReadSource();
});

const names = async () => (await h!.automations.list()).map((a) => [a.name, a.enabled, a.version]).sort();

async function start(now = () => Date.now()) {
  dir = mkdtempSync(join(tmpdir(), 'ha-'));
  inbox = InboxStore.open(dir);
  const broker = fakeBroker([]);
  const published: Array<[string, unknown]> = [];
  const logs: string[] = [];
  h = await startHostAutomations({
    inbox, workspace: () => WS, ops: broker.ops, mcpArgs: ['--mcp-config', '{}'],
    events: { publish: (c, p) => published.push([c, p]) }, log: createLogger((l) => logs.push(l)), now, tickMs: 60_000, settleMs: 50
  });
  return { broker, published, logs };
}

describe('startHostAutomations', () => {
  it('reconciles config definitions: create, update on change only, disable, remove', async () => {
    const { published } = await start();
    await h!.reconcile([fresh('a'), fresh('b')]);
    expect(await names()).toEqual([['a', true, 1], ['b', true, 1]]);
    const [a] = await h!.automations.list();
    expect((await new AutomationStore(inbox!.kysely).get(a.id))!.origin).toEqual(HOST_CONFIG_ORIGIN);
    await h!.reconcile([fresh('a'), { ...fresh('b'), enabled: false }]);
    expect(await names()).toEqual([['a', true, 1], ['b', false, 1]]);
    await h!.reconcile([fresh('a', { description: 'changed' })]);
    expect(await names()).toEqual([['a', true, 2]]);
    expect(published.some(([c]) => c === 'automations:changed')).toBe(true);
  });

  it('skips an invalid definition and leaves other automations alone', async () => {
    const { logs } = await start();
    await h!.reconcile([fresh('a'), { definition: { name: 'live', triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'live', message: 'x' } }] }, enabled: true }]);
    expect((await h!.automations.list()).map((a) => a.name)).toEqual(['a']);
    expect(logs.join('\n')).toMatch(/mode: live is not available on a remote host/);
  });

  it('runs a fresh step through the broker with the MCP args and a pinned session id', async () => {
    const { broker } = await start();
    await h!.reconcile([fresh('a')]);
    const [a] = await h!.automations.list();
    const run = await h!.automations.run(a.id, { kind: 'manual', by: { kind: 'user', id: null }, args: {} });
    await expect.poll(() => broker.created.length).toBe(1);
    const c = broker.created[0];
    expect(c.id).toBe(`auto-${run.id}-go`);
    expect(c.args.slice(-2)).toEqual(['--mcp-config', '{}']);
    expect(c.args[c.args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the MCP inbox and automation tools as the hosted workspace, privileged', async () => {
    await start();
    initReadSource(null);
    await h!.reconcile([fresh('a')]);
    const list = await callTool({ name: 'list_automations', arguments: {} }, WS.id) as { content: Array<{ text: string }> };
    expect(JSON.parse(list.content[0].text).map((x: { name: string; canRun: boolean }) => [x.name, x.canRun])).toEqual([['a', true]]);
    const post = await callTool({ name: 'post_todo', arguments: { title: 'look at PR 1' } }, WS.id) as { isError?: boolean };
    expect(post.isError).toBeUndefined();
  });
});
```

`initReadSource(null)` starts the core storeless: without it `callTool` refuses with `Database not open`. The stored origin is read through `AutomationStore` because the service's `view()` reports only loadout origins.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/hostAutomations.test.ts`
Expected: FAIL — `Cannot find module './hostAutomations.js'`.

- [ ] **Step 3: Implement `src/host/hostAutomations.ts`**

```ts
// The hosted workspace's automations, inbox and proposals, on the holder's
// fenced store (SPEC §7 *Host automations*). Desktop-only effects are absent:
// no script steps, live steps, notifications or other workspaces.
import { randomUUID } from 'node:crypto';
import type { TodoSource } from '../preload/inboxTypes.js';
import { AutomationStore } from '../main/automations/automationStore.js';
import { createAutomationService } from '../main/automations/automationService.js';
import { createProposalService } from '../main/automations/proposalService.js';
import { ProposalStore } from '../main/automations/proposalStore.js';
import { definitionToYaml, validateDefinition } from '../main/automations/definition.js';
import { createInboxService } from '../main/inbox/inboxService.js';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import type { BrokerOps } from './brokerOps.js';
import type { HostAutomationEntry } from './config.js';
import type { EventHub } from './events.js';
import { hostResolver, remoteHostRefusals, substituteSelf } from './hostDefinition.js';
import type { Logger } from './log.js';

export const HOST_CONFIG_ORIGIN = { source: 'host-config' } as const;
const OPERATOR: TodoSource = { kind: 'user', id: null };
const TICK_MS = 30_000;
const SETTLE_MS = 2_000;

export interface HostAutomationsOptions {
  inbox: InboxStore;
  workspace: () => { id: string; name: string };
  ops: BrokerOps;
  /** hostMcpArgs(...): fresh sessions get the fleet-state tools. */
  mcpArgs: string[];
  events: Pick<EventHub, 'publish'>;
  log: Logger;
  now?: () => number;
  tickMs?: number;
  settleMs?: number;
}

export type HostAutomations = Awaited<ReturnType<typeof startHostAutomations>>;

export async function startHostAutomations(o: HostAutomationsOptions) {
  const now = o.now ?? Date.now;
  const store = new AutomationStore(o.inbox.kysely);
  const resolve = (v: string) => hostResolver(o.workspace())(v);
  const name = (id: string) => (id === o.workspace().id ? o.workspace().name : id);
  const warn = (msg: string) => (e: unknown) => o.log.log('warn', msg, { error: e instanceof Error ? e.message : String(e) });

  const publishCounts = (): void => {
    void o.inbox.counts().then((c) => o.events.publish('inbox:changed', c)).catch(warn('inbox counts failed'));
  };
  let automations: ReturnType<typeof createAutomationService> | null = null;
  const inbox = createInboxService(o.inbox, {
    manifest: async () => ({}),
    notifyChanged: publishCounts,
    onPostRejected: (_ws, reason) => o.log.log('warn', 'inbox post rejected', { reason }),
    attribution: (runId, callerId) => automations?.attribution(runId, callerId) ?? null,
    onTodoCreated: (todo) => {
      void automations?.onEvent({ on: 'todo.created', workspaceId: todo.source.kind === 'workspace' ? todo.source.id ?? undefined : undefined, todo: { id: todo.id, title: todo.title, tags: todo.tags, source: todo.source } })
        .catch(warn('automation event failed'));
    }
  });

  const svc = createAutomationService({
    store,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    workspaceState: async (id) => (id === o.workspace().id ? 'running' : null),
    workspaceName: name,
    ensureRunning: async () => undefined,
    post: async () => { throw new Error('live steps are not available on a remote host'); },
    busy: () => false,
    spawnFresh: async (_ws, sessionId, args) => {
      const r = await o.ops.create(sessionId, 120, 40, [...args, '--session-id', randomUUID(), ...o.mcpArgs]);
      if (!r.ok) throw new Error(`could not start a fresh session: ${r.error ?? 'unknown broker error'}`);
    },
    freshState: async (_ws, sessionId) => {
      const s = (await o.ops.list()).find((x) => x.id === sessionId);
      return s ? (s.alive ? 'alive' : 'ended') : 'missing';
    },
    closeFresh: async (_ws, sessionId) => {
      const a = await o.ops.attach(sessionId, { onHistory: () => undefined, onOutput: () => undefined, onEnded: () => undefined, onGone: () => undefined }).catch(() => null);
      if (a?.ok) await a.upstream.closeSession().catch(() => undefined);
    },
    emitTodo: async (id, runId, input) => inbox.host.todoFromAutomation(id, runId, input),
    resolveWorkspace: resolve,
    checkDefinition: remoteHostRefusals,
    changed: () => {
      o.events.publish('automations:changed', null);
      publishCounts();
    },
    onError: (e) => {
      o.log.log('warn', 'automation run failed to record', { error: e instanceof Error ? e.message : String(e) });
    },
    notify: (n) => o.log.log(n.priority === 'high' ? 'warn' : 'info', 'automation notice', { kind: n.kind, title: n.title })
  });
  automations = svc;

  const proposals = createProposalService({
    proposals: new ProposalStore(o.inbox.kysely),
    automations: store,
    now,
    resolveWorkspace: resolve,
    workspaceName: name,
    trusted: async () => false,
    checkDefinition: remoteHostRefusals,
    changed: () => {
      o.events.publish('automations:changed', null);
      o.events.publish('proposals:changed', null);
      publishCounts();
    }
  });

  setInboxHandlers(inbox.mcp);
  setAutomationHandlers({
    list: (c) => svc.mcp.list(c, true),
    run: (c, a) => svc.mcp.run(c, a, true),
    get: (c, a) => svc.mcp.get(c, a, true),
    listRuns: (c, a) => svc.mcp.listRuns(c, a, true),
    scheduleNext: (c, a) => svc.mcp.scheduleNext(c, a),
    propose: (c, a) => proposals.mcp.propose(c, a),
    proposeChange: (c, a) => proposals.mcp.proposeChange(c, a),
    getProposal: (c, a) => proposals.mcp.get(c, a)
  });

  async function reconcile(entries: HostAutomationEntry[]): Promise<void> {
    const ws = o.workspace();
    const ctx = { workspace: resolve, check: remoteHostRefusals };
    const records = await store.list();
    const wanted = new Set<string>();
    for (const e of entries) {
      const n = String(e.definition.name);
      wanted.add(n);
      const raw = substituteSelf(e.definition, ws.id);
      const v = validateDefinition(raw, ctx);
      if (!v.ok) {
        o.log.log('error', 'host-config automation skipped', { name: n, errors: v.errors });
        continue;
      }
      const yaml = definitionToYaml(v.value);
      const existing = records.find((r) => r.name === n);
      if (existing && existing.origin?.source !== HOST_CONFIG_ORIGIN.source) {
        o.log.log('error', 'host-config automation skipped: the name is taken by an automation not from the host config', { name: n });
        continue;
      }
      if (!existing) {
        const a = await svc.create(yaml, OPERATOR);
        await store.setOrigin(a.id, { ...HOST_CONFIG_ORIGIN });
        if (!e.enabled) await svc.setEnabled(a.id, false);
        continue;
      }
      if (definitionToYaml(existing.definition) !== yaml) await svc.update(existing.id, yaml, OPERATOR);
      if (existing.enabled !== e.enabled) await svc.setEnabled(existing.id, e.enabled);
    }
    for (const r of records) {
      if (r.origin?.source === HOST_CONFIG_ORIGIN.source && !wanted.has(r.name)) await svc.remove(r.id);
    }
  }

  await svc.recover();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    svc.tick().catch(warn('automation tick failed'));
  }, o.tickMs ?? TICK_MS);
  timer.unref?.();

  return {
    automations: svc,
    proposals,
    inbox,
    reconcile,
    async tick(): Promise<void> {
      await svc.tick();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      svc.cancelPending();
      setAutomationHandlers(null);
      setInboxHandlers(null);
      let t: NodeJS.Timeout | undefined;
      await Promise.race([svc.settle(), new Promise<void>((r) => (t = setTimeout(r, o.settleMs ?? SETTLE_MS)))]);
      clearTimeout(t);
    }
  };
}
```

`AutomationRecord.origin` is `Record<string, unknown> | null`, so `existing.origin?.source` typechecks.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/hostAutomations.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the runtime's modules to the host graph**

The runtime pulls in automation and inbox modules. Run `npx vitest run src/host/importGraph.test.ts` after Task 7 wires it into `holder.ts` (only then is it reachable from `cli.ts`); add every file it lists to `MAIN_ALLOWED`, `.dockerignore` and both workflows. Expected additions, all Electron-free (B1's import check covered `inboxDb`/`inboxCore` already):

```
src/main/automations/{automationService,automationStore,proposalService,proposalStore,definition,cron,scheduler,runner,reschedule,template,scriptProtocol,classify}.ts
src/main/inbox/{inboxService,inboxPolicy,notifyService,notifyStore,notifyPolicy}.ts
```

(`MAIN_ALLOWED` regexes: `/^main\/automations\/(automationService|automationStore|proposalService|proposalStore|definition|cron|scheduler|runner|reschedule|template|scriptProtocol|classify)\.ts$/` and extend the inbox one to `(inboxDb|inboxCore|inboxService|inboxPolicy|notifyService|notifyStore|notifyPolicy)`.) If the walker lists anything else (in particular `automationIpc.ts`, `ipc.ts`, `errorLog.ts`, `electron`), an import pulled in Electron: fix the import, never the allowlist.

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/host/hostAutomations.ts src/host/hostAutomations.test.ts
git -C "$W" commit -m "feat(host): the automation, inbox and proposal runtime for the hosted workspace

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire MCP and automations into the holder; the two-host tests

**Files:**
- Modify: `src/host/holder.ts`, `src/host/main.ts`
- Create: `src/host/hostAutomations.pg.test.ts`
- Modify: `src/host/main.pg.test.ts`, `src/host/importGraph.test.ts`, `.dockerignore`, both workflows (Task 6 Step 5)

**Interfaces:**
- Consumes: `startHostMcp`, `hostMcpArgs` (Tasks 3–4), `startHostAutomations` (Task 6), `pgReadSource` (`src/main/store/pgReadSource.ts`), `stateKysely` (`src/main/db.ts`).
- Produces:
  - `HolderOptions` gains `ops: BrokerOps; events: Pick<EventHub, 'publish'>; workspace: () => { id: string; name: string }; automations: () => HostAutomationEntry[]; mcp: { socketPath: string; socketGroup: number | null }`;
  - `Holder` gains `automations: HostAutomations`;
  - `runHost` reconciles on every accepted reload while a holder runs; `AttachHub` gets `createArgs` when `db:` is set.

Start order on the holder: stores → ingest → automations (`recover`, reconcile) → MCP. Stop order: MCP → automations → ingest → stores. The MCP comes last so no session call lands on a half-built runtime, and closes first so none lands on a stopped one.

- [ ] **Step 1: Write the failing PG tests**

`src/host/hostAutomations.pg.test.ts` (two "hosts" on one schema, each with its own fenced inbox store, as in `pgLease.test.ts`):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../main/inbox/inboxDb.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { INBOX_PG_TRACK } from '../main/store/migrations/inboxPg.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK } from './hostSchema.js';
import { createLogger } from './log.js';
import { leaseFence, postgresLeaseStore } from './pgLease.js';
import { fakeBroker } from './testFakes.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const daily = { definition: { name: 'nightly', triggers: [{ schedule: { cron: '0 3 * * *' } }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'review' } }] }, enabled: true };

describe.skipIf(!isPg)('host automations under the lease', () => {
  let t: TestPg | null = null;
  const live: Array<HostAutomations | InboxStore> = [];
  afterEach(async () => {
    for (const x of live.splice(0).reverse()) await ('reconcile' in x ? x.stop() : x.close()).catch(() => undefined);
    await t?.drop();
    t = null;
  });

  async function host(holder: string, epoch: () => number | null, clock: { now: number }) {
    const inbox = await InboxStore.openPostgres(t!.pool, { migrate: false, afterBeginWrite: leaseFence({ workspaceId: WS.id, holder, epoch, onLost: () => undefined }) });
    const broker = fakeBroker([]);
    const h = await startHostAutomations({
      inbox, workspace: () => WS, ops: broker.ops, mcpArgs: [], events: { publish: () => undefined },
      log: createLogger(() => undefined), now: () => clock.now, tickMs: 3_600_000, settleMs: 50
    });
    live.push(inbox, h);
    return { h, broker };
  }

  async function setup() {
    t = await testPgSchema();
    const k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await migratePostgres(k, t.schema, INBOX_PG_TRACK);
    return postgresLeaseStore(postgresKysely(t.pool), WS.id);
  }

  it('a due slot fires once across two hosts: the stale holder’s fenced write fails', async () => {
    const lease = await setup();
    const clock = { now: Date.parse('2026-11-06T02:00:00Z') };
    // b held the lease first and still believes it does (its runtime started, recover() ran fenced).
    const eb = (await lease.tryAcquire('b', 0, 60_000))!;
    const b = await host('b', () => eb, clock);
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    const ea = (await lease.tryAcquire('a', 0, 60_000))!;
    const a = await host('a', () => ea, clock);
    await a.h.reconcile([daily]);
    clock.now = Date.parse('2026-11-06T03:00:30Z');
    const [ra, rb] = await Promise.allSettled([a.h.tick(), b.h.tick()]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.message).toMatch(/lease lost/);
    await expect.poll(() => a.broker.created.length + b.broker.created.length).toBe(1);
    const runs = await t!.pool.query(`SELECT count(*)::int AS n FROM ${t!.schema}.runs`);
    expect(runs.rows[0].n).toBe(1);
  });

  it('a run on a host that loses the lease records nothing after the takeover', async () => {
    const lease = await setup();
    let ea: number | null = (await lease.tryAcquire('a', 0, 60_000))!;
    const clock = { now: Date.parse('2026-11-06T02:00:00Z') };
    const a = await host('a', () => ea, clock);
    await a.h.reconcile([daily]);
    clock.now = Date.parse('2026-11-06T03:00:30Z');
    await a.h.tick();
    await expect.poll(() => a.broker.created.length).toBe(1);
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'b', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
    ea = null;
    await a.broker.ops.attach(a.broker.created[0].id, { onHistory() {}, onOutput() {}, onEnded() {}, onGone() {} }).then((r) => r.ok && r.upstream.closeSession());
    await new Promise((r) => setTimeout(r, 3_000));
    const rows = await t!.pool.query(`SELECT status, ended_at FROM ${t!.schema}.runs`);
    expect(rows.rows).toEqual([{ status: 'running', ended_at: null }]);
  }, 20_000);
});
```

`runs(status, ended_at)` is the inbox track's run table (`src/main/store/migrations/inboxPg.ts`). A runtime's `recover()` is a fenced write, so a host's runtime can only start while it holds the lease; the first test therefore starts `b` as holder, then hands the lease to `a`. The fresh-step poll is 2 s (`FRESH_POLL_MS`), hence the 3 s wait. `ea = null` makes the fence refuse from the host's side too, as `LeaseManager` does once it learns.

Append to `src/host/main.pg.test.ts` inside `describe.skipIf(!isPg)('runHost on Postgres', …)`:

```ts
  it('only the holder serves the MCP socket, and it closes on shutdown', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await vi.waitFor(() => expect(existsSync(join(a.dir, 'run', 'mcp.sock'))).toBe(true), { timeout: 10_000 });
    const b = await start();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(existsSync(join(b.dir, 'run', 'mcp.sock'))).toBe(false);
    await a.host.shutdown(0);
    expect(existsSync(join(a.dir, 'run', 'mcp.sock'))).toBe(false);
  }, 30_000);
```

To support it, add `FLEET_HOST_MCP_SOCKET: join(dir, 'run', 'mcp.sock')` to `hostEnv()` in that file (so no test binds `/run/fleet`) and import `existsSync` from `node:fs`. Do the same in `src/host/main.test.ts`'s env helper if it starts a holder with `db:` (it doesn't today: without `db:` nothing is served).

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pg-test-server.sh start` (export the printed `PG_TEST_URL`), then `npx vitest run -c vitest.pg.config.ts src/host/hostAutomations.pg.test.ts src/host/main.pg.test.ts`
Expected: `hostAutomations.pg.test.ts` PASSES already if Task 6 is right (it doesn't need the wiring); the new `main.pg.test.ts` case FAILS (no socket).

- [ ] **Step 3: Wire the holder**

In `src/host/holder.ts`, add imports (`pgReadSource` from `../main/store/pgReadSource.js`, `stateKysely` from `../main/db.js`, `startHostMcp`/`hostMcpArgs` from `./hostMcp.js`, `startHostAutomations`/`HostAutomations` from `./hostAutomations.js`, `BrokerOps`, `EventHub`, `HostAutomationEntry` types), the `HolderOptions` fields listed under Interfaces, `automations: HostAutomations` on `Holder`, and replace the body after `await ingest.start()` succeeds:

```ts
  let automations: HostAutomations | null = null;
  let mcp: HostMcp | null = null;
  const stopAll = async (): Promise<void> => {
    await mcp?.close();
    await automations?.stop();
    await ingest.stop();
    await offsetsRead.destroy();
    await stores.inbox.close();
    await closeDb();
    await stores.end();
  };
  try {
    automations = await startHostAutomations({
      inbox: stores.inbox, workspace: o.workspace, ops: o.ops, mcpArgs: hostMcpArgs(o.mcp.socketPath),
      events: o.events, log: o.log
    });
    await automations.reconcile(o.automations());
    mcp = await startHostMcp({
      socketPath: o.mcp.socketPath, socketGroup: o.mcp.socketGroup, workspaceId: o.workspaceId, log: o.log,
      readSource: pgReadSource({ isolation: null, unavailable: 'query is unavailable on fleet-host until its MCP isolation ships', k: stateKysely })
    });
  } catch (err) {
    await stopAll();
    throw err;
  }
  let stopping: Promise<void> | null = null;
  return {
    stores,
    automations,
    stop() {
      stopping ??= stopAll();
      return stopping;
    }
  };
```

and fold the existing `ingest.start()` catch into the same `stopAll` pattern (it closes ingest, offsets, inbox, db, pool in that order, which `stopAll` keeps). `query` isn't in `HOST_MCP_TOOLS`, so the `unavailable` text is a backstop.

In `src/host/main.ts`:
- Build the hub with `createArgs` when `db:` is set: `new AttachHub(ops, { hostPort: env.port, log, createArgs: config.db ? (a) => [...a, ...hostMcpArgs(env.mcpSocket)] : undefined })`.
- Pass to `startHolder`: `ops`, `events`, `workspace: () => ({ id, name: config.workspace.name })`, `automations: () => config.automations`, `mcp: { socketPath: env.mcpSocket, socketGroup: env.mcpSocketGroup }`.
- In the reloader's `apply`, after `await host?.reverifyAll();`:

```ts
      const h = holderP ? await holderP : null;
      await h?.automations.reconcile(next.automations).catch((err: Error) => log.log('error', 'automation reconcile failed', { error: err.message }));
```

`holderP` is declared later in `runHost`; move its `let holderP: Promise<Holder | null> | null = null;` above `createReloader` so the closure can read it (it's only read after start).

- [ ] **Step 4: Run the host suites and the import graph**

Run: `npx vitest run src/host` and `npx vitest run -c vitest.pg.config.ts src/host`
Expected: PASS. Then add the files the import-graph test lists (Task 6 Step 5) and rerun `npx vitest run src/host/importGraph.test.ts` until it passes.

Run: `npx tsc -p tsconfig.host.json && npx vite build --config vite.host.config.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/holder.ts src/host/main.ts src/host/hostAutomations.pg.test.ts src/host/main.pg.test.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml
git -C "$W" commit -m "feat(host): the holder runs automations and serves the MCP socket

Started after the fenced stores open, stopped before they close; reload
reconciles config automations; viewer CREATEs carry the MCP config.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: SPEC, gate and PR

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: SPEC.md**

- §4 *Host images*: the image writes `/usr/local/lib/fleet-host/mcp-bridge.cjs` at build (`fleet-host write-mcp-bridge`) and has `/run/fleet` (0700, `fleet`) for the single-container layout.
- §7 *Remote host*:
  - first paragraph: drop "it runs no scheduler and serves no fleet-state MCP yet"; say the holder runs the workspace's automations and serves the MCP.
  - env table rows: `FLEET_HOST_MCP_SOCKET` (`/run/fleet/mcp.sock`, the MCP socket the holder serves) and `FLEET_HOST_MCP_SOCKET_GROUP` (unset: 0600 in a 0700 dir; a gid: the split's prepped group directory, socket 0660).
  - config bullet `automations` (B10 shape, reconcile rules, `$self`, skip-and-log, the `host-config` origin).
  - new paragraph **Host MCP** (B2–B7): holder only, start/stop order, caller and scope, the tool set and where the others go, caps, `--mcp-config` on every CREATE, the bridge file.
  - new paragraph **Host automations** (B8, B9, B11, B12): runtime deps, refusals, events, no RPC yet, proposals wait for (g).
- §8 *Automations*: one bullet: on a remote host the scheduler runs on the holder; definitions come from the host config; refusals per B9.
- §9: the MCP socket shares `cred.sock`'s trust boundary (any session in the workspace container; nothing else); single-container layout keeps the shared-uid caveats.
- §11: replace *Remote host automations* with what remains open: `query`/`search_transcripts` on the host ((d)), approvals and notifications ((g)), script steps, the two-pod MCP listener (B2), and the deployment invariants paragraph kept verbatim. In *Host container split*, add that `/run/fleet` also holds `mcp.sock` and that `fleet-host-entry host` exports `FLEET_HOST_MCP_SOCKET=/run/fleet/mcp.sock` and `FLEET_HOST_MCP_SOCKET_GROUP=$FLEET_RUN_GID` (a cross-plan edit for `2026-11-05-host-container-split.md` Task 4; the split's `checkSharedSocketDir` should reuse `src/host/socketDir.ts` if this lands first).

- [ ] **Step 2: Full gate**

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx tsc -p tsconfig.host.json
npx vitest run
npx vitest run -c vitest.pg.config.ts
npx vite build --config vite.host.config.ts
bash docker/host/fleet-host-entry.test.sh
```

Expected: all clean. `git -C "$W" diff origin/main -- src/main/__snapshots__/mcpServer.contract.json` shows only the added file (the snapshot never changed after Task 1 Step 2).

- [ ] **Step 3: Commit, push, PR**

```bash
git -C "$W" add docs/SPEC.md
git -C "$W" commit -m "docs(spec): host automations and the host MCP socket (remote c3b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$W" push -u origin HEAD
```

PR body (factual): what changed (B1 split, host MCP, host automations, config `automations`), the desktop contract snapshot, the PG tests, image change (runner republish; host deployments pick it up on the next rollout), infra note (no chart change for the single-container layout; the split's entry exports the two MCP env vars), how to test (the commands above), ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then `gh pr merge --auto --squash`.

## Questions for Troy

1. **Where host automations come from (B10).** The plan reconciles them from `automations:` in the host ConfigMap (platform-ops), so changes go through review there; sessions can propose, and proposals wait for (g)'s approval. The alternative is to trust proposals from the hosted workspace (auto-apply), which lets a prompt-injected session schedule work. Keep the ConfigMap?
2. **Script steps on the host (B9).** Refused until the broker can run a script in the workspace container (needed once the split lands, because fleet-host's container holds the DB role). Needed for the first remote automations, or is fresh-prompt-only enough?

## Self-review notes

- **Coverage:** Electron-free `mcpServer` with the desktop byte-for-byte: Task 1 (snapshot, unchanged tests, import walk; validated). Lease fence and standby never scheduling: B5, Task 7 (holder-only start; PG tests for fire-once and post-takeover). Caller identity and grants: B3, Task 3 test. Single-container and split layouts, two-pod deferred: B2, Task 3 (`socketDir`), Task 4 (image dir), Task 8 (cross-plan note). Desktop refusal kept and (g)'s seam: B12, Global Constraints. Caps and secrets: B6, Task 3 tests. Outline items: MCP on the socket (Tasks 3–4), scheduler and runner on the holder (Tasks 6–7), `runIn: host` and cross-workspace refusals (Task 2), events (B11, Task 6), both outline tests (Task 7). The outline's `ReadSource` gaps for (d) (no origin identity, no tie-safe cursor) are unchanged and stay (d)'s.
- **Names used across tasks:** `mcpCore.ts` (`serveMcpConnection`, `setMcpLogSink`, `setExposedTools`, `initReadSource`, `releaseReadSource`, `currentReadSource`, `_setReadSourceForTests`, `McpLogEntry`), `ResolveCtx.check`, `checkDefinition`, `remoteHostRefusals`, `hostResolver`, `substituteSelf`, `prepareSocketPath`, `finishSocket`, `HOST_MCP_TOOLS`, `MAX_HOST_MCP_CONNECTIONS`, `startHostMcp`, `HostMcp`, `HOST_MCP_BRIDGE`, `hostMcpArgs`, `AttachHubOptions.createArgs`, `HostEnv.mcpSocket`/`mcpSocketGroup`, `HostAutomationEntry`, `HostConfig.automations`, `HOST_CONFIG_ORIGIN`, `startHostAutomations`, `HostAutomations`, `HolderOptions.{ops,events,workspace,automations,mcp}`, `Holder.automations`.
