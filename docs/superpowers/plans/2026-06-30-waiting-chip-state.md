# "Waiting on AskUserQuestion" Chip State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light a distinct "needs your input" state on the workspace chip, the terminal session-tab dot, and the left-rail Sessions row whenever a session is blocked on an `AskUserQuestion` prompt.

**Architecture:** A Claude Code `PreToolUse[AskUserQuestion]` hook (pose edge) / `PostToolUse[AskUserQuestion]`+`Stop`+`UserPromptSubmit` (clear edge), shipped in the runner and loaded via the trusted `--settings` flag, reports waiting state to the host by calling a new `signal_input_wait` MCP tool over the existing per-workspace `claude-fleet-state` socket. The tool's injected handler maintains a per-workspace set of waiting Claude-session UUIDs in main and broadcasts `inputwait:update` to renderers, which color the chips violet (reusing the busy pulse).

**Tech Stack:** Electron + TypeScript (main/preload/renderer), React renderer, `better-sqlite3`, hand-rolled JSON-RPC MCP server over unix socket / loopback-TCP, Go broker (unchanged), Vitest (unit), Playwright (e2e), bash (runner hook script).

## Global Constraints

- Claude Code is pinned to **2.1.177** in `docker/Dockerfile`; the runner is **non-root** (no apt/sudo at runtime). `socat`, `jq`, `curl` are already installed in the image.
- Hooks load via the **`--settings <file>` flag** (explicitly-provided settings are trusted and run without the interactive `/hooks` approval gate — verified in the design spike). Do **not** rely on auto-discovered `~/.claude/settings.json`.
- The MCP transport has two variants the hook must handle: **unix** (`/fleet/mcp/mcp.sock` exists) and **tcp+token** (`/fleet/mcp/token` exists → connect `host.docker.internal:${CLAUDE_FLEET_MCP_TCP_PORT:-7071}`, sending the token as the first line). Mirror `docker.ts` `managedMcpServerEntry()`.
- MCP caller identity is **ambient** — `ctx.callerId` is the workspace id of the accepting listener; never trust a wire-supplied workspace id. The session is identified by the `session_id` (Claude UUID) the hook reads from its stdin payload and passes as an arg.
- Waiting **wins over busy** wherever both could show. The waiting dot **reuses** the `chipBusyPulse` animation + `blinkSync` lockstep. New CSS token `--wait: oklch(68% 0.17 300)` (violet — distinct from green `--ok` busy and blue `--info` reachable). Workspace-chip sub-line copy: `needs input`.
- **Scope:** `AskUserQuestion` only. Container (docker) backend only — the local non-container backend is out of scope (documented limitation). Permission prompts / `ExitPlanMode` are non-goals.
- **Spec-maintenance rule:** update `docs/SPEC.md` §5/§6/§7/§11 in this same change (Task 9).
- Commit after every task. Run `npm run build` / the relevant `npx vitest run <file>` before each commit.

---

### Task 1: Runner hook reporter script

Ships in the image; reads a hook stdin payload and calls `signal_input_wait` over the MCP socket. Fire-and-forget, always exits 0 (must never block a tool call). A `CF_INPUT_WAIT_SINK` env override makes the emitted JSON-RPC capturable in tests without a real socket.

**Files:**
- Create: `docker/runner/input-wait-report.sh`
- Create: `docker/runner/hooks.settings.json`
- Test: `docker/runner/input-wait-report.test.sh`

**Interfaces:**
- Produces: a script invoked as `input-wait-report.sh` with the hook JSON on stdin. It derives `waiting = (hook_event_name == "PreToolUse")`, extracts `session_id`, and emits JSON-RPC `tools/call` for `signal_input_wait` with `{sessionId, waiting}`.

- [ ] **Step 1: Write the failing test**

```bash
# docker/runner/input-wait-report.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/input-wait-report.sh"
sink="$(mktemp)"

# PreToolUse[AskUserQuestion] → waiting:true
printf '%s' '{"session_id":"sid-1","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"name":"signal_input_wait"' "$sink" || { echo "FAIL: no tool call"; exit 1; }
grep -q '"sessionId":"sid-1"' "$sink" || { echo "FAIL: sessionId"; exit 1; }
grep -q '"waiting":true' "$sink" || { echo "FAIL: waiting not true"; exit 1; }

# PostToolUse → waiting:false
: > "$sink"
printf '%s' '{"session_id":"sid-1","hook_event_name":"PostToolUse","tool_name":"AskUserQuestion"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"waiting":false' "$sink" || { echo "FAIL: post should be false"; exit 1; }

# Stop → waiting:false (safety clear)
: > "$sink"
printf '%s' '{"session_id":"sid-1","hook_event_name":"Stop"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"waiting":false' "$sink" || { echo "FAIL: stop should be false"; exit 1; }

echo "PASS"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash docker/runner/input-wait-report.test.sh`
Expected: FAIL (script does not exist yet — `No such file`).

- [ ] **Step 3: Write the script**

