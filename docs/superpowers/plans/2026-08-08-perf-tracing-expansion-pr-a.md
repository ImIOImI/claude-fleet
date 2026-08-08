# Perf Tracing Expansion PR A (Attribution + Child Spans) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp `workspace_id`/`session_id` onto IPC slow-op spans and add dedicated child spans for docker/vault calls, so `perf_events` stall analysis can attribute slow operations to the workspace that caused them.

**Architecture:** Three layers, each independently testable: (1) `perf.ts` gains OTel context propagation (`context.with` + `AsyncLocalStorageContextManager`) so nested spans parent correctly and a new `perfSetSpanContext()` helper can reach the active span; (2) `perfIpc.ts` gains a static per-channel map from channel name → argument positions carrying workspace/session ids, stamped as span attributes at dispatch; (3) `docker.ts`/`vault.ts` heavy calls get wrapped in named child spans. The existing SQLite exporter already lifts `workspace_id`/`session_id` span attributes into `perf_events` columns — it is not modified.

**Tech Stack:** TypeScript (Electron main process), `@opentelemetry/api` 1.9, OTel JS SDK 2.x, vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-perf-tracing-expansion-design.md` (PR A sections A1–A4). PR B (latency hops) is NOT in this plan.

## Global Constraints

- Branch: `feat/perf-tracing-expansion`, worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`. Run all commands from the worktree root. Never `cd /workspace/claude-fleet` (that's the shared main checkout on another branch).
- Worktrees resolve node modules from the BASE checkout's `/workspace/claude-fleet/node_modules` — new deps must be installed there (Task 1) AND added to the worktree's `package.json`.
- This container has no display and no C++ compiler: the verification gate is `npm run typecheck` + `npm run test:unit` + `npm run build`. Say so in the PR body.
- Span attribute names are exactly `workspace_id` and `session_id` (snake_case) — the SQLite exporter matches these strings (`perf.ts:53-54`).
- All new span names live under the `claude_fleet.` namespace: `claude_fleet.docker.attach_pty`, `claude_fleet.docker.create`, `claude_fleet.docker.start`, `claude_fleet.docker.stop`, `claude_fleet.docker.pause`, `claude_fleet.vault.resolve_env`.
- `docs/SPEC.md` edits land in the same commit as the behavior they describe (repo rule `.claude/rules/spec-maintenance.md`): §11 scoping note with Task 4, §6 rewrite with Task 6.
- No new `perf_events` kinds, no migration, no MCP tool changes in this PR.

---

### Task 1: Container test-env prep (no code changes)

The worktree is fresh and the base `node_modules` predates the perf deps. Follow the recorded recipe (memory `run-unit-tests-env`), extended with the one new dep this PR needs: `@opentelemetry/context-async-hooks`.

**Files:** none (touches base-checkout `node_modules` only — never committed).

- [ ] **Step 1: better-sqlite3 prebuilt binary (skip if already present)**

```bash
ls /workspace/claude-fleet/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null || {
  cd /tmp && rm -rf bs3probe && mkdir bs3probe && cd bs3probe && npm init -y >/dev/null && npm install better-sqlite3@12.10.0 >/dev/null
  cp /tmp/bs3probe/node_modules/better-sqlite3/build/Release/better_sqlite3.node /workspace/claude-fleet/node_modules/better-sqlite3/build/Release/
}
```

- [ ] **Step 2: electron stub (skip if already present)**

```bash
printf 'electron-stub' > /workspace/claude-fleet/node_modules/electron/path.txt
```

- [ ] **Step 3: install ALL base-tree extras in ONE command** (each `--no-save` run prunes the previous run's extras — never split this):

```bash
npm install --prefix /workspace/claude-fleet --no-save --ignore-scripts \
  @huggingface/transformers@^3 \
  @opentelemetry/api@^1.9.1 @opentelemetry/core@^2.10.0 \
  @opentelemetry/exporter-metrics-otlp-http@^0.221.0 @opentelemetry/exporter-trace-otlp-http@^0.221.0 \
  @opentelemetry/sdk-metrics@^2.10.0 @opentelemetry/sdk-trace-base@^2.10.0 \
  @opentelemetry/context-async-hooks@^2.10.0
```

- [ ] **Step 4: verify the existing perf suite runs**

Run (from the worktree root): `npx vitest run src/main/perf.test.ts src/main/perfIpc.test.ts src/main/perfStore.test.ts`
Expected: all PASS. If better-sqlite3 fails to load, redo Step 1.

---

### Task 2: OTel context propagation in `perf.ts`

Today `perfSpan`/`perfSpanAsync` start spans without setting them on the OTel context, so nested spans do NOT parent and `trace.getActiveSpan()` returns undefined inside a span. Fix both by running `fn` inside `context.with(...)` and registering an `AsyncLocalStorageContextManager` while recording is on.

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/main/perf.ts:13` (imports), `perf.ts:166-180` (initPerf), `perf.ts:242-254` (shutdownPerf), `perf.ts:268-294` (perfSpan/perfSpanAsync)
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: existing `perfSpan(name, fn, attrs?)` / `perfSpanAsync(name, fn, attrs?)` signatures (unchanged).
- Produces: nested `perfSpan*` calls now share a `trace_id` (child rows join to parents on it); `trace.getActiveSpan()` works inside any `perfSpan*` callback — Task 3 relies on this.

- [ ] **Step 1: Write the failing test** — append to the `perf tracer pipeline` describe block in `src/main/perf.test.ts`:

```ts
  it('nested perfSpanAsync spans share a trace_id (child parents under the active span)', async () => {
    initPerf(store, ON);
    const spin = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
    await perfSpanAsync('claude_fleet.test.parent', async () => {
      spin(30);
      await perfSpanAsync('claude_fleet.test.child', async () => { spin(30); });
    });
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT name, trace_id FROM perf_events WHERE kind = 'slow_op' AND name LIKE 'claude_fleet.test.%' ORDER BY name`
    ).all() as Array<{ name: string; trace_id: string }>;
    expect(rows.map((r) => r.name)).toEqual(['claude_fleet.test.child', 'claude_fleet.test.parent']);
    expect(rows[0].trace_id).toBe(rows[1].trace_id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/perf.test.ts -t 'nested'`
Expected: FAIL — the two rows have different `trace_id`s (each span starts its own trace today).

- [ ] **Step 3: Implement.** In `src/main/perf.ts`:

(a) Add the dependency to the worktree `package.json` `dependencies` block (alphabetical, next to the other `@opentelemetry/*` entries):

```json
    "@opentelemetry/context-async-hooks": "^2.10.0",
```

(b) Change the api import (line 13) and add the context-manager import:

```ts
import { context, metrics, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
```

(c) In `initPerf`, immediately after `if (!effective.recording) return;` (line 166):

```ts
  // Context propagation: lets perfSpan* parent nested spans and lets
  // perfSetSpanContext reach the active span. Without a registered manager
  // the API's context.with is a passthrough and getActiveSpan is undefined.
  const ctxManager = new AsyncLocalStorageContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);
```

(d) In `shutdownPerf`, next to the existing `trace.disable(); metrics.disable();` (lines 251-252), add:

```ts
  context.disable();
```

(e) Rewrite `perfSpan` and `perfSpanAsync` (lines 268-294) to activate the span:

```ts
export function perfSpan<T>(name: string, fn: () => T, attrs?: Attributes): T {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T> | T,
  attrs?: Attributes
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
```

- [ ] **Step 4: Run the full perf suite**

Run: `npx vitest run src/main/perf.test.ts`
Expected: all PASS (the nested test now passes; the disabled-mode test still passes because the API's no-op context manager passes `fn` through).

- [ ] **Step 5: Commit**

```bash
git add package.json src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): activate spans on the OTel context so nesting parents correctly"
```

---

### Task 3: `perfSetSpanContext()` helper in `perf.ts`

For handlers that only learn the workspace after work starts (`pty:attach` owner lookup, `pty:input` handle map).

**Files:**
- Modify: `src/main/perf.ts` (new export, place directly after `perfSpanAsync`)
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: Task 2's context activation (`trace.getActiveSpan()`).
- Produces: `perfSetSpanContext(ctx: { workspaceId?: string; sessionId?: string }): void` — used by Task 5 (ipc.ts) and Task 6 (docker.ts).

- [ ] **Step 1: Write the failing test** — append to the `perf tracer pipeline` describe block:

```ts
  it('perfSetSpanContext stamps workspace/session onto the active span', async () => {
    initPerf(store, ON);
    await perfSpanAsync('claude_fleet.test.ctx', async () => {
      perfSetSpanContext({ workspaceId: 'ws-9', sessionId: 'sess-9' });
      const end = Date.now() + 30; while (Date.now() < end) { /* busy */ }
    });
    await shutdownPerf();
    const row = db.prepare(
      `SELECT workspace_id, session_id FROM perf_events WHERE name = 'claude_fleet.test.ctx'`
    ).get() as { workspace_id: string; session_id: string };
    expect(row).toEqual({ workspace_id: 'ws-9', session_id: 'sess-9' });
  });

  it('perfSetSpanContext is a no-op outside a span and while disabled', async () => {
    initPerf(store, OFF);
    expect(() => perfSetSpanContext({ workspaceId: 'ws-9' })).not.toThrow();
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
  });
```

Also add `perfSetSpanContext` to the import list at the top of the test file (the `from './perf.js'` import).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/perf.test.ts -t 'perfSetSpanContext'`
Expected: FAIL with "perfSetSpanContext is not a function" (or import error).

- [ ] **Step 3: Implement** — in `src/main/perf.ts`, directly after `perfSpanAsync`:

```ts
/** Stamp workspace/session attribution onto the active span, for handlers
 *  that only learn the ids after work starts (pty:attach owner lookup,
 *  pty:input handle map). No-op outside a span or while recording is off. */
export function perfSetSpanContext(ctx: { workspaceId?: string; sessionId?: string }): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (typeof ctx.workspaceId === 'string') span.setAttribute('workspace_id', ctx.workspaceId);
  if (typeof ctx.sessionId === 'string') span.setAttribute('session_id', ctx.sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/perf.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): perfSetSpanContext helper for post-lookup span attribution"
```

---

### Task 4: Per-channel context map in `perfIpc.ts` (+ SPEC §11 scoping note)

The wrapper stamps `workspace_id`/`session_id` from handler arguments for channels whose args carry ids. Attributed rows become workspace-scoped in the MCP snapshot instead of NULL/visible-to-all — that behavior shift gets its SPEC sentence in this same commit.

**Files:**
- Modify: `src/main/perfIpc.ts` (full rewrite below)
- Modify: `docs/SPEC.md:1253` (the `query` scoping bullet)
- Test: `src/main/perfIpc.test.ts`

**Interfaces:**
- Consumes: `perfSpanAsync(name, fn, attrs?)` from `perf.ts` (unchanged signature).
- Produces: `channelAttrs(channel: string, handlerArgs: unknown[]): Attributes | undefined` (exported for tests; `handlerArgs` EXCLUDES the leading Electron event) and the unchanged `instrumentIpcHandle(ipc)` export.

- [ ] **Step 1: Write the failing tests** — append to `src/main/perfIpc.test.ts`:

```ts
import { channelAttrs } from './perfIpc.js';

describe('channelAttrs', () => {
  it('maps workspace/session args for mapped channels', () => {
    expect(channelAttrs('sessions:write', ['ws-1', { sessions: [] }]))
      .toEqual({ workspace_id: 'ws-1' });
    expect(channelAttrs('observability:summaryForBrokerSession', ['ws-1', 'bs-2']))
      .toEqual({ workspace_id: 'ws-1', session_id: 'bs-2' });
    expect(channelAttrs('observability:eventsForSession', ['sess-uuid', 0, 500]))
      .toEqual({ session_id: 'sess-uuid' });
  });

  it('returns undefined for unmapped channels and non-string args', () => {
    expect(channelAttrs('workspace:list', [])).toBeUndefined();
    expect(channelAttrs('sessions:write', [undefined, {}])).toBeUndefined();
    expect(channelAttrs('sessions:list', [undefined])).toBeUndefined(); // optional arg omitted
  });
});
```

(Keep the existing `import { instrumentIpcHandle } from './perfIpc.js';` — merge the two imports into one statement.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/perfIpc.test.ts`
Expected: FAIL — `channelAttrs` is not exported.

- [ ] **Step 3: Implement** — replace the body of `src/main/perfIpc.ts` with:

```ts
// Generic IPC instrumentation: patch `ipcMain.handle` once, before ipc.ts
// registers anything, so every invoke handler runs inside a
// `claude_fleet.ipc.<channel>` span. With recording off the tracer is a
// no-op, so the wrapper's cost is one extra async frame per invoke.
//
// CHANNEL_CONTEXT stamps workspace/session attribution from handler args
// where the ids are literally present (the SQLite exporter lifts the
// `workspace_id`/`session_id` attributes into perf_events columns, which
// also scopes those rows to the workspace in the MCP query snapshot).
// Channels whose ids are only known post-lookup (pty:*) instead call
// perfSetSpanContext inside the handler. Channels with no id in their args
// (workspace:list, config:*, …) are deliberately absent: their rows stay
// app-global. NOTE: `workspace:stop/pause/remove` and `workspace:ensureImage`
// receive a container/channel id, not a workspace ULID — mapping them would
// stamp the wrong key space, so they are absent too.

import type { Attributes } from '@opentelemetry/api';
import { perfSpanAsync } from './perf.js';

const W0 = { workspaceArg: 0 } as const;
const W0S1 = { workspaceArg: 0, sessionArg: 1 } as const;
const S0 = { sessionArg: 0 } as const;

/** Channel → 0-based positions (after the Electron event) of id-bearing args.
 *  session ids here are whatever the channel traffics in — broker session ids
 *  for `*ForBrokerSession`/`mirror:*`, claude session UUIDs for
 *  `observability:eventsForSession`/`getCost` — matching what the rest of
 *  perf_events already stores. */
const CHANNEL_CONTEXT: Record<string, { workspaceArg?: number; sessionArg?: number }> = {
  'sessions:read': W0,
  'sessions:list': W0,
  'sessions:write': W0,
  'sessions:resume': W0,
  'sessions:delete': W0S1,
  'sessions:resolveResumeTarget': W0S1,
  'sessions:rename': S0,
  'workspace:start': W0,
  'workspace:getManifest': W0,
  'committee:pause': W0,
  'committee:unpause': W0,
  'committee:post': W0,
  'committee:collect': W0,
  'committee:status': W0,
  'committee:roster': W0,
  'loadouts:install': W0,
  'loadouts:uninstall': W0,
  'loadouts:catalog': W0,
  'files:dropOsFiles': W0,
  'files:dropBytes': W0,
  'files:dropUrl': W0,
  'files:dropText': W0,
  'vault:listKeys': W0,
  'vault:getSecret': W0,
  'vault:setSecret': W0,
  'vault:deleteSecret': W0,
  'vault:deleteAllForWorkspace': W0,
  'transcript:list': W0,
  'transcript:hasForBrokerSession': W0S1,
  'transcript:deleteForBrokerSession': W0S1,
  'mirror:setOverride': W0S1,
  'ports:open': W0,
  'ports:kill': W0,
  'observability:summaryForWorkspace': W0,
  'observability:getCostForWorkspace': W0,
  'observability:summaryForBrokerSession': W0S1,
  'observability:eventsForSession': S0,
  'observability:getCost': S0
};

/** Attribution attrs for a channel invoke. `handlerArgs` excludes the leading
 *  Electron event. Non-string args (optional params omitted) are skipped. */
export function channelAttrs(channel: string, handlerArgs: unknown[]): Attributes | undefined {
  const m = CHANNEL_CONTEXT[channel];
  if (!m) return undefined;
  const attrs: Attributes = {};
  if (m.workspaceArg !== undefined && typeof handlerArgs[m.workspaceArg] === 'string') {
    attrs.workspace_id = handlerArgs[m.workspaceArg] as string;
  }
  if (m.sessionArg !== undefined && typeof handlerArgs[m.sessionArg] === 'string') {
    attrs.session_id = handlerArgs[m.sessionArg] as string;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

export function instrumentIpcHandle(ipc: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (channel: string, listener: (...args: any[]) => unknown) => void;
}): void {
  const raw = ipc.handle.bind(ipc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc.handle = (channel: string, listener: (...args: any[]) => unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw(channel, ((...args: any[]) =>
      perfSpanAsync(`claude_fleet.ipc.${channel}`, () => listener(...args), channelAttrs(channel, args.slice(1)))));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/perfIpc.test.ts src/main/perf.test.ts`
Expected: all PASS (the two pre-existing `instrumentIpcHandle` tests must still pass — the wrapper change is additive).

- [ ] **Step 5: SPEC §11 scoping note.** In `docs/SPEC.md` line 1253 (the `query` bullet), find the sentence fragment:

`` `perf_events` rows are included where `workspace_id IS NULL OR workspace_id IN <allowed-set>`; ``

and extend it (same sentence, before the semicolon → becomes):

`` `perf_events` rows are included where `workspace_id IS NULL OR workspace_id IN <allowed-set>` — since the attribution expansion, IPC slow-op rows for id-bearing channels carry `workspace_id` and are therefore scoped to that workspace; only genuinely global rows (stalls, `claude_fleet.perf.flush`, id-less channels) remain NULL and visible to every caller; ``

- [ ] **Step 6: Commit**

```bash
git add src/main/perfIpc.ts src/main/perfIpc.test.ts docs/SPEC.md
git commit -m "feat(perf): stamp workspace/session attribution on IPC spans from a per-channel arg map"
```

---

### Task 5: In-handler stamping for `pty:attach` + `pty:input` (`ipc.ts`)

The pty channels address by container id / pty handle id, so attribution needs the in-handler lookups. No unit test — `ipc.ts` is not vitest-loadable (Electron imports); the machinery is covered by Tasks 2–4 and the gate is typecheck + build + the existing Playwright terminal specs in CI.

**Files:**
- Modify: `src/main/ipc.ts:1493` (pty:attach, after the owner lookup) and `src/main/ipc.ts:1560-1562` (pty:input)

**Interfaces:**
- Consumes: `perfSetSpanContext` from `perf.ts` (Task 3); the existing `handleWorkspaceId: Map<string, string>` and `owner` lookup already in `ipc.ts`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Import.** In `src/main/ipc.ts`, extend the existing perf import (search for `from './perf.js'` — it currently imports `recordPtyChunk`, `getPerfStatus`, `getEffectivePerf`) to also include `perfSetSpanContext`.

- [ ] **Step 2: pty:attach.** After line 1493 (`if (owner) handleWorkspaceId.set(ptyHandleId, owner.id);`), add:

```ts
      perfSetSpanContext({ workspaceId: owner?.id, sessionId: brokerSessionId });
```

- [ ] **Step 3: pty:input.** Replace the handler body (lines 1560-1562):

```ts
  ipcMain.handle('pty:input', (_e, sessionId: string, data: string) => {
    perfSetSpanContext({ workspaceId: handleWorkspaceId.get(sessionId) });
    ptySessions.get(sessionId)?.stream.write(data);
  });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean exit (both node + web configs).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(perf): attribute pty:attach/pty:input spans via post-lookup workspace ids"
```

---

### Task 6: Child spans for docker + vault calls (+ SPEC §6 rewrite)

Wrap the known heavy operations so a slow IPC span decomposes at query time (children share the parent's `trace_id`). Pattern: rename the original exported function to a module-private `*Inner`, export a thin delegating wrapper — keeps diffs small inside long function bodies.

**Files:**
- Modify: `src/main/docker.ts` (`createWorkspace:451`, `startWorkspace:625`, `pauseWorkspace:651`, `stopWorkspace:661`, `attachPty:829`)
- Modify: `src/main/vault.ts` (`resolveEnv:169`)
- Modify: `docs/SPEC.md:286` (slow-op spans paragraph)
- Test: none new (dockerode/safeStorage aren't vitest-loadable here; the span machinery is covered by Task 2's nesting test — state this in the PR body)

**Interfaces:**
- Consumes: `perfSpanAsync` + `perfSetSpanContext` from `perf.ts`.
- Produces: span names `claude_fleet.docker.create|start|pause|stop|attach_pty`, `claude_fleet.vault.resolve_env` (documented in SPEC §6; PR B does not depend on them).

- [ ] **Step 1: docker.ts imports.** Add to the import block:

```ts
import { perfSpanAsync, perfSetSpanContext } from './perf.js';
```

- [ ] **Step 2: Wrap the five docker functions.** For each, rename the existing declaration to `*Inner` and drop the `export` keyword, then add the exported wrapper directly above it. Exact wrappers:

```ts
export function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  return perfSpanAsync('claude_fleet.docker.create', () => createWorkspaceInner(spec), { workspace_id: spec.id });
}

export function startWorkspace(id: string): Promise<string | null> {
  return perfSpanAsync('claude_fleet.docker.start', () => startWorkspaceInner(id), { workspace_id: id });
}

export function pauseWorkspace(containerId: string): Promise<void> {
  return perfSpanAsync('claude_fleet.docker.pause', () => pauseWorkspaceInner(containerId));
}

export function stopWorkspace(containerId: string): Promise<void> {
  return perfSpanAsync('claude_fleet.docker.stop', () => stopWorkspaceInner(containerId));
}

export function attachPty(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number,
  resumeOf?: string
): Promise<PtyHandle> {
  return perfSpanAsync('claude_fleet.docker.attach_pty', () => attachPtyInner(containerId, sessionId, cols, rows, resumeOf), { session_id: sessionId });
}
```

(`pauseWorkspace`/`stopWorkspace` receive a Docker container id, not a workspace ULID — no `workspace_id` attr; stamping the wrong key space is worse than none.)

- [ ] **Step 3: attachPty workspace attribution.** Inside `attachPtyInner`, directly after the existing `const workspaceId = info.Config.Labels?.[ID_LABEL];` null-check block (the `throw` at ~line 841), add:

```ts
  perfSetSpanContext({ workspaceId });
```

(The active span here is the `claude_fleet.docker.attach_pty` child — the enclosing IPC span gets its own stamp from Task 5.)

- [ ] **Step 4: vault.ts.** Add the import and wrap `resolveEnv` (line 169) with the same rename-to-Inner pattern:

```ts
import { perfSpanAsync } from './perf.js';

export function resolveEnv(
  workspaceId: string,
  plain: Record<string, string>,
  secretKeys: string[]
): Promise<Record<string, string>> {
  return perfSpanAsync('claude_fleet.vault.resolve_env', () => resolveEnvInner(workspaceId, plain, secretKeys), { workspace_id: workspaceId });
}
```

Check `vault.ts` for internal callers of `resolveEnv` (there are none today — `docker.ts:479` and `local.ts:186` import it) and leave call sites untouched: the exported name and signature are unchanged.

- [ ] **Step 5: SPEC §6.** In `docs/SPEC.md` line 286, replace the final sentence of the slow-op bullet:

`Dockerode and vault calls are attributed via their enclosing IPC-channel span in Phase 1; dedicated spans are a follow-up if stall data demands finer grain.`

with:

`Dockerode and vault calls get dedicated child spans (claude_fleet.docker.create/start/pause/stop/attach_pty, claude_fleet.vault.resolve_env) parented under the enclosing IPC-channel span via OTel context propagation — a slow child persists as its own slow_op row sharing the parent's trace_id. IPC spans for id-bearing channels carry workspace_id/session_id attributes (stamped from a per-channel arg map in perfIpc.ts, or via perfSetSpanContext for post-lookup cases like pty:attach), which the SQLite exporter lifts into the perf_events columns.`

- [ ] **Step 6: Typecheck + full unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/docker.ts src/main/vault.ts docs/SPEC.md
git commit -m "feat(perf): child spans for docker + vault ops under the enclosing IPC span"
```

---

### Task 7: Full gate + PR

**Files:** none new.

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed. (No display in this container — Playwright runs in CI only.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/perf-tracing-expansion
gh pr create --title "feat(perf): span attribution + docker/vault child spans (tracing expansion PR A)" --body "$(cat <<'EOF'
## Summary
- IPC slow-op spans now carry workspace_id/session_id, stamped from a per-channel arg map (perfIpc.ts) or via the new perfSetSpanContext() helper for post-lookup cases (pty:attach, pty:input)
- perfSpan/perfSpanAsync activate spans on the OTel context (new AsyncLocalStorageContextManager registration), so nested spans parent correctly
- Dedicated child spans for docker (create/start/pause/stop/attach_pty) and vault (resolve_env) ops — slow children persist as their own slow_op rows sharing the parent trace_id
- Scoping consequence (intentional, SPEC §11): attributed IPC rows are now workspace-scoped in the MCP query snapshot instead of NULL/visible-to-all

Spec: docs/superpowers/specs/2026-08-08-perf-tracing-expansion-design.md (PR A sections). PR B (Phase 2 latency hops) follows separately.

## Verification
Gated with typecheck + unit tests + build in the dev container (no display available); Playwright terminal specs run in CI. First dogfood check after merge: `SELECT name, workspace_id, COUNT(*) FROM perf_events WHERE kind='slow_op' GROUP BY 1,2` should show attributed rows for summaryForBrokerSession et al.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review notes (already applied)

- **Spec coverage:** A1 → Task 4; A2 → Tasks 3+5; A3 → Task 6; A4 → Task 4 Step 5 (SPEC §11). PR B intentionally absent.
- **Key-space honesty:** channels receiving container ids (`workspace:stop/pause/remove`, `workspace:ensureImage`) and Docker-id-addressed wrappers (`pauseWorkspace`, `stopWorkspace`) are deliberately unmapped/unattributed rather than stamped with the wrong id kind.
- **Type consistency:** `perfSetSpanContext({ workspaceId?, sessionId? })` object-arg form used identically in Tasks 3, 5, 6; `channelAttrs(channel, handlerArgs)` takes post-event args and the wrapper passes `args.slice(1)`.
