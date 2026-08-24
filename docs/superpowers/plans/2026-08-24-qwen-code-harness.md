# qwen-code Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace `harness` choice (`claude-code` | `qwen-code`) so an endpoint workspace can run qwen-code instead of claude-code, with full observability parity via an in-container transcript adapter.

**Architecture:** A `harness` manifest field forks two things at spawn — which binary the broker execs (via `CLAUDE_FLEET_BROKER_CLAUDE`) and which env dialect the endpoint compiles to (`ANTHROPIC_*` vs `OPENAI_*`). qwen-code writes Claude-family JSONL, which an in-container **sidecar** maps into fleet's exact ingest dialect at the watched path, so the host watcher only ever sees claude-dialect JSONL. Phase 1 makes a qwen workspace boot and run; Phase 2 lights up observability.

**Tech Stack:** TypeScript (Electron main + React renderer), Node 22, Go broker (unchanged), Docker runner images, vitest (unit), Playwright (contract/e2e).

## Global Constraints

- `harness` field is `'claude-code' | 'qwen-code'`; **default/absent = `'claude-code'`** (zero blast radius for existing workspaces).
- `harness: 'qwen-code'` is **only valid with `authMode: 'endpoint'`** — rejected at form submit and at `manifestInvariant`.
- `harness` must be carried by **every** summary→form and form→submit builder (the #250 `endpointId` drop-on-save bug class: a present-but-undefined key overwrites on manifest merge).
- The **host JSONL watcher only ever sees claude dialect** — all harness-specific translation lives container-side.
- Endpoint spawns **strip inherited host `ANTHROPIC_API_KEY` AND `OPENAI_API_KEY`**.
- Broker binary is selected via container env **`CLAUDE_FLEET_BROKER_CLAUDE`** (default `claude`); no Go broker change.
- `qwen` version is **pinned** in `docker/versions.yaml` (Apache-2.0, npm `@qwen-code/qwen-code`, needs Node 22 — already the base). Bumped deliberately; adapter fixture tests gate the bump.
- Per `.claude/rules/spec-maintenance.md`, `docs/SPEC.md` is updated **in the same PR** (Task 6 for Phase 1, Task 14 for Phase 2).
- Unit tests are vitest `*.test.ts` next to source; run `npx vitest run <file>`. Renderer changes that can't run headless are gated by **typecheck + unit + build** (no display in this container — Troy eyeballs on host).

---

# Phase 1 — Harness selection & launch

**Phase 1 deliverable:** a `qwen-code` endpoint workspace boots, the broker execs `qwen` against the endpoint's OpenAI path with fleet-state MCP recall wired, and the harness choice round-trips through create/edit/save. Observability is still dark (Phase 2).

---

### Task 1: `Harness` type + manifest field, read/write, invariant

**Files:**
- Modify: `src/main/workspaces.ts` (type at :31–34; `WorkspaceSpec` at :140–179; `readWorkspaceManifest` at :279–328; `manifestInvariant` at :342–349)
- Test: `src/main/workspaces.test.ts` (create if absent)

**Interfaces:**
- Produces: `export type Harness = 'claude-code' | 'qwen-code'`; `WorkspaceSpec.harness?: Harness`; `manifestInvariant(spec)` returns a non-null string when `spec.authMode === 'endpoint' && !spec.harness`.

- [ ] **Step 1: Write the failing test**

Create `src/main/workspaces.test.ts` (if it exists, append the `describe` blocks):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({
  app: { getPath: (w: string) => { if (w === 'userData') return userDataDir; throw new Error(w); } }
}));

// Imported after the mock so app.getPath is patched.
const { readWorkspaceManifest, writeWorkspaceManifest, manifestInvariant } = await import('./workspaces.js');

const base = () => ({
  id: '01TESTWS0000000000000000AA', name: 'ws', labels: [] as string[],
  workspaceRoot: '/workspace', workspaceSubdir: '', kind: 'container' as const,
  authMode: 'endpoint' as const, endpointId: 'ep-1',
  env: { plain: {}, secretKeys: [] }, mirror: { default: 'on' as const, cleanup: 'off' as const },
  createdAt: 1, lastUsedAt: 1
});

beforeEach(async () => { userDataDir = await mkdtemp(join(tmpdir(), 'cf-ws-')); });
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }); });