```bash
# docker/runner/input-wait-report.sh
#!/usr/bin/env bash
# Claude Code hook: report whether this session is blocked on an AskUserQuestion.
# Registered for PreToolUse[AskUserQuestion] (waiting=true) and
# PostToolUse[AskUserQuestion]/Stop/UserPromptSubmit (waiting=false).
# Fire-and-forget; always exit 0 so it never blocks the tool call.
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
evt="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)"
[ -n "$sid" ] || exit 0
if [ "$evt" = "PreToolUse" ]; then waiting=true; else waiting=false; fi

req=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"signal_input_wait","arguments":{"sessionId":"%s","waiting":%s}}}' "$sid" "$waiting")

# Test seam: capture the request instead of sending it.
if [ -n "${CF_INPUT_WAIT_SINK:-}" ]; then
  printf '%s\n' "$req" >> "$CF_INPUT_WAIT_SINK"
  exit 0
fi

sock="/fleet/mcp/mcp.sock"
tok="/fleet/mcp/token"
port="${CLAUDE_FLEET_MCP_TCP_PORT:-7071}"
if [ -S "$sock" ]; then
  printf '%s\n' "$req" | timeout 2 socat - "UNIX-CONNECT:$sock" >/dev/null 2>&1 || true
elif [ -f "$tok" ]; then
  { printf '%s\n' "$(cat "$tok")"; printf '%s\n' "$req"; } \
    | timeout 2 socat - "TCP:host.docker.internal:$port" >/dev/null 2>&1 || true
fi
exit 0
```

- [ ] **Step 4: Write the settings file that registers the hook**

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ],
    "PostToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ]
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `chmod +x docker/runner/input-wait-report.sh && bash docker/runner/input-wait-report.test.sh`
Expected: `PASS`

- [ ] **Step 6: Commit**

```bash
git add docker/runner/input-wait-report.sh docker/runner/hooks.settings.json docker/runner/input-wait-report.test.sh
git commit -m "feat(runner): AskUserQuestion input-wait hook reporter script"
```

---

### Task 2: `signal_input_wait` MCP tool + handler seam

**Files:**
- Modify: `src/main/mcpServer.ts` (add `InputWaitHandler` type + `setInputWaitHandler` near `setCommitteeHandlers` ~104-107; add a tool to the `TOOLS` array ~913, before the closing `];`)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Produces: `export type InputWaitHandler = (callerId: string, sessionId: string, waiting: boolean) => void;` and `export function setInputWaitHandler(fn: InputWaitHandler): void`. New tool `signal_input_wait`, args `{ sessionId: string, waiting: boolean }`.
- Consumes (Task 4 provides): the injected handler.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/main/mcpServer.test.ts
import { TOOLS, setInputWaitHandler, type ToolCtx } from './mcpServer';