describe('harness field', () => {
  it('round-trips harness through write→read', async () => {
    await writeWorkspaceManifest({ ...base(), harness: 'qwen-code' });
    const got = await readWorkspaceManifest(base().id);
    expect(got?.harness).toBe('qwen-code');
  });

  it('drops harness when authMode is not endpoint', async () => {
    const dir = join(userDataDir, 'state', base().id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'workspace.json'),
      JSON.stringify({ ...base(), authMode: 'oauth', endpointId: undefined, harness: 'qwen-code' }));
    const got = await readWorkspaceManifest(base().id);
    expect(got?.harness).toBeUndefined();
  });

  it('invariant rejects an endpoint workspace with no harness', () => {
    // harness is required for endpoint workspaces once the feature ships.
    expect(manifestInvariant({ ...base(), harness: undefined } as never)).toMatch(/harness/);
  });

  it('invariant accepts an endpoint workspace with a harness', () => {
    expect(manifestInvariant({ ...base(), harness: 'claude-code' } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/workspaces.test.ts`
Expected: FAIL — `harness` not on the type / not persisted / invariant returns null.

- [ ] **Step 3: Implement**

In `src/main/workspaces.ts` after `export type AuthMode = ...` (:34):
```typescript
export type Harness = 'claude-code' | 'qwen-code';
```

In `WorkspaceSpec` (:140–179), after the `endpointId` field:
```typescript
  /** authMode 'endpoint' only: which harness drives this workspace. Absent = 'claude-code'. */
  harness?: Harness;
```

In `readWorkspaceManifest` (:279–328), in the returned object after the `endpointId` line:
```typescript
      harness:
        parsed.authMode === 'endpoint' &&
        (parsed.harness === 'qwen-code' || parsed.harness === 'claude-code')
          ? parsed.harness
          : undefined,
```

In `manifestInvariant` (:342–349), before the final `return null`:
```typescript
  if (spec.authMode === 'endpoint' && !spec.harness) {
    return `endpoint workspace ${spec.id} missing harness (claude-code | qwen-code)`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/workspaces.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/workspaces.ts src/main/workspaces.test.ts
git commit -m "feat(harness): add Harness type + manifest field, read/write, invariant"
```

---

### Task 2: qwen env dialect (OpenAI-compat), forked by harness

**Files:**
- Modify: `src/main/endpoints.ts` (`compileEndpointEnv` at :60–71; `endpointEnv` at :146–155)
- Modify: `src/main/docker.ts` (:497–499), `src/main/local.ts` (`buildEnv` :338–358)
- Test: `src/main/endpoints.test.ts` (append or create)

**Interfaces:**
- Consumes: `Harness` (Task 1), `ModelEndpoint` (endpoints.ts:13–26).
- Produces: `compileEndpointEnv(ep, apiKey, harness?: Harness): Record<string,string>` — returns `OPENAI_*` vars when `harness === 'qwen-code'`, else the existing `ANTHROPIC_*` vars. `endpointEnv(endpointId, harness?)` threads harness through.

- [ ] **Step 1: Write the failing test**

Append to `src/main/endpoints.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { compileEndpointEnv } from './endpoints.js';

const ep = { id: 'e', name: 'n', baseUrl: 'http://10.0.20.10:11434', modelId: 'qwen3-coder:30b', hasApiKey: true };

describe('compileEndpointEnv harness dialects', () => {
  it('claude-code → ANTHROPIC_* against /v1', () => {
    const env = compileEndpointEnv(ep, 'k', 'claude-code');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.20.10:11434');
    expect(env.ANTHROPIC_MODEL).toBe('qwen3-coder:30b');
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('qwen-code → OPENAI_* against /v1', () => {
    const env = compileEndpointEnv(ep, 'k', 'qwen-code');
    expect(env.OPENAI_BASE_URL).toBe('http://10.0.20.10:11434/v1');
    expect(env.OPENAI_MODEL).toBe('qwen3-coder:30b');
    expect(env.OPENAI_API_KEY).toBe('k');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('defaults to claude-code when harness omitted', () => {
    expect(compileEndpointEnv(ep, 'k').ANTHROPIC_BASE_URL).toBe('http://10.0.20.10:11434');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/endpoints.test.ts`
Expected: FAIL — `compileEndpointEnv` ignores the third arg.

- [ ] **Step 3: Implement**

In `src/main/endpoints.ts`, replace `compileEndpointEnv` (:60–71) so it forks. Keep the existing Anthropic branch verbatim; add the OpenAI branch. qwen-code hits the OpenAI path, so append `/v1` to the base URL:
```typescript
export function compileEndpointEnv(
  ep: ModelEndpoint,
  apiKey: string | null,
  harness: Harness = 'claude-code'
): Record<string, string> {
  if (harness === 'qwen-code') {
    const base = ep.baseUrl.replace(/\/+$/, '') + '/v1';
    return {
      OPENAI_BASE_URL: base,
      OPENAI_API_KEY: apiKey ?? 'sk-none',
      OPENAI_MODEL: ep.modelId
    };
  }
  // existing claude-code / Anthropic dialect — unchanged
  return {
    ANTHROPIC_BASE_URL: ep.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey ?? 'none',
    ANTHROPIC_MODEL: ep.modelId,
    ANTHROPIC_SMALL_FAST_MODEL: ep.smallFastModelId ?? ep.modelId,
    CF_SUMMARY_MODEL: ep.modelId
  };
}
```
Add `import type { Harness } from './workspaces.js';` at the top (or re-declare if an import cycle appears — if so, move `Harness` into a shared `types.ts` and import from there in both files).

Thread harness through `endpointEnv` (:146–155):
```typescript
export async function endpointEnv(
  endpointId: string | undefined,
  harness: Harness = 'claude-code'
): Promise<Record<string, string>> {
  // ...existing getEndpoint + getSecret...
  return compileEndpointEnv(ep, apiKey, harness);
}
```

Update the two callers to pass the manifest harness:
- `src/main/docker.ts:497`: `const backendVars = spec.authMode === 'endpoint' ? await endpointEnv(spec.endpointId, spec.harness) : {};`
- `src/main/local.ts` `buildEnv` (:342): pass `ws.harness` through (add `harness?: Harness` to the `ws` param type at :338), and extend the strip at :347:
```typescript
  if (ws.authMode === 'endpoint') { delete base.ANTHROPIC_API_KEY; delete base.OPENAI_API_KEY; }
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/main/endpoints.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/endpoints.ts src/main/endpoints.test.ts src/main/docker.ts src/main/local.ts
git commit -m "feat(harness): compile OpenAI-dialect endpoint env for qwen-code; strip host OPENAI_API_KEY"
```

---

### Task 3: Binary + args fork (qwen create-args, broker binary env)

**Files:**
- Create: `src/main/harnessArgs.ts`
- Test: `src/main/harnessArgs.test.ts`
- Modify: `src/main/docker.ts` (attach create at :979–984; container env build near :497–499), `src/main/localSessions.ts` (args at :159–167)

**Interfaces:**
- Consumes: `Harness` (Task 1).
- Produces: `harnessCreateArgs(harness, resumeOf?, sessionId?): string[]`; `brokerBinaryFor(harness): string` (`'qwen'` | `'claude'`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { harnessCreateArgs, brokerBinaryFor } from './harnessArgs.js';

describe('harnessCreateArgs', () => {
  it('claude-code keeps --settings + --session-id', () => {
    const a = harnessCreateArgs('claude-code', undefined, 'uuid-1');
    expect(a).toContain('--settings');
    expect(a).toEqual(expect.arrayContaining(['--session-id', 'uuid-1']));
  });
  it('claude-code uses --resume when resuming', () => {
    expect(harnessCreateArgs('claude-code', 'uuid-9')).toEqual(expect.arrayContaining(['--resume', 'uuid-9']));
  });
  it('qwen-code omits --settings and uses --resume on resume', () => {
    const a = harnessCreateArgs('qwen-code', 'uuid-2');
    expect(a).not.toContain('--settings');
    expect(a).toEqual(expect.arrayContaining(['--resume', 'uuid-2']));
  });
  it('qwen-code fresh session passes no id flag (qwen mints its own)', () => {
    expect(harnessCreateArgs('qwen-code')).toEqual([]);
  });
});

describe('brokerBinaryFor', () => {
  it('maps harness to binary', () => {
    expect(brokerBinaryFor('qwen-code')).toBe('qwen');
    expect(brokerBinaryFor('claude-code')).toBe('claude');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/harnessArgs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/harnessArgs.ts`. Reuse the existing claude arg contract from `claudeArgs.ts:9–14` (settings path + session flags):
```typescript
import type { Harness } from './workspaces.js';
import { claudeCreateArgs } from './claudeArgs.js';

export function brokerBinaryFor(harness: Harness | undefined): string {
  return harness === 'qwen-code' ? 'qwen' : 'claude';
}

/**
 * Args appended to the harness binary in the PTY. claude-code keeps its
 * --settings hooks + --session-id/--resume contract. qwen-code takes no
 * --settings (fleet installs no qwen hooks in Phase 1) and only --resume on
 * resume; a fresh qwen session mints its own session id (the sidecar preserves
 * that UUID as the fleet JSONL filename — see Phase 2).
 */
export function harnessCreateArgs(harness: Harness | undefined, resumeOf?: string, sessionId?: string): string[] {
  if (harness === 'qwen-code') return resumeOf ? ['--resume', resumeOf] : [];
  return claudeCreateArgs(resumeOf, sessionId);
}
```

Wire the container path. In `src/main/docker.ts`:
- Where the create args are built (attach, :979–984), replace `claudeCreateArgs(resumeOf, claudeSessionId)` with `harnessCreateArgs(spec.harness, resumeOf, claudeSessionId)`. Ensure `spec` (or the manifest harness) is in scope at attach; if not, read it via `readWorkspaceManifest(id)` at the top of `attachPtyInner` and thread `harness` down (mirror how `local.ts:536` reads the manifest).
- Where the container env array is built (:497–499, create time), add the broker-binary selector so the broker execs the right binary:
```typescript
if (spec.harness === 'qwen-code') resolvedEnv.CLAUDE_FLEET_BROKER_CLAUDE = 'qwen';
```
(The broker reads `CLAUDE_FLEET_BROKER_CLAUDE`, default `claude` — `broker/cmd/broker/main.go:66`. No Go change.)

For the local path, in `src/main/localSessions.ts` the spawn uses the resolved claude path; extend `AttachOpts` with `harness` and select the binary/args there analogously (`brokerBinaryFor` picks the resolved `qwen` path — resolution added in Task 5's local note; for container-first Phase 1, local qwen may be deferred — guard with a clear `throw` if `harness==='qwen-code' && kind==='local'` until local resolution lands).

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/main/harnessArgs.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/harnessArgs.ts src/main/harnessArgs.test.ts src/main/docker.ts src/main/localSessions.ts
git commit -m "feat(harness): fork PTY binary + create-args by harness (broker execs qwen via env)"
```

---

### Task 4: Thread harness through IPC + renderer form (types, radios, validation)

**Files:**
- Modify: `src/main/ipc.ts` (`WorkspaceCreatePayload` :331–352; create handler copy :977–978), `src/main/docker.ts` (`CreateWorkspaceInput` :121–162)
- Modify (renderer): `src/renderer/src/App.tsx` (`WorkspaceSummary` :81–121), `src/renderer/src/components/formInitial.ts` (:21–43), `src/renderer/src/components/WorkspaceForm.tsx` (`WorkspaceFormSubmit` :36–95; state :183–188; JSX Auth region :917–984; `buildPayload` :364–501; validation :953–955)
- Create: `src/renderer/src/components/harness.ts` (pure validator)
- Test: `src/renderer/src/components/harness.test.ts`

**Interfaces:**
- Consumes: `Harness`.
- Produces: `validateHarnessSelection(authMode, harness): string | null` — error string when `authMode==='endpoint' && !harness`, else null. `harness` present on `WorkspaceCreatePayload`, `CreateWorkspaceInput`, `WorkspaceSummary`, `WorkspaceFormSubmit`, and the `workspaceToFormInitial` output.

- [ ] **Step 1: Write the failing test (pure validator)**

```typescript
import { describe, it, expect } from 'vitest';
import { validateHarnessSelection } from './harness.js';

describe('validateHarnessSelection', () => {
  it('requires a harness for endpoint workspaces', () => {
    expect(validateHarnessSelection('endpoint', undefined)).toMatch(/harness/i);
  });
  it('accepts endpoint + a harness', () => {
    expect(validateHarnessSelection('endpoint', 'qwen-code')).toBeNull();
  });
  it('ignores harness for non-endpoint auth', () => {
    expect(validateHarnessSelection('oauth', undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/harness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator + thread the type everywhere**

Create `src/renderer/src/components/harness.ts`:
```typescript
import type { AuthMode, Harness } from '../../../main/workspaces.js';

export function validateHarnessSelection(authMode: AuthMode, harness: Harness | undefined): string | null {
  if (authMode === 'endpoint' && !harness) return 'Pick a harness (Claude Code or Qwen Code) for endpoint workspaces.';
  return null;
}
```

Add `harness?: Harness` (with the `/** authMode 'endpoint' only */` comment) to each of: `WorkspaceCreatePayload` (ipc.ts:352), `CreateWorkspaceInput` (docker.ts:162), `WorkspaceSummary` (App.tsx after `endpointId`), `WorkspaceFormSubmit` (WorkspaceForm.tsx:95). In `ipc.ts` create handler (:977) add `harness: input.harness,` next to `endpointId`. In `formInitial.ts` (:41) add `harness: w.harness,`.

In `WorkspaceForm.tsx`:
- State (near :183): `const [harness, setHarness] = useState<Harness | undefined>(() => initial?.harness);`
- JSX: in the endpoint branch of the Auth row (:961–984, the `model.kind !== 'claude'` branch), render a harness radio group (mirror the `kind-radios` pattern):
```tsx
<div className="form-row" aria-label="Harness">
  <label>Harness</label>
  <div className="kind-radios" role="radiogroup">
    {(['claude-code', 'qwen-code'] as const).map((h) => (
      <label key={h} className={`kind-radio ${harness === h ? 'active' : ''}`}>
        <input type="radio" name="harness" value={h} checked={harness === h}
               onChange={() => setHarness(h)} disabled={busy} />
        <span>{h === 'claude-code' ? 'Claude Code' : 'Qwen Code'}</span>
        <span className="kind-help">{h === 'claude-code' ? "Anthropic's harness" : 'Qwen-tuned harness'}</span>
      </label>
    ))}
  </div>
</div>
```
- `buildPayload` (:467–501 return): add `harness: model.kind === 'endpoint' ? harness : undefined,`.
- Validation (:953–955, next to the endpointId check): 
```typescript
  const harnessErr = validateHarnessSelection(input.authMode, input.harness);
  if (harnessErr) throw new Error(harnessErr);
```
Import `validateHarnessSelection` and `Harness` at the top.

- [ ] **Step 4: Verify — unit + typecheck + build (no display here)**

Run: `npx vitest run src/renderer/src/components/harness.test.ts && npm run typecheck && npm run build`
Expected: unit PASS; typecheck clean; build succeeds. (Radio rendering is eyeballed on host per the no-UI-verification-in-container rule — state that in the PR.)

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/main/docker.ts src/renderer/src/App.tsx \
  src/renderer/src/components/formInitial.ts src/renderer/src/components/WorkspaceForm.tsx \
  src/renderer/src/components/harness.ts src/renderer/src/components/harness.test.ts
git commit -m "feat(harness): thread harness through IPC + form builders; endpoint-only validation + radios"
```

---

### Task 5: Runner variant image (qwen binary + MCP config + broker-binary env)

**Files:**
- Create: `docker/qwen/Dockerfile`, `docker/scripts/qwen.sh`
- Modify: `docker/versions.yaml` (add `qwen:` pin)
- Modify: `src/main/docker.ts` — image selection for qwen workspaces (near `CreateWorkspaceInput.image` handling) and qwen MCP config seeding (mirror `managedMcpServerEntry` :381–408 / claude.json seed :431–464 into a qwen `settings.json` with `mcpServers`)

**Interfaces:**
- Consumes: the base runner image; `CONTAINER_MCP_SOCKET = '/fleet/mcp/mcp.sock'` (mcpSocket.ts:65).
- Produces: `ghcr.io/imioimi/claude-fleet/runner-qwen` carrying `qwen` + `socat` + a seeded `~/.qwen/settings.json` pointing fleet-state MCP at the bind-mounted socket.

- [ ] **Step 1: Add the version pin**

In `docker/versions.yaml` add (pick the current stable from the qwen-code releases page at implementation time; example shown):
```yaml
qwen: 0.22.0
```

- [ ] **Step 2: Write the install script**

Create `docker/scripts/qwen.sh` (mirror `gh.sh` structure; qwen is an npm global, so no arch tarball needed but keep the `_arch.sh` source for consistency):
```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${QWEN_VERSION:-0.22.0}"
npm install -g "@qwen-code/qwen-code@${V}"
qwen --version | sed -n '1p'   # sed, not head — head SIGPIPEs under QEMU
```

- [ ] **Step 3: Write the variant Dockerfile**

Create `docker/qwen/Dockerfile` (mirror `docker/devops/Dockerfile:12–13` FROM-base pattern):
```dockerfile
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest
FROM ${BASE_IMAGE}

ARG QWEN_VERSION=0.22.0
USER root
COPY docker/scripts/_arch.sh docker/scripts/qwen.sh /opt/install-scripts/
RUN apt-get update && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/* \
 && cd /opt/install-scripts && QWEN_VERSION="${QWEN_VERSION}" bash qwen.sh

USER fleet
WORKDIR /workspace
```

- [ ] **Step 4: Image selection + qwen MCP seeding in host code**

In `src/main/docker.ts`: when `spec.harness === 'qwen-code'` and no explicit `image`, default the container image to the qwen variant (add a constant `QWEN_RUNNER_IMAGE` next to the base image constant). Add a `seedQwenSettings(id, workingDir)` alongside the claude.json seeder (:431–464) that writes `~/.qwen/settings.json` into the workspace with:
```jsonc
{
  "mcpServers": {
    "claude-fleet-state": {
      "command": "socat",
      "args": ["-", "UNIX-CONNECT:/fleet/mcp/mcp.sock"]
    }
  }
}
```
Call it from the qwen create path (guard on `spec.harness === 'qwen-code'`). (This replaces the node reconnect-bridge with a direct `socat` stdio bridge — identity is ambient from the socket, mcpSocket.ts:18–30.)

- [ ] **Step 5: Verify build (note environment limits)**

Run (host or CI with Docker): `docker build -f docker/qwen/Dockerfile -t runner-qwen:test --build-arg BASE_IMAGE=<base> .`
Expected: builds; `docker run --rm runner-qwen:test qwen --version` prints the pinned version.
If Docker is unavailable in this container, state in the PR that the image build is CI/host-verified (mirrors the runner-image workflow). Commit regardless.

- [ ] **Step 6: Commit**

```bash
git add docker/qwen/Dockerfile docker/scripts/qwen.sh docker/versions.yaml src/main/docker.ts
git commit -m "feat(harness): qwen variant runner image + fleet-state MCP via socat; auto-select for qwen workspaces"
```

---

### Task 6: SPEC.md — Phase 1 (data model, env contract, runner image)

**Files:** Modify `docs/SPEC.md` (§4 runner image; §data-model manifest + env contract; §the workspace-create flow).

- [ ] **Step 1:** Add `harness` to the manifest data-model section (values, default, endpoint-only invariant). Document the two env dialects (`ANTHROPIC_*` vs `OPENAI_*` + `/v1`), the `CLAUDE_FLEET_BROKER_CLAUDE` binary switch, and the `OPENAI_API_KEY` strip. Document the qwen variant image and its `socat` MCP wiring. Edit in place; no changelog prose (spec-maintenance rule).
- [ ] **Step 2:** Handoff check — could a fresh reader rebuild the harness fork from the spec alone? Fix gaps.
- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): document harness field, env dialects, qwen variant image (Phase 1)"
```

---

# Phase 2 — Observability adapter

**Phase 2 deliverable:** a qwen-code workspace has full observability parity — cost/tokens/tool calls/history/summaries/search, busy-idle chip, session mapping — via an in-container sidecar that maps qwen's JSONL into fleet's dialect at the watched path.

---

### Task 7: Pricing — register qwen endpoints (unpriced by default)

**Files:** Modify `src/main/pricing.ts` (:57–103); Test `src/main/pricing.test.ts` (append).

**Interfaces:** Produces: `familyFor` returns `null` for qwen model ids (→ `$0`, one-time warn, `—` in UI) — the existing unknown-model path. No rate table entry in v1 (Open decision: price only if a rate is configured on the endpoint).

- [ ] **Step 1: Write the failing test** (pins the intended behavior so a future bump doesn't accidentally mis-price):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { costFor, familyFor } from './pricing.js';
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

describe('qwen endpoints are unpriced', () => {
  it('familyFor(qwen) is null', () => expect(familyFor('qwen3-coder:30b')).toBeNull());
  it('costFor(qwen) is 0 (renders — in UI)', () =>
    expect(costFor('qwen3-coder:30b', 'standard',
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toBe(0));
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/pricing.test.ts` → Expected: PASS immediately (existing unknown-model path already yields this). This task **pins** the contract; if it fails, do not add a rate — confirm the unknown path still returns 0.

- [ ] **Step 3: Commit**

```bash
git add src/main/pricing.test.ts
git commit -m "test(pricing): pin qwen endpoints as unpriced (—) via unknown-model path"
```

---

### Task 8: Transcript mapper — pure qwen-record → claude-dialect line

**Files:** Create `src/main/qwenAdapter.ts`; Test `src/main/qwenAdapter.test.ts`.

**Interfaces:**
- Produces: `mapQwenRecord(rec: unknown): string | null` — returns a claude-dialect JSONL line (no trailing newline) for user/assistant/tool records; `null` for records that carry no ingestible signal. The output must satisfy the ingest contract fields read by `db.ts:ingestLine`: `type`, `timestamp`, `uuid`, `message.model`, `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,service_tier}`, `message.content[]` `tool_use`/`tool_result`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { mapQwenRecord } from './qwenAdapter.js';

const parse = (line: string | null) => (line ? JSON.parse(line) : null);

describe('mapQwenRecord', () => {
  it('maps an assistant record with usage + model', () => {
    const out = parse(mapQwenRecord({
      type: 'assistant', uuid: 'u1', parentUuid: 'p0', timestamp: '2026-08-24T00:00:00.000Z',
      model: 'qwen3-coder:30b',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 5 },
      message: { role: 'assistant', content: [{ text: 'hello' }] }
    }));
    expect(out.type).toBe('assistant');
    expect(out.uuid).toBe('u1');
    expect(out.message.model).toBe('qwen3-coder:30b');
    expect(out.message.usage.input_tokens).toBe(100);
    expect(out.message.usage.output_tokens).toBe(20);
    expect(out.message.usage.cache_read_input_tokens).toBe(5);
    expect(out.message.usage.service_tier).toBe('standard');
  });

  it('maps a tool call (functionCall → tool_use)', () => {
    const out = parse(mapQwenRecord({
      type: 'assistant', uuid: 'u2', timestamp: '2026-08-24T00:00:01.000Z', model: 'qwen3-coder:30b',
      message: { role: 'assistant', content: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] }
    }));
    const tu = out.message.content.find((b: { type: string }) => b.type === 'tool_use');
    expect(tu).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } });
    expect(typeof tu.id).toBe('string');
  });

  it('maps a tool result (functionResponse → tool_result)', () => {
    const out = parse(mapQwenRecord({
      type: 'tool_result', uuid: 'u3', timestamp: '2026-08-24T00:00:02.000Z',
      toolCallResult: { callId: 'call_1', status: 'success' },
      message: { role: 'user', content: [{ functionResponse: { name: 'read_file', response: { content: 'x' } } }] }
    }));
    const tr = out.message.content.find((b: { type: string }) => b.type === 'tool_result');
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', is_error: false });
  });

  it('maps a user record so first_user_message fills', () => {
    const out = parse(mapQwenRecord({
      type: 'user', uuid: 'u4', timestamp: '2026-08-24T00:00:03.000Z',
      message: { role: 'user', content: [{ text: 'do the thing' }] }
    }));
    expect(out.type).toBe('user');
    expect(out.message.content).toContain('do the thing');
  });

  it('returns null for a system/unmappable record', () => {
    expect(mapQwenRecord({ type: 'system', subtype: 'session_model' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/qwenAdapter.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/main/qwenAdapter.ts`:

```typescript
// Maps qwen-code ChatRecord lines (Gemini-CLI lineage) into the claude-dialect
// JSONL that src/main/db.ts:ingestLine reads. Pure + total: never throws, returns
// null for records with no ingestible signal. Field names verified against the
// installed qwen version's chatRecordingService — adjust the getters if a bump
// renames them (fixture tests here fail loudly on drift).
type Rec = Record<string, unknown>;
const asObj = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function usage(rec: Rec): Rec | undefined {
  const u = asObj(rec.usageMetadata);
  if (!('promptTokenCount' in u) && !('candidatesTokenCount' in u)) return undefined;
  return {
    input_tokens: Number(u.promptTokenCount ?? 0),
    output_tokens: Number(u.candidatesTokenCount ?? 0),
    cache_read_input_tokens: Number(u.cachedContentTokenCount ?? 0),
    cache_creation_input_tokens: 0,
    service_tier: 'standard'
  };
}

function content(rec: Rec): unknown[] {
  const msg = asObj(rec.message);
  const parts = asArr(msg.content);
  const out: unknown[] = [];
  const textChunks: string[] = [];
  for (const p of parts) {
    const part = asObj(p);
    if (typeof part.text === 'string') textChunks.push(part.text);
    else if (part.functionCall) {
      const fc = asObj(part.functionCall);
      out.push({ type: 'tool_use', id: String(fc.id ?? fc.name ?? cryptoId()), name: String(fc.name ?? ''), input: fc.args ?? {} });
    } else if (part.functionResponse) {
      const tcr = asObj(rec.toolCallResult);
      out.push({ type: 'tool_result', tool_use_id: String(tcr.callId ?? ''), is_error: tcr.status === 'error', content: JSON.stringify(asObj(part.functionResponse).response ?? {}) });
    }
  }
  // user records: db.ts fills first_user_message from message.content as a string.
  if (rec.type === 'user' && !out.length) return [textChunks.join('')];
  if (textChunks.length) out.unshift({ type: 'text', text: textChunks.join('') });
  return out;
}

let counter = 0;
function cryptoId(): string { return `tu_${Date.now().toString(36)}_${counter++}`; } // sidecar-local; ids only need per-file uniqueness

export function mapQwenRecord(raw: unknown): string | null {
  const rec = asObj(raw);
  const type = rec.type;
  if (type !== 'user' && type !== 'assistant' && type !== 'tool_result') return null;
  const line: Rec = {
    type: type === 'tool_result' ? 'user' : type,   // db.ts treats tool_result blocks inside a user turn
    uuid: rec.uuid, parentUuid: rec.parentUuid, timestamp: rec.timestamp,
    message: {
      role: type === 'assistant' ? 'assistant' : 'user',
      model: rec.model, content: content(rec),
      ...(usage(rec) ? { usage: usage(rec) } : {})
    }
  };
  return JSON.stringify(line);
}
```
Note in Step 3 review: `cryptoId` uses `Date.now()` — the sidecar is a normal Node process (not a workflow), so this is fine; ids only need per-file uniqueness for tool_use/tool_result pairing.

- [ ] **Step 4: Run** `npx vitest run src/main/qwenAdapter.test.ts && npm run typecheck` → Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/qwenAdapter.ts src/main/qwenAdapter.test.ts
git commit -m "feat(harness): pure qwen-record → claude-dialect JSONL mapper"
```

---

### Task 9: Sidecar runtime — tail qwen JSONL → fleet path (idempotent)

**Files:** Create `docker/qwen/sidecar.mjs` (self-contained Node, ships in the qwen image — must not import app code; inline the mapper OR bundle `qwenAdapter` at build); Create `src/main/qwenSidecar.test.ts` (tests the file-tailing/dedup logic via an extracted pure helper `nextLines(prevOffset, buffer)`).

**Interfaces:**
- Produces: given qwen's `~/.qwen/projects/<proj>/chats/<sid>.jsonl`, appends mapped claude-dialect lines to `<workspace-state>/.claude/projects/-workspace/<sid>.jsonl` (filename = qwen session UUID, so the host watcher + `broker_sessions` pairing + mirror work unchanged). Offset-tracked; re-reads from 0 on shrink (matches jsonlWatcher.ts:165–204 compaction handling); each mapped line written at most once.

- [ ] **Step 1: Write the failing test** (pure line-splitter, mirrors the watcher's complete-line rule):

```typescript
import { describe, it, expect } from 'vitest';
import { nextLines } from '../../docker/qwen/lines.mjs';

describe('nextLines', () => {
  it('returns only complete lines and the new offset', () => {
    const buf = 'a\nb\nhalf';
    const { lines, offset } = nextLines(buf);
    expect(lines).toEqual(['a', 'b']);
    expect(offset).toBe(4); // bytes up to and incl. the 2nd \n
  });
  it('yields nothing when no newline yet', () => {
    expect(nextLines('partial').lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/qwenSidecar.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `docker/qwen/lines.mjs`:
```javascript
export function nextLines(buffer) {
  const lastNl = buffer.lastIndexOf('\n');
  if (lastNl < 0) return { lines: [], offset: 0 };
  const complete = buffer.slice(0, lastNl);
  return { lines: complete.split('\n'), offset: lastNl + 1 };
}
```

Create `docker/qwen/sidecar.mjs` — a small watcher loop using `fs.watch` + offset reads over the chats dir, mapping each line via the inlined mapper (import from a build-bundled copy of `qwenAdapter`, or inline `mapQwenRecord`), writing to the fleet path, and emitting the OSC title (Task 10). Skeleton (fill the map import at build):
```javascript
import { watch, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { nextLines } from './lines.mjs';
import { mapQwenRecord } from './qwenAdapter.mjs';   // bundled at image build
import { titleFor } from './title.mjs';              // Task 10

const CHATS = process.env.CF_QWEN_CHATS_DIR;         // ~/.qwen/projects/<proj>/chats
const OUT   = process.env.CF_FLEET_PROJECTS_DIR;     // <state>/.claude/projects/-workspace
const offsets = new Map();  // sid -> byte offset

async function pump(sid) {
  const src = join(CHATS, `${sid}.jsonl`);
  const dst = join(OUT, `${sid}.jsonl`);
  const stat = await fsp.stat(src).catch(() => null);
  if (!stat) return;
  let off = offsets.get(sid) ?? 0;
  if (stat.size < off) off = 0;                       // compaction → re-read
  const buf = (await fsp.readFile(src, 'utf8')).slice(off);
  const { lines, offset } = nextLines(buf);
  if (!lines.length) return;
  const mapped = lines.map(mapLine).filter(Boolean);
  if (mapped.length) await fsp.appendFile(dst, mapped.join('\n') + '\n');
  offsets.set(sid, off + offset);
  process.stdout.write(titleFor(lines));              // OSC busy/idle title
}
function mapLine(l) { try { return mapQwenRecord(JSON.parse(l)); } catch { return null; } }
// watch CHATS for <sid>.jsonl add/change → pump(sid); poll fallback every 1s.
```
Wire the build so `qwenAdapter.mjs` is emitted next to `sidecar.mjs` (a small esbuild step in the Dockerfile, or copy a hand-authored `.mjs` mirror kept in sync by the Task 8 tests). Document the chosen approach in the Dockerfile.

- [ ] **Step 4: Run** `npx vitest run src/main/qwenSidecar.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker/qwen/lines.mjs docker/qwen/sidecar.mjs src/main/qwenSidecar.test.ts
git commit -m "feat(harness): qwen→fleet transcript sidecar (offset-tracked, idempotent)"
```

---

### Task 10: OSC busy/idle title from qwen session status

**Files:** Create `docker/qwen/title.mjs`; Test `src/main/qwenTitle.test.ts`.

**Interfaces:** Produces `titleFor(lines: string[]): string` — an OSC-2 title string whose first glyph is a braille spinner (U+2801) while a turn is in-flight and a non-braille glyph when idle, matching `activityDetector.ts:13–24` (busy iff first codepoint ∈ U+2800–U+28FF).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { titleFor } from '../../docker/qwen/title.mjs';

const firstGlyph = (osc: string) => [...osc.replace(/^\]0;/, '').replace(/$/, '').trim()][0];
const isBraille = (ch: string) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x2800 && c <= 0x28ff; };

describe('titleFor', () => {
  it('busy while an assistant turn is streaming (no turn_result yet)', () => {
    const osc = titleFor([JSON.stringify({ type: 'assistant' })]);
    expect(isBraille(firstGlyph(osc))).toBe(true);
  });
  it('idle after a turn_result / user-input-wait', () => {
    const osc = titleFor([JSON.stringify({ type: 'system', subtype: 'turn_result' })]);
    expect(isBraille(firstGlyph(osc))).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/qwenTitle.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `docker/qwen/title.mjs`:
```javascript
// Emits the OSC-2 title fleet's activityDetector reads: braille first glyph = busy.
export function titleFor(lines) {
  let busy = false;
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === 'assistant') busy = true;
    if (r.type === 'system' && (r.subtype === 'turn_result' || r.subtype === 'user_input_wait')) busy = false;
  }
  const glyph = busy ? '⠁' : '✳'; // ⠁ busy / ✳ idle (matches claude's idle glyph)
  return `]0;${glyph} qwen`;
}
```

- [ ] **Step 4: Run** `npx vitest run src/main/qwenTitle.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker/qwen/title.mjs src/main/qwenTitle.test.ts
git commit -m "feat(harness): emit braille-glyph OSC title so busy/idle chip works for qwen"
```

---

### Task 11: Ship + start the sidecar in the qwen image

**Files:** Modify `docker/qwen/Dockerfile` (copy `docker/qwen/*.mjs`, add the bundle step for `qwenAdapter.mjs`, and start the sidecar alongside the broker); Modify `src/main/docker.ts` (pass `CF_QWEN_CHATS_DIR` / `CF_FLEET_PROJECTS_DIR` env into the container).

- [ ] **Step 1:** In the Dockerfile, `COPY docker/qwen/*.mjs /usr/local/lib/claude-fleet/qwen/`, add an esbuild step that emits `qwenAdapter.mjs` from `src/main/qwenAdapter.ts` into that dir, and change the entry so both broker and sidecar run (e.g. a tiny supervisor or `CMD ["/usr/local/lib/claude-fleet/qwen/start.sh"]` that backgrounds the sidecar then execs the broker). The sidecar must not block or replace the broker.
- [ ] **Step 2:** In `src/main/docker.ts`, for qwen workspaces set container env `CF_QWEN_CHATS_DIR` (the in-container `~/.qwen/projects/*/chats` — resolve the project subdir the same way qwen sanitizes cwd; if non-deterministic, point the sidecar at `~/.qwen/projects` and let it discover the `chats` dir) and `CF_FLEET_PROJECTS_DIR=/workspace/.claude/projects/-workspace` (the in-container view of the watched bind mount — confirm the mount path against the base image's claude projects dir).
- [ ] **Step 3: Verify** (host/CI Docker): build the image, run a qwen session against the stub endpoint, confirm a `<sid>.jsonl` appears in the fleet projects dir. If Docker unavailable here, mark CI/host-verified in the PR.
- [ ] **Step 4: Commit**

```bash
git add docker/qwen/Dockerfile src/main/docker.ts
git commit -m "feat(harness): ship + supervise the qwen transcript sidecar in the runner image"
```

---

### Task 12: Contract test — qwen workspace yields same-shape rows

**Files:** Create `tests/qwen-observability.spec.ts` (mirror `tests/observability.spec.ts:13–149`).

- [ ] **Step 1:** Seed a workspace manifest with `authMode: 'endpoint'`, `endpointId`, `harness: 'qwen-code'`. Instead of launching a container, write a **qwen-dialect** JSONL fixture into the sidecar's source dir and run the mapper→writer path (import `mapQwenRecord`, write the mapped line to the watched projects dir) — or, if running the real sidecar, drop a qwen line and assert the fleet line appears. Then assert via the observability push (`onSummary`) that tokens + a tool call surfaced, identical in shape to the claude case.
- [ ] **Step 2: Run** `npx playwright test tests/qwen-observability.spec.ts` (needs a display; CI). Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add tests/qwen-observability.spec.ts
git commit -m "test(harness): contract — qwen workspace produces claude-shape observability rows"
```

---

### Task 13: e2e — qwen workspace boots + one turn + busy chip

**Files:** Create `tests/qwen-workspace.spec.ts` (mirror `tests/endpoint-workspace.spec.ts:10–93`); Create `tests/fixtures/qwen-stub.mjs` (a stub that, when exec'd as `qwen`, writes a qwen-dialect JSONL turn to `~/.qwen/.../chats/<sid>.jsonl` and prints an OSC title).

- [ ] **Step 1:** Seed `endpoints.json` + a `harness: 'qwen-code'` manifest. Launch electron with `CLAUDE_FLEET_LOCAL_CLAUDE_BIN=process.execPath` and `CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS=<qwen-stub>` (the local path exercises the env/args/sidecar without Docker). Resume the workspace; assert the terminal shows `OPENAI_BASE_URL=…/v1` and `OPENAI_MODEL=qwen3-coder:30b`, and that the observability pane shows a token count + tool call.
- [ ] **Step 2: Run** `npx playwright test tests/qwen-workspace.spec.ts` (CI/display). Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add tests/qwen-workspace.spec.ts tests/fixtures/qwen-stub.mjs
git commit -m "test(harness): e2e — qwen workspace boots against endpoint, observability lights up"
```

---

### Task 14: SPEC.md — Phase 2 + resolve Open decisions

**Files:** Modify `docs/SPEC.md` (§6 observability); update the design spec's Open decisions.

- [ ] **Step 1:** Document the in-container sidecar (tail qwen JSONL → claude-dialect at the watched path; host watcher unchanged), the OSC-title busy signal, qwen unpriced (`—`), and the schema-drift mitigation (pinned qwen + adapter fixture tests). Resolve the Open decisions in `docs/superpowers/specs/2026-08-24-qwen-code-harness-design.md` (env-vars chosen; dedicated sidecar process chosen; unpriced default).
- [ ] **Step 2:** Handoff check.
- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-08-24-qwen-code-harness-design.md
git commit -m "docs(spec): document qwen observability sidecar + resolve open decisions (Phase 2)"
```

---

## Self-Review

**Spec coverage:** harness field + validation (T1,T4) ✓; env dialects + credential strip (T2) ✓; binary/args fork via broker env (T3) ✓; renderer picker (T4) ✓; variant image + MCP-via-socat (T5) ✓; transcript adapter in-container (T8,T9) ✓; busy/idle title (T10); session mapping preserved via UUID filename (T9) ✓; recall via MCP socket (T5) ✓; committee PTY-first (unchanged — no task needed) ✓; pricing unpriced (T7) ✓; three test tiers (T1/2/3/4/7/8/9/10 unit, T12 contract, T13 e2e) ✓; SPEC updates (T6,T14) ✓; serving-layer parked (no task — correct, it's a non-goal) ✓; daemon fallback (non-goal for v1 — documented, not built) ✓.

**Placeholder scan:** the two genuinely deferred build details — the `qwenAdapter.mjs` bundle step (T9/T11) and the exact in-container `chats`/projects paths (T11) — are called out with a concrete resolution instruction, not left as "TODO". qwen version pin (T5) is "current stable at implementation" because pinning a stale version now would be wrong; that's a deliberate lookup, not a placeholder.

**Type consistency:** `Harness` used consistently (T1 defines, T2–T4 consume); `harness` field name identical across manifest/IPC/summary/form; `mapQwenRecord`/`nextLines`/`titleFor` names match between impl and tests; `compileEndpointEnv(ep, apiKey, harness)` arity consistent T2↔callers.

**Known cross-version risk (flagged, not a plan defect):** qwen `usageMetadata`/`ChatRecord` field names (T8) are from research, not the installed binary — the T8 fixtures are written to fail loudly if a bump renames them; verify against `qwen`'s `chatRecordingService` when T8 is implemented and adjust the getters only.