describe('signal_input_wait', () => {
  const ctx: ToolCtx = { callerId: 'ws-A', allowedWorkspaces: new Set(['ws-A']) };
  const tool = () => TOOLS.find((t) => t.name === 'signal_input_wait')!;

  it('forwards (callerId, sessionId, waiting) to the injected handler', () => {
    const calls: Array<[string, string, boolean]> = [];
    setInputWaitHandler((c, s, w) => calls.push([c, s, w]));
    tool().run({} as never, { sessionId: 'sess-1', waiting: true }, ctx);
    expect(calls).toEqual([['ws-A', 'sess-1', true]]);
  });

  it('rejects bad args', () => {
    setInputWaitHandler(() => {});
    expect(() => tool().run({} as never, { sessionId: 'x' }, ctx)).toThrow(/required/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/mcpServer.test.ts -t signal_input_wait`
Expected: FAIL (`setInputWaitHandler` is not exported / tool not found).

- [ ] **Step 3: Add the handler seam (after `setCommitteeHandlers`, ~line 107)**

```ts
/** Injected by ipc.ts: report that a session in the caller's workspace has
 *  started (waiting=true) or finished (waiting=false) blocking on an
 *  AskUserQuestion prompt. callerId is host-assigned (the accepting listener's
 *  workspace id); sessionId is the claude session UUID from the hook payload. */
export type InputWaitHandler = (callerId: string, sessionId: string, waiting: boolean) => void;
let inputWaitHandler: InputWaitHandler | null = null;
export function setInputWaitHandler(fn: InputWaitHandler): void {
  inputWaitHandler = fn;
}
```

- [ ] **Step 4: Add the tool (inside the `TOOLS` array, before the final `];` at ~line 913)**

```ts
  ,
  {
    name: 'signal_input_wait',
    description:
      'Internal (called by the runner AskUserQuestion hook, not by the model): report whether a ' +
      'session in THIS workspace is blocked waiting on an AskUserQuestion prompt. ' +
      'Args: sessionId (the claude session UUID), waiting (boolean).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, waiting: { type: 'boolean' } },
      required: ['sessionId', 'waiting']
    },
    run: (_db, a, ctx) => {
      if (!inputWaitHandler) throw new Error('input-wait signaling is unavailable');
      if (typeof a.sessionId !== 'string' || typeof a.waiting !== 'boolean') {
        throw new Error('sessionId (string) and waiting (boolean) are required');
      }
      inputWaitHandler(ctx.callerId, a.sessionId, a.waiting);
      return { ok: true };
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/mcpServer.test.ts -t signal_input_wait`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): add signal_input_wait tool + handler seam"
```

---

### Task 3: `inputwait:update` broadcaster

**Files:**
- Create: `src/main/inputWaitBroadcast.ts`
- Test: `src/main/inputWaitBroadcast.test.ts`

**Interfaces:**
- Produces: `export function broadcastInputWait(payload: { workspaceId: string; waitingSessionIds: string[] }, targets: readonly BroadcastTarget[]): void` sending channel `inputwait:update`. Reuse the `BroadcastTarget` shape from `mcpStatusBroadcast.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/inputWaitBroadcast.test.ts
import { describe, it, expect, vi } from 'vitest';
import { broadcastInputWait } from './inputWaitBroadcast';

function win(destroyed = false, wcDestroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => wcDestroyed, send: vi.fn() }
  };
}

describe('broadcastInputWait', () => {
  it('sends inputwait:update to live targets', () => {
    const a = win(); const b = win();
    broadcastInputWait({ workspaceId: 'ws', waitingSessionIds: ['s1'] }, [a, b]);
    expect(a.webContents.send).toHaveBeenCalledWith('inputwait:update', { workspaceId: 'ws', waitingSessionIds: ['s1'] });
    expect(b.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('skips destroyed targets and survives a throwing one', () => {
    const dead = win(true);
    const boom = win(); boom.webContents.send = vi.fn(() => { throw new Error('disposed'); });
    const ok = win();
    expect(() => broadcastInputWait({ workspaceId: 'ws', waitingSessionIds: [] }, [dead, boom, ok])).not.toThrow();
    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(ok.webContents.send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/inputWaitBroadcast.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the broadcaster**

```ts
// src/main/inputWaitBroadcast.ts
// Resilient `inputwait:update` fan-out — mirrors observabilityBroadcast.ts /
// mcpStatusBroadcast.ts. Pure (no electron/DB/fs) so it's unit-testable with
// plain stubs. Fires from the MCP signal_input_wait handler, not an awaited IPC
// call, so per-target sends are guarded (a window mid-teardown can throw).
import type { BroadcastTarget } from './mcpStatusBroadcast.js';

export function broadcastInputWait(
  payload: { workspaceId: string; waitingSessionIds: string[] },
  targets: readonly BroadcastTarget[]
): void {
  for (const win of targets) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('inputwait:update', payload);
    } catch {
      // swallow — see observabilityBroadcast.ts top-of-file comment.
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/inputWaitBroadcast.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/inputWaitBroadcast.ts src/main/inputWaitBroadcast.test.ts
git commit -m "feat(main): inputwait:update broadcaster"
```

---

### Task 4: Wire the handler + per-workspace waiting state + cleanup (ipc.ts)

**Files:**
- Modify: `src/main/ipc.ts` (imports ~40-41 & ~85; add state + `setInputWaitHandler` wiring near `setCommitteeHandlers` ~880; cleanup in `workspace:stop`/`workspace:pause` handlers ~853-857 and `workspace:remove` ~891)

**Interfaces:**
- Consumes: `setInputWaitHandler` (Task 2), `broadcastInputWait` (Task 3).
- Produces: the live `inputwait:update` pushes the renderer consumes (Task 5/6).

- [ ] **Step 1: Add imports**

In the `./mcpServer.js` import block (~line 40-41) add `setInputWaitHandler`:

```ts
  setCommitteeHandlers,
  setReadScopeResolver,
  setInputWaitHandler,
```

Near the `broadcastObservabilitySummary` import (~line 85):

```ts
import { broadcastInputWait } from './inputWaitBroadcast.js';
```

- [ ] **Step 2: Add the per-workspace waiting map + handler wiring (next to `setCommitteeHandlers({...})`, ~line 880)**

```ts
// Per-workspace set of claude session UUIDs currently blocked on an
// AskUserQuestion prompt (driven by the runner hook via the signal_input_wait
// MCP tool). Pushed to renderers on every change; chips render it as "needs input".
const inputWaitByWorkspace = new Map<string, Set<string>>();
function pushInputWait(workspaceId: string): void {
  const set = inputWaitByWorkspace.get(workspaceId) ?? new Set<string>();
  broadcastInputWait(
    { workspaceId, waitingSessionIds: [...set] },
    BrowserWindow.getAllWindows()
  );
}
setInputWaitHandler((callerId, sessionId, waiting) => {
  let set = inputWaitByWorkspace.get(callerId);
  if (!set) { set = new Set(); inputWaitByWorkspace.set(callerId, set); }
  if (waiting) set.add(sessionId); else set.delete(sessionId);
  pushInputWait(callerId);
});
```

- [ ] **Step 3: Clear on stop/pause (so a frozen/stopped workspace can't stay "waiting")**

The `workspace:stop` and `workspace:pause` handlers (~853-857) are keyed by `containerId`. Resolve the workspace id and clear. Replace those two handlers with:

```ts
  ipcMain.handle('workspace:stop', async (_e, containerId: string) => {
    clearInputWaitForContainer(containerId);
    return (await backendFor(containerId)).stopWorkspace(containerId);
  });
  ipcMain.handle('workspace:pause', async (_e, containerId: string) =>
    (await backendFor(containerId)).pauseWorkspace(containerId)
  );
```

And add this helper just above the handler block (it maps containerId→workspace id via the existing workspace list; if resolution is unavailable, clear nothing):

```ts
  // Clear any "waiting on input" marks for the workspace backing this container
  // and push the cleared state, so a stopped/removed workspace's chip doesn't
  // stay violet. Best-effort: a container with no resolvable workspace is a no-op.
  async function clearInputWaitForContainer(containerId: string): Promise<void> {
    const all = await listAllWorkspaces().catch(() => []);
    const ws = all.find((w) => w.containerId === containerId);
    if (!ws) return;
    if (inputWaitByWorkspace.delete(ws.id)) pushInputWait(ws.id);
  }
```

> Note for implementer: confirm `WorkspaceSummary` has `containerId` and `id` fields (it does — see `src/main/App`/workspace shape). If `pause` should also clear, call `clearInputWaitForContainer` there too; leaving pause without a clear is acceptable because the runner's `Stop` hook already fires a `waiting=false` at end of the turn before a pause.

- [ ] **Step 4: Clear on remove**

In the `workspace:remove` handler (~891), after the removal succeeds, the workspace id is known from args/lookup; clear its entry:

```ts
    // (inside workspace:remove, after a successful remove)
    if (inputWaitByWorkspace.delete(/* workspace id for containerId */ removedWorkspaceId)) {
      pushInputWait(removedWorkspaceId);
    }
```

> Implementer: derive `removedWorkspaceId` the same way the handler already resolves the target (via `backendFor`/`listAllWorkspaces`). If the handler only has `containerId`, reuse `clearInputWaitForContainer(containerId)` before the container is destroyed.

- [ ] **Step 5: Build + manual sanity**

Run: `npm run build`
Expected: type-checks clean. (Behavior is covered end-to-end in Task 10.)

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(main): maintain + push per-workspace input-wait state with cleanup"
```

---

### Task 5: Preload `onInputWait` subscription

**Files:**
- Modify: `src/preload/index.ts` (add to the `observability` object ~568, after `onSummary`)

**Interfaces:**
- Produces: `window.api.observability.onInputWait(cb: (workspaceId: string, waitingSessionIds: string[]) => void): () => void`.

- [ ] **Step 1: Add the subscription (after the `onSummary` block, before the closing `}` of `observability` at ~line 569)**

```ts
    ,
    /**
     * Subscribe to live "needs input" pushes. Main fires one per change with the
     * full set of claude session UUIDs in that workspace currently blocked on an
     * AskUserQuestion prompt. Returns an unsubscribe.
     */
    onInputWait: (
      cb: (workspaceId: string, waitingSessionIds: string[]) => void
    ): (() => void) => {
      const channel = 'inputwait:update';
      const handler = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; waitingSessionIds: string[] }
      ): void => cb(payload.workspaceId, payload.waitingSessionIds);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
```

- [ ] **Step 2: Build to verify types**

Run: `npm run build`
Expected: clean (the `FleetApi` type picks up `onInputWait` automatically).

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): onInputWait subscription"
```

---

### Task 6: Renderer waiting state in App + broker-id resolution helper

**Files:**
- Create: `src/renderer/src/waitingSessions.ts`
- Test: `src/renderer/src/waitingSessions.test.ts`
- Modify: `src/renderer/src/App.tsx` (state ~249; subscribe near the busy-resolve effect ~673-705; derive + pass props ~978-1037)

**Interfaces:**
- Produces: `App` passes `waitingByWorkspace: Record<string, boolean>` to `WorkspaceTabStrip`, `waitingSessionIds: Set<string>` (claude UUIDs) to `SessionsPane`, and `waitingBrokerIds: Set<string>` (broker ids, for the active workspace) to `TerminalPane`.
- Helper: `export function waitingBrokerIdSet(waitingClaudeIds, mappings): Map<string, Set<string>>` inverting the `broker→claude` mappings to `workspaceId → Set<brokerId>`.

- [ ] **Step 1: Write the failing helper test**

```ts
// src/renderer/src/waitingSessions.test.ts
import { describe, it, expect } from 'vitest';
import { waitingBrokerIdSet } from './waitingSessions';

describe('waitingBrokerIdSet', () => {
  it('maps waiting claude UUIDs back to broker ids per workspace', () => {
    // mappings: workspaceId -> (brokerId -> claudeId)
    const mappings = new Map([['ws1', new Map([['bkr-A', 'claude-1'], ['bkr-B', 'claude-2']])]]);
    const waiting = new Map([['ws1', new Set(['claude-2'])]]);
    const out = waitingBrokerIdSet(waiting, mappings);
    expect(out.get('ws1')).toEqual(new Set(['bkr-B']));
  });

  it('is empty when nothing waits', () => {
    const out = waitingBrokerIdSet(new Map(), new Map());
    expect(out.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/waitingSessions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the helper**

```ts
// src/renderer/src/waitingSessions.ts
// The waiting set arrives keyed by *claude* session UUID (from the runner hook).
// The Sessions list is keyed by claude UUID (direct use), but the terminal
// session *tab* is keyed by *broker* id — so invert each workspace's learned
// broker→claude mapping to get the waiting broker ids per workspace.
export function waitingBrokerIdSet(
  waitingByWorkspace: Map<string, Set<string>>,
  mappings: Map<string, Map<string, string>>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [wsId, claudeIds] of waitingByWorkspace) {
    if (claudeIds.size === 0) continue;
    const map = mappings.get(wsId);
    if (!map) continue;
    const brokers = new Set<string>();
    for (const [brokerId, claudeId] of map) {
      if (claudeIds.has(claudeId)) brokers.add(brokerId);
    }
    if (brokers.size > 0) out.set(wsId, brokers);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/waitingSessions.test.ts`
Expected: PASS

- [ ] **Step 5: Add App state (after `busySessionIds` ~line 249)**

```tsx
  // workspaceId -> set of claude session UUIDs blocked on AskUserQuestion.
  const [waitingByWorkspace, setWaitingByWorkspace] = useState<Map<string, Set<string>>>(new Map());
```

- [ ] **Step 6: Subscribe to onInputWait (add a dedicated effect near the busy-resolve effect, ~line 705)**

```tsx
  useEffect(() => {
    const unsubscribe = window.api.observability.onInputWait((workspaceId, waitingSessionIds) => {
      setWaitingByWorkspace((prev) => {
        const next = new Map(prev);
        if (waitingSessionIds.length === 0) next.delete(workspaceId);
        else next.set(workspaceId, new Set(waitingSessionIds));
        return next;
      });
    });
    return unsubscribe;
  }, []);
```

- [ ] **Step 7: Derive the three shapes (just before the `return (` of the render, near where `busySessionIds` is used; reuse the existing `mappings` built in the busy-resolve effect — lift it to component state if it is currently effect-local)**

```tsx
  // Union of waiting claude UUIDs across all workspaces — for the Sessions list.
  const waitingSessionIds = useMemo(() => {
    const s = new Set<string>();
    for (const set of waitingByWorkspace.values()) for (const id of set) s.add(id);
    return s;
  }, [waitingByWorkspace]);

  // Per-workspace boolean — for the workspace chip.
  const waitingByWorkspaceFlag = useMemo(() => {
    const rec: Record<string, boolean> = {};
    for (const [wsId, set] of waitingByWorkspace) rec[wsId] = set.size > 0;
    return rec;
  }, [waitingByWorkspace]);

  // Broker ids of the *active* workspace's waiting sessions — for the session tab.
  const waitingBrokerIds = useMemo(
    () => waitingBrokerIdSet(waitingByWorkspace, mappingsState).get(selectedId ?? '') ?? new Set<string>(),
    [waitingByWorkspace, mappingsState, selectedId]
  );
```

> Implementer note: `mappingsState` is the `workspaceId → (brokerId → claudeId)` map. The busy-resolve effect (~680-699) currently builds this `mappings` locally; promote it to `useState`/`useMemo` (`mappingsState`) so this task can read it. Add `import { waitingBrokerIdSet } from './waitingSessions';` and `useMemo` to the React import.

- [ ] **Step 8: Pass the props**

`<WorkspaceTabStrip>` (~978): add `waitingByWorkspace={waitingByWorkspaceFlag}`.
`<SessionsPane>` (~1005): add `waitingSessionIds={waitingSessionIds}`.
`<TerminalPane>` (~1037): add `waitingBrokerIds={waitingBrokerIds}`.

- [ ] **Step 9: Run helper test + build**

Run: `npx vitest run src/renderer/src/waitingSessions.test.ts && npm run build`
Expected: PASS + clean build (after Task 7 adds the props to each component).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/waitingSessions.ts src/renderer/src/waitingSessions.test.ts src/renderer/src/App.tsx
git commit -m "feat(renderer): track + distribute input-wait state in App"
```

---

### Task 7: Chip UI — violet waiting dot on all three indicators + CSS

**Files:**
- Modify: `src/renderer/src/styles.css` (token ~57; `.dot` rules ~203-213; `.session-tab-dot` rules; `.session-busy-dot` ~569)
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx` (`ChipDot` ~15-18; props ~43; dot + sub-line render ~256/294/319-320)
- Modify: `src/renderer/src/components/TerminalPane.tsx` (`SessionTabDot` ~32-40; props ~118; render ~712)
- Modify: `src/renderer/src/components/SessionsPane.tsx` (props ~44/75; `SessionBusyDot`→waiting variant ~29; render ~206-209)
- Test: `src/renderer/src/components/chipState.test.ts` (pure class-builder, see Step 1)

**Interfaces:**
- Consumes: `waitingByWorkspace` (bool record), `waitingSessionIds` (Set<claudeId>), `waitingBrokerIds` (Set<brokerId>) from Task 6.

- [ ] **Step 1: Write the failing test for a shared class-builder (precedence: waiting > busy)**

```ts
// src/renderer/src/components/chipState.test.ts
import { describe, it, expect } from 'vitest';
import { dotClass } from './chipState';

describe('dotClass', () => {
  it('waiting wins over busy', () => {
    expect(dotClass({ base: 'dot running', busy: true, waiting: true })).toBe('dot running waiting');
  });
  it('busy when not waiting', () => {
    expect(dotClass({ base: 'dot running', busy: true, waiting: false })).toBe('dot running busy');
  });
  it('plain when neither', () => {
    expect(dotClass({ base: 'dot running', busy: false, waiting: false })).toBe('dot running');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/components/chipState.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the class-builder**

```ts
// src/renderer/src/components/chipState.ts
// Single source of truth for status-dot classes so the precedence rule
// (waiting wins over busy) is identical on the workspace chip, session tab,
// and Sessions row. `waiting` and `busy` both pulse (same chipBusyPulse);
// `waiting` adds the violet `.waiting` colour + "?" glyph at the call site.
export function dotClass({ base, busy, waiting }: { base: string; busy: boolean; waiting: boolean }): string {
  if (waiting) return `${base} waiting`;
  if (busy) return `${base} busy`;
  return base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/chipState.test.ts`
Expected: PASS

- [ ] **Step 5: CSS — add token + waiting rules**

In `:root` near `--info` (~line 57) add:

```css
  --wait:        oklch(68% 0.17 300);    /* violet — "needs your input" */
```

After the busy dot rule (~line 207) add:

```css
/* Waiting on AskUserQuestion: same pulse as busy, violet, wins over busy. */
.ws-chip .dot.waiting { background: var(--wait); animation: chipBusyPulse 1s ease-in-out infinite; }
.ws-chip .chip-wait-glyph { color: var(--wait); flex-shrink: 0; font-weight: 700; }
```

Near the session-tab-dot rules add:

```css
.session-tab .session-tab-dot.waiting { background: var(--wait); animation: chipBusyPulse 1s ease-in-out infinite; }
```

After `.session-busy-dot` (~line 588) add a waiting modifier:

```css
.session-busy-dot.waiting { background: var(--wait); }
```

- [ ] **Step 6: WorkspaceTabStrip — ChipDot + waiting prop + "?" glyph + sub-line**

Replace `ChipDot` (~15-18):

```tsx
function ChipDot({ state, busy, waiting }: { state: WorkspaceState; busy: boolean; waiting: boolean }): JSX.Element {
  const blink = useBlinkSync(busy || waiting);
  return <span className={`${dotClass({ base: `dot ${state}`, busy, waiting })}`} style={blink} />;
}
```

Add `import { dotClass } from './chipState';`. Add to `Props` (~43, after `busyByWorkspace`):

```tsx
  /** Per-workspace "needs input" flag (a session is blocked on AskUserQuestion). */
  waitingByWorkspace: Record<string, boolean>;
```

In the `live.map` body (~256) compute waiting and use it:

```tsx
        const busy = w.state === 'running' && busyByWorkspace[w.id] === true;
        const waiting = w.state === 'running' && waitingByWorkspace[w.id] === true;
```

Update the `<ChipDot .../>` (~294): `<ChipDot state={w.state} busy={busy} waiting={waiting} />`.
After the paused glyph block (~302) add a waiting glyph:

```tsx
              {waiting && <span className="chip-wait-glyph" title="Waiting on your input">?</span>}
```

Update the sub-line (~319-320) so waiting wins:

```tsx
              <span className={`ws-chip-sub ${busy || waiting ? 'busy' : ''}`}>
                {waiting ? 'needs input' : busy ? 'working…' : chipActivityText(summaries[w.id]) ?? ' '}
              </span>
```

And the chip `title` (~292): `title={waiting ? 'Waiting on your input' : busy ? 'Claude is working…' : w.status}`.

- [ ] **Step 7: TerminalPane — SessionTabDot waiting**

Replace `SessionTabDot` (~32-40):

```tsx
function SessionTabDot({ ended, busy, waiting }: { ended: boolean; busy: boolean; waiting: boolean }): JSX.Element {
  const active = !ended && (busy || waiting);
  const cls = waiting && !ended ? 'waiting' : busy && !ended ? 'busy' : '';
  const label = ended ? 'session ended' : waiting ? 'waiting on your input' : busy ? 'Claude is working' : 'session live';
  const blink = useBlinkSync(active);
  return (
    <span
      className={`session-tab-dot ${ended ? 'ended' : 'live'} ${cls}`}
      style={blink}
      aria-label={label}
      title={label === 'Claude is working' ? 'Claude is working…' : label}
    />
  );
}
```

> Implementer: if `SessionTabDot` does not already call `useBlinkSync`, add `import { useBlinkSync } from '../blinkSync';` (already imported in this file for other dots; confirm). Add to `Props` (~118):

```tsx
  /** Broker session ids in this workspace blocked on AskUserQuestion. */
  waitingBrokerIds?: Set<string>;
```

Destructure it in the component params (~230 area, alongside `onBusyIdsChange`), and update the render (~712):

```tsx
              <SessionTabDot ended={ended} busy={busyIds.has(s.id)} waiting={waitingBrokerIds?.has(s.id) ?? false} />
```

- [ ] **Step 8: SessionsPane — waiting row**

Add to `Props` (~44, after `busySessionIds`):

```tsx
  /** Claude session UUIDs blocked on AskUserQuestion (violet "needs input" dot). */
  waitingSessionIds?: Set<string>;
```

Destructure (~75): add `waitingSessionIds,`. Update `SessionBusyDot` (~29) to accept a waiting flag:

```tsx
function SessionBusyDot({ waiting }: { waiting: boolean }): JSX.Element {
  const blink = useBlinkSync(true);
  return <span className={`session-busy-dot ${waiting ? 'waiting' : ''}`} style={blink} />;
}
```

Update the row render (~206-209):

```tsx
              const busy = busySessionIds?.has(s.id) ?? false;
              const waiting = waitingSessionIds?.has(s.id) ?? false;
              return (
                <li key={s.id} className={`session-row${waiting ? ' waiting' : busy ? ' busy' : ''}`}>
                  {(busy || waiting) && <SessionBusyDot waiting={waiting} />}
```

- [ ] **Step 9: Run unit test + build**

Run: `npx vitest run src/renderer/src/components/chipState.test.ts && npm run build`
Expected: PASS + clean build.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/styles.css src/renderer/src/components/chipState.ts src/renderer/src/components/chipState.test.ts src/renderer/src/components/WorkspaceTabStrip.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/SessionsPane.tsx
git commit -m "feat(renderer): violet waiting chip state on workspace chip, session tab, and Sessions row"
```

---

### Task 8: Ship the hook into the runner (image + `--settings` injection)

**Files:**
- Modify: `docker/Dockerfile` (copy the script + settings into the image, ~after line 61)
- Modify: `src/main/docker.ts` (append `--settings` to the claude create args ~line 885)
- Test: `src/main/docker.test.ts` (or the nearest existing docker args test — see `claudeJsonSeed.test.ts` for the pattern)

**Interfaces:**
- Consumes: `docker/runner/input-wait-report.sh`, `docker/runner/hooks.settings.json` (Task 1).
- Produces: every container claude launch loads the hook via `--settings /usr/local/lib/claude-fleet/hooks.settings.json`.

- [ ] **Step 1: Dockerfile — bake the script + settings (after the broker COPY, ~line 61, before `USER fleet`)**

```dockerfile
# claude-fleet "needs input" hook: reports AskUserQuestion pose/clear edges to
# the host MCP server so the chip can show a waiting state. World-readable;
# loaded via --settings on each claude launch (trusted, no /hooks approval gate).
RUN mkdir -p /usr/local/lib/claude-fleet
COPY docker/runner/input-wait-report.sh /usr/local/lib/claude-fleet/input-wait-report.sh
COPY docker/runner/hooks.settings.json /usr/local/lib/claude-fleet/hooks.settings.json
RUN chmod 0755 /usr/local/lib/claude-fleet/input-wait-report.sh \
 && chmod 0644 /usr/local/lib/claude-fleet/hooks.settings.json
```

- [ ] **Step 2: Write the failing test for the args injection**

```ts
// add to src/main/docker.test.ts (create if absent, mirroring claudeJsonSeed.test.ts imports)
import { describe, it, expect } from 'vitest';
import { claudeCreateArgs } from './docker';

describe('claudeCreateArgs', () => {
  it('always loads the input-wait hook settings', () => {
    expect(claudeCreateArgs(undefined)).toEqual(
      ['--settings', '/usr/local/lib/claude-fleet/hooks.settings.json']
    );
  });
  it('appends --resume after the settings flag', () => {
    expect(claudeCreateArgs('uuid-9')).toEqual(
      ['--settings', '/usr/local/lib/claude-fleet/hooks.settings.json', '--resume', 'uuid-9']
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/main/docker.test.ts -t claudeCreateArgs`
Expected: FAIL (`claudeCreateArgs` not exported).

- [ ] **Step 4: Extract + use the args builder in docker.ts**

Add near the top-level helpers:

```ts
const RUNNER_HOOK_SETTINGS = '/usr/local/lib/claude-fleet/hooks.settings.json';

/** Args for the broker CREATE that launches claude in-container. Always loads
 *  the input-wait hook via --settings (trusted; no /hooks approval gate), then
 *  resumes a prior session when `resumeOf` is set. */
export function claudeCreateArgs(resumeOf?: string): string[] {
  const args = ['--settings', RUNNER_HOOK_SETTINGS];
  if (resumeOf) args.push('--resume', resumeOf);
  return args;
}
```

Then replace the inline arg at ~line 885:

```ts
      // was: resumeOf ? ['--resume', resumeOf] : undefined
      claudeCreateArgs(resumeOf)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/docker.test.ts -t claudeCreateArgs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile src/main/docker.ts src/main/docker.test.ts
git commit -m "feat(runner): ship + load the input-wait hook via --settings"
```

---

### Task 9: SPEC.md updates

**Files:**
- Modify: `docs/SPEC.md` (§5 renderer layout; §6 IPC + MCP tool list; §7 runner contract; §11 supersede the shelved "needs-input" decision)

- [ ] **Step 1: §5 — document the waiting chip**

After the busy-indicator paragraph (the one ending "…see §11."), add:

```markdown
A running chip also surfaces a **waiting indicator** — a violet (`--wait`) status
dot that **reuses the busy pulse** plus a `?` glyph and a `needs input` secondary
line — when a session is blocked on an `AskUserQuestion` prompt. **Waiting wins
over busy.** The same violet state appears on the session-tab dot and the Sessions
row. Unlike busy/idle (PTY title glyph), waiting is sourced from a runner hook, not
the terminal stream: a `PreToolUse[AskUserQuestion]` hook reports waiting=true and
`PostToolUse[AskUserQuestion]`/`Stop`/`UserPromptSubmit` report waiting=false, via
the `signal_input_wait` MCP tool. Main keeps a per-workspace set of waiting claude
session UUIDs and pushes `inputwait:update` `{ workspaceId, waitingSessionIds }` to
renderers; App keys the Sessions list directly by UUID and resolves the session tab
via the broker→claude mapping. Container backend only.
```

- [ ] **Step 2: §6 — IPC + MCP tool**

In the Observability IPC list add: `**inputwait:update** (main→renderer push) — `{ workspaceId, waitingSessionIds: string[] }`; the set of claude session UUIDs in that workspace currently blocked on AskUserQuestion.` In the MCP tool list add `signal_input_wait` (args `sessionId`, `waiting`; called by the runner hook, identity ambient).

- [ ] **Step 3: §7 — runner contract**

Add: the runner image bakes `/usr/local/lib/claude-fleet/input-wait-report.sh` + `hooks.settings.json`, and every in-container claude launch is started with `--settings /usr/local/lib/claude-fleet/hooks.settings.json` (trusted load, bypasses the `/hooks` approval gate).

- [ ] **Step 4: §11 — supersede the shelved decision**

Rewrite the `AskUserQuestion`/"needs-input shelved" item: a pose-time signal **does** exist via an installed `PreToolUse[AskUserQuestion]` hook (Claude Code 2.1.177) — independent of the JSONL (which still only flushes the tool_use at answer-time). The chip waiting state is built on it. Note the remaining gap: **permission prompts** and **ExitPlanMode** are still not surfaced.

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): waiting-on-input chip state, signal_input_wait, runner hook (§5/§6/§7/§11)"
```

---

### Task 10: End-to-end test (Playwright)

**Files:**
- Create: `tests/input-wait.spec.ts` (mirror `tests/observability.spec.ts` setup)

**Interfaces:**
- Consumes: the MCP `signal_input_wait` tool and the `inputwait:update` push → chip class.

- [ ] **Step 1: Write the test**

Drive the signal directly through the MCP server (no real container needed) and assert the chip reacts. Mirror `observability.spec.ts`'s app-launch + workspace-manifest fixtures; then, from the host side, invoke the injected input-wait handler for a known workspace/session and assert the DOM.

```ts
// tests/input-wait.spec.ts
import { test, expect } from '@playwright/test';
import { launchApp, seedRunningWorkspace, fireInputWait } from './_helpers';

test('workspace chip + sessions row show waiting then clear', async () => {
  const app = await launchApp();
  const { workspaceId, claudeSessionId } = await seedRunningWorkspace(app);

  await fireInputWait(app, { workspaceId, sessionId: claudeSessionId, waiting: true });
  await expect(app.page.locator(`.ws-chip-group[data-ws="${workspaceId}"] .dot.waiting`)).toBeVisible();
  await expect(app.page.locator(`.session-row.waiting`)).toBeVisible();

  await fireInputWait(app, { workspaceId, sessionId: claudeSessionId, waiting: false });
  await expect(app.page.locator(`.dot.waiting`)).toHaveCount(0);

  await app.close();
});
```

- [ ] **Step 2: Add the helpers**

In `tests/_helpers.ts` add `fireInputWait(app, { workspaceId, sessionId, waiting })` that reaches into main (via the existing test IPC/eval bridge used by `observability.spec.ts`) and calls the registered input-wait handler, and `seedRunningWorkspace` if not already present. If the test harness can't invoke the handler directly, connect to the workspace's MCP socket and send a `signal_input_wait` `tools/call` (reusing the Task-1 framing).

> Implementer: also add `data-ws={w.id}` to the chip group `div` in `WorkspaceTabStrip.tsx` (~258) if no stable per-workspace selector exists, so the e2e can target a specific chip.

- [ ] **Step 3: Run it**

Run: `npx playwright test tests/input-wait.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/input-wait.spec.ts tests/_helpers.ts src/renderer/src/components/WorkspaceTabStrip.tsx
git commit -m "test(e2e): waiting chip state appears and clears on input-wait signal"
```

---

## Self-Review

**Spec coverage:** signal (Task 1) · MCP tool (Task 2) · broadcaster (Task 3) · host state+cleanup (Task 4) · preload (Task 5) · renderer state (Task 6) · all three chips + CSS + precedence (Task 7) · ship via image+`--settings` (Task 8) · SPEC §5/§6/§7/§11 (Task 9) · e2e (Task 10). All design sections map to a task.

**Type consistency:** `signal_input_wait` args `{ sessionId, waiting }` are identical in the script (Task 1), tool (Task 2), and handler `(callerId, sessionId, waiting)` (Tasks 2/4). `inputwait:update` payload `{ workspaceId, waitingSessionIds: string[] }` is identical in broadcaster (3), ipc push (4), preload (5), App (6). `dotClass`/`waitingBrokerIdSet` names match across Tasks 6/7. `claudeCreateArgs` matches across Task 8.

**Known follow-ups (not blockers, noted for the implementer):**
- Local (non-container) backend doesn't get the hook — waiting won't show for local workspaces (documented in §5/Global Constraints).
- Clearing on MCP disconnect is not wired (Stop/PostToolUse + stop/pause/remove cover the realistic cases); revisit if stale-waiting is observed.
- `App.tsx` `mappings` must be promoted from effect-local to `mappingsState` (Task 6, Step 7) — verify the busy path still works after the lift.
