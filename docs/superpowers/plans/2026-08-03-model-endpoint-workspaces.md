# Model-Endpoint Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspaces can run claude-code against non-Anthropic model endpoints (local Ollama/vLLM, org gateways) via an app-level endpoint registry and a third `AuthMode: 'endpoint'` that compiles to ordinary workspace env vars.

**Architecture:** A new `src/main/endpoints.ts` module owns the registry (`<userData>/endpoints.json`, API keys in the existing vault under `endpoint:<id>` scopes) and compiles an endpoint into `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL`/`CF_SUMMARY_MODEL` env vars. Both runtimes (docker container `Env`, local spawn env) spread that compiled env *under* the workspace's own `resolveEnv` result (user env wins). No protocol translation anywhere; observability is backend-blind (validated empirically — see the spec).

**Tech Stack:** Electron main (TS ESM, `.js` import suffixes), React renderer, vitest unit tests colocated with source, Playwright e2e in `tests/`.

**Spec:** `docs/superpowers/specs/2026-07-23-model-endpoint-workspaces-design.md` (approved). GitHub issue #250.

## Global Constraints

- Work happens in the worktree `/workspace/claude-fleet/.claude/worktrees/semantic-transcript-search` on branch `feat/model-endpoint-workspaces`. NEVER touch `/workspace/claude-fleet` (main checkout, different branch). Use `git -C <worktree>` or run commands from inside the worktree.
- `docs/SPEC.md` must be updated in the same commit as each behavior change (`.claude/rules/spec-maintenance.md`). Tasks below say which section.
- Imports between `src/main/*.ts` files use the `.js` suffix (`import { x } from './endpoints.js'`).
- Unit tests: `npx vitest run src/main/<file>.test.ts` from the worktree root. Full gates: `npm run typecheck`, `npm run test:unit`.
- The unit-test env needs the prebuilt better-sqlite3 binary + electron path stub already set up in the base checkout's node_modules (see memory note `run-unit-tests-env`); if `npx vitest run` fails on native modules, report it rather than reinstalling things.
- Env-var names are load-bearing, copy exactly: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CF_SUMMARY_MODEL`. Placeholder token when an endpoint has no API key: `claude-fleet` (Ollama-style servers require *a* token value, not a valid one).
- The endpoint save-probe MUST NOT call `/v1/messages/count_tokens` (Ollama 404s it; claude-code tolerates that).
- User-set workspace env always overrides compiled endpoint env (spread endpoint vars first, workspace env second).

---

### Task 1: Endpoint registry module (`endpoints.ts`)

**Files:**
- Create: `src/main/endpoints.ts`
- Test: `src/main/endpoints.test.ts`

**Interfaces:**
- Consumes: `getSecret`, `setSecret`, `deleteAllForWorkspace` from `./vault.js` (existing: `getSecret(scopeId: string, key: string): Promise<string | null>` — vault scopes are plain string keys with no format validation, so `endpoint:<id>` scopes are safe).
- Produces (later tasks rely on these exact names):
  - `interface ModelEndpoint { id: string; name: string; baseUrl: string; modelId: string; smallFastModelId?: string; contextLength?: number; hasApiKey: boolean; notes?: string }`
  - `parseEndpoints(raw: unknown): ModelEndpoint[]` (pure)
  - `compileEndpointEnv(ep: ModelEndpoint, apiKey: string | null): Record<string, string>` (pure)
  - `listEndpoints(): Promise<ModelEndpoint[]>`
  - `saveEndpoint(input: Omit<ModelEndpoint, 'id' | 'hasApiKey'> & { id?: string }): Promise<ModelEndpoint>` (upsert; mints `crypto.randomUUID()` when `id` absent)
  - `deleteEndpoint(id: string): Promise<void>` (also deletes vault scope)
  - `setEndpointApiKey(id: string, value: string | null): Promise<void>` (null clears; updates `hasApiKey`)
  - `getEndpoint(id: string): Promise<ModelEndpoint | null>`
  - `endpointEnv(endpointId: string | undefined): Promise<Record<string, string>>` (looks up + vault key + compile; returns `{}` for undefined/unknown id, with a `console.warn` for unknown)
  - `ENDPOINT_VAULT_KEY = 'ANTHROPIC_AUTH_TOKEN'`, vault scope helper `endpointVaultScope(id) => \`endpoint:${id}\``
  - `_resetEndpointsCacheForTests(): void`

- [ ] **Step 1: Write the failing test for the pure functions**

```typescript
// src/main/endpoints.test.ts
import { describe, it, expect } from 'vitest';
import { parseEndpoints, compileEndpointEnv, type ModelEndpoint } from './endpoints.js';

const ep: ModelEndpoint = {
  id: 'abc',
  name: 'local-ollama',
  baseUrl: 'http://host.docker.internal:11434',
  modelId: 'qwen3:4b',
  hasApiKey: false
};

describe('compileEndpointEnv', () => {
  it('compiles the full env contract with the placeholder token when no key', () => {
    expect(compileEndpointEnv(ep, null)).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'claude-fleet',
      ANTHROPIC_MODEL: 'qwen3:4b',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3:4b',
      CF_SUMMARY_MODEL: 'qwen3:4b'
    });
  });

  it('uses the real key and smallFastModelId when present', () => {
    const env = compileEndpointEnv({ ...ep, smallFastModelId: 'qwen3:0.6b', hasApiKey: true }, 'sk-org-123');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-org-123');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('qwen3:0.6b');
    expect(env.ANTHROPIC_MODEL).toBe('qwen3:4b');
  });

  it('strips a trailing slash from baseUrl', () => {
    const env = compileEndpointEnv({ ...ep, baseUrl: 'http://10.0.0.5:8000/' }, null);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.0.5:8000');
  });
});

describe('parseEndpoints', () => {
  it('accepts a valid persisted list and drops malformed rows', () => {
    const parsed = parseEndpoints([
      { id: 'a', name: 'n', baseUrl: 'http://x:1', modelId: 'm', hasApiKey: true },
      { id: 'b', name: 'missing-url', modelId: 'm', hasApiKey: false },
      'garbage'
    ]);
    expect(parsed.map((e) => e.id)).toEqual(['a']);
  });

  it('returns [] for non-arrays', () => {
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints({})).toEqual([]);
  });

  it('coerces optional fields defensively', () => {
    const [e] = parseEndpoints([
      { id: 'a', name: 'n', baseUrl: 'http://x:1', modelId: 'm', hasApiKey: 'yes', contextLength: '40960', notes: 7 }
    ]);
    expect(e.hasApiKey).toBe(false);       // strict boolean
    expect(e.contextLength).toBeUndefined(); // strict number
    expect(e.notes).toBeUndefined();         // strict string
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from the worktree): `npx vitest run src/main/endpoints.test.ts`
Expected: FAIL — `Cannot find module './endpoints.js'` (or equivalent).

- [ ] **Step 3: Implement `src/main/endpoints.ts`**

Follow the shape and caching pattern of `src/main/config.ts` (in-memory cache, `writeFile` with 2-space JSON + trailing newline). Persist to `<userData>/endpoints.json` via `join(app.getPath('userData'), 'endpoints.json')`.

```typescript
// Model-endpoint registry (#250): app-level list of Anthropic-format
// (/v1/messages) endpoints that workspaces with authMode 'endpoint' point
// claude-code at. Non-secret fields persist to <userData>/endpoints.json;
// the optional API key lives in the vault under scope `endpoint:<id>`.
// Fleet CONSUMES endpoints — it never manages inference (spec non-goal).

import { app } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getSecret, setSecret, deleteAllForWorkspace, deleteSecret } from './vault.js';

export interface ModelEndpoint {
  id: string;
  name: string;
  /** Anthropic-format base URL — claude-code appends /v1/messages itself. No trailing slash. */
  baseUrl: string;
  modelId: string;
  /** Backend for claude's haiku-class calls; defaults to modelId. */
  smallFastModelId?: string;
  /** Display metadata only — the SERVER owns the real allocation (spec §A). */
  contextLength?: number;
  /** True iff a key is stored in the vault (the key itself never lives here). */
  hasApiKey: boolean;
  notes?: string;
}

export const ENDPOINT_VAULT_KEY = 'ANTHROPIC_AUTH_TOKEN';
export function endpointVaultScope(id: string): string {
  return `endpoint:${id}`;
}

export function parseEndpoints(raw: unknown): ModelEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelEndpoint[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.name !== 'string' || !o.name) continue;
    if (typeof o.baseUrl !== 'string' || !o.baseUrl) continue;
    if (typeof o.modelId !== 'string' || !o.modelId) continue;
    out.push({
      id: o.id,
      name: o.name,
      baseUrl: o.baseUrl,
      modelId: o.modelId,
      smallFastModelId: typeof o.smallFastModelId === 'string' && o.smallFastModelId ? o.smallFastModelId : undefined,
      contextLength:
        typeof o.contextLength === 'number' && Number.isFinite(o.contextLength) && o.contextLength > 0
          ? Math.round(o.contextLength)
          : undefined,
      hasApiKey: o.hasApiKey === true,
      notes: typeof o.notes === 'string' && o.notes ? o.notes : undefined
    });
  }
  return out;
}

/** Compile an endpoint into the env contract claude-code consumes (spec §B). */
export function compileEndpointEnv(ep: ModelEndpoint, apiKey: string | null): Record<string, string> {
  const baseUrl = ep.baseUrl.replace(/\/+$/, '');
  const model = ep.modelId;
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey ?? 'claude-fleet',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: ep.smallFastModelId ?? model,
    CF_SUMMARY_MODEL: model
  };
}

function endpointsPath(): string {
  return join(app.getPath('userData'), 'endpoints.json');
}

let cached: ModelEndpoint[] | null = null;

async function read(): Promise<ModelEndpoint[]> {
  if (cached) return cached;
  try {
    cached = parseEndpoints(JSON.parse(await readFile(endpointsPath(), 'utf8')));
  } catch {
    cached = [];
  }
  return cached;
}

async function write(next: ModelEndpoint[]): Promise<void> {
  cached = next;
  await writeFile(endpointsPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export async function listEndpoints(): Promise<ModelEndpoint[]> {
  return [...(await read())];
}

export async function getEndpoint(id: string): Promise<ModelEndpoint | null> {
  return (await read()).find((e) => e.id === id) ?? null;
}

export async function saveEndpoint(
  input: Omit<ModelEndpoint, 'id' | 'hasApiKey'> & { id?: string }
): Promise<ModelEndpoint> {
  const name = input.name?.trim();
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '');
  const modelId = input.modelId?.trim();
  if (!name) throw new Error('Endpoint name is required');
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
  if (!modelId) throw new Error('Model id is required');
  const all = await read();
  const existing = input.id ? all.find((e) => e.id === input.id) : undefined;
  const ep: ModelEndpoint = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name,
    baseUrl,
    modelId,
    smallFastModelId: input.smallFastModelId?.trim() || undefined,
    contextLength: input.contextLength,
    hasApiKey: existing?.hasApiKey ?? false,
    notes: input.notes?.trim() || undefined
  };
  await write(existing ? all.map((e) => (e.id === ep.id ? ep : e)) : [...all, ep]);
  return ep;
}

export async function deleteEndpoint(id: string): Promise<void> {
  await write((await read()).filter((e) => e.id !== id));
  await deleteAllForWorkspace(endpointVaultScope(id));
}

export async function setEndpointApiKey(id: string, value: string | null): Promise<void> {
  const all = await read();
  const ep = all.find((e) => e.id === id);
  if (!ep) throw new Error(`Unknown endpoint: ${id}`);
  if (value) await setSecret(endpointVaultScope(id), ENDPOINT_VAULT_KEY, value);
  else await deleteSecret(endpointVaultScope(id), ENDPOINT_VAULT_KEY);
  await write(all.map((e) => (e.id === id ? { ...e, hasApiKey: !!value } : e)));
}

/**
 * The compiled backend env for a workspace, `{}` unless it references a
 * known endpoint. Resolved LIVE at container create / local spawn so key
 * rotation and URL edits apply on next start (spec §B).
 */
export async function endpointEnv(endpointId: string | undefined): Promise<Record<string, string>> {
  if (!endpointId) return {};
  const ep = await getEndpoint(endpointId);
  if (!ep) {
    console.warn(`[endpoints] workspace references unknown endpoint '${endpointId}' — starting without backend env`);
    return {};
  }
  const key = ep.hasApiKey ? await getSecret(endpointVaultScope(endpointId), ENDPOINT_VAULT_KEY) : null;
  return compileEndpointEnv(ep, key);
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetEndpointsCacheForTests(): void {
  cached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/endpoints.test.ts`
Expected: PASS (all `compileEndpointEnv` + `parseEndpoints` tests green).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/main/endpoints.ts src/main/endpoints.test.ts
git commit -m "feat(#250): endpoint registry module — types, persistence, env compilation"
```

---

### Task 2: Save-time probe (`probeEndpoint`)

**Files:**
- Modify: `src/main/endpoints.ts` (append)
- Test: `src/main/endpoints.test.ts` (append)

**Interfaces:**
- Produces: `probeEndpoint(baseUrl: string, modelId: string, apiKey: string | null): Promise<{ ok: boolean; status?: number; message: string }>` — never throws.

- [ ] **Step 1: Write the failing test (real local HTTP server, no mocks)**

Append to `src/main/endpoints.test.ts`:

```typescript
import { createServer, type Server } from 'node:http';
import { probeEndpoint } from './endpoints.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port);
  }));
}

describe('probeEndpoint', () => {
  it('reports ok for an Anthropic-format /v1/messages endpoint', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: {} }));
      } else {
        res.writeHead(404).end();
      }
    });
    const port = await listen(server);
    try {
      const r = await probeEndpoint(`http://127.0.0.1:${port}`, 'test-model', null);
      expect(r.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('reports a helpful failure for a non-Anthropic endpoint (404)', async () => {
    const server = createServer((_req, res) => res.writeHead(404).end('not found'));
    const port = await listen(server);
    try {
      const r = await probeEndpoint(`http://127.0.0.1:${port}`, 'test-model', null);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(404);
      expect(r.message).toContain('Anthropic');
    } finally {
      server.close();
    }
  });

  it('reports unreachable endpoints without throwing', async () => {
    const r = await probeEndpoint('http://127.0.0.1:1', 'test-model', null);
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain('unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/endpoints.test.ts`
Expected: FAIL — `probeEndpoint` is not exported.

- [ ] **Step 3: Implement `probeEndpoint`** (append to `src/main/endpoints.ts`)

```typescript
/**
 * One cheap POST {baseUrl}/v1/messages with max_tokens:1 (spec §A). Success
 * ⇒ the endpoint speaks the Anthropic Messages API. Deliberately does NOT
 * touch /v1/messages/count_tokens — Ollama 404s it and claude-code copes.
 * 10s timeout: LAN endpoints answer fast; a cold local model may need to
 * load, but the probe is a format check, not a health check.
 */
export async function probeEndpoint(
  baseUrl: string,
  modelId: string,
  apiKey: string | null
): Promise<{ ok: boolean; status?: number; message: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey ?? 'claude-fleet',
        authorization: `Bearer ${apiKey ?? 'claude-fleet'}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10_000)
    });
    if (res.ok) return { ok: true, status: res.status, message: 'Endpoint speaks the Anthropic Messages API.' };
    const body = (await res.text()).slice(0, 300);
    return {
      ok: false,
      status: res.status,
      message:
        `HTTP ${res.status} from ${url} — this endpoint does not appear to speak the Anthropic Messages API. ` +
        `If it is OpenAI-format only, front it with a gateway (e.g. LiteLLM) and register the gateway URL. ` +
        `See docs/local-models.md. Response: ${body}`
    };
  } catch (err) {
    return { ok: false, message: `Endpoint unreachable: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/endpoints.ts src/main/endpoints.test.ts
git commit -m "feat(#250): probeEndpoint — save-time Anthropic-format check (no count_tokens)"
```

---

### Task 3: `AuthMode 'endpoint'` + manifest `endpointId` (CRITICAL coercion fix)

**Files:**
- Modify: `src/main/workspaces.ts` (type at line ~32, `WorkspaceSpec` at ~138-164, `readWorkspaceManifest` at ~218-261)
- Modify: `src/main/docker.ts` (`CreateWorkspaceInput` interface, lines ~114-149)
- Modify: `src/main/ipc.ts` (`WorkspaceCreatePayload` ~185-200, `workspace:create` handler ~711-795, `workspace:writeManifest` ~910-939)
- Test: `src/main/workspaces.test.ts` (create if absent — check first with `ls src/main/workspaces*.test.ts`; if a manifest round-trip test file exists, extend it)
- Modify: `docs/SPEC.md` (data-model section: workspace manifest fields — add `authMode: 'endpoint'` + `endpointId`)

**Interfaces:**
- Produces: `AuthMode = 'oauth' | 'apikey' | 'endpoint'`; `WorkspaceSpec.endpointId?: string`; `CreateWorkspaceInput.endpointId?: string`; payload plumbed end to end.
- **THE CRITICAL LINE:** `src/main/workspaces.ts:240` currently reads
  `authMode: parsed.authMode === 'apikey' ? 'apikey' : 'oauth',`
  — this silently coerces `'endpoint'` back to `'oauth'` on manifest read, which would re-attach the shared Anthropic OAuth credentials bind to an endpoint workspace. This task exists chiefly to fix that.

- [ ] **Step 1: Write the failing test**

Check for an existing manifest test: `ls src/main/workspaces*.test.ts`. Add to it (or create `src/main/workspaces.test.ts` following the setup style of the nearest existing main-process test that touches disk — e.g. `src/main/config.test.ts` — for how `app.getPath('userData')` is stubbed in this repo's vitest env):

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NOTE to implementer: mirror config.test.ts's electron/userData stubbing.
// The assertions below are the contract; the harness lines may need that style.
import { readWorkspaceManifest, writeWorkspaceManifest, type WorkspaceSpec } from './workspaces.js';

it('round-trips authMode endpoint + endpointId through the manifest (no oauth coercion)', async () => {
  const spec = {
    id: '01ENDPOINTTEST0000000000WS',
    name: 'ep-test',
    labels: [],
    workspaceRoot: tmpdir(),
    workspaceSubdir: '',
    kind: 'container',
    authMode: 'endpoint',
    endpointId: 'ep-uuid-1',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1, lastUsedAt: 1
  } as unknown as WorkspaceSpec;
  await writeWorkspaceManifest(spec);
  const back = await readWorkspaceManifest(spec.id);
  expect(back?.authMode).toBe('endpoint');   // NOT 'oauth'
  expect(back?.endpointId).toBe('ep-uuid-1');
});

it('still coerces garbage authMode to oauth', async () => {
  // write a manifest with authMode 'bogus' via writeFileSync to the manifest path,
  // read it back, expect 'oauth'
});
```

(Implementer: fill the second test's body concretely using `workspaceManifestPath(id)` from `./paths.js` to locate the file — write `{...validManifestFields, authMode: 'bogus'}` with `writeFileSync`, then assert `readWorkspaceManifest(id)?.authMode === 'oauth'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/workspaces.test.ts`
Expected: FAIL — `back?.authMode` is `'oauth'`, not `'endpoint'`.

- [ ] **Step 3: Implement the type + read/write changes**

In `src/main/workspaces.ts`:

```typescript
export type AuthMode = 'oauth' | 'apikey' | 'endpoint';
```

In `WorkspaceSpec` (next to `authMode`):

```typescript
  authMode: AuthMode;
  /** authMode 'endpoint' only: id into the app-level model-endpoint registry
   *  (<userData>/endpoints.json). A REFERENCE — resolved live at container
   *  create / local spawn, so registry edits apply on next start (#250). */
  endpointId?: string;
```

In `readWorkspaceManifest`, replace the authMode coercion line and add endpointId:

```typescript
      authMode:
        parsed.authMode === 'apikey' ? 'apikey'
        : parsed.authMode === 'endpoint' ? 'endpoint'
        : 'oauth',
      endpointId: typeof parsed.endpointId === 'string' && parsed.endpointId ? parsed.endpointId : undefined,
```

In `src/main/docker.ts`, add to `CreateWorkspaceInput` (same doc comment as the manifest field):

```typescript
  endpointId?: string;
```

In `src/main/ipc.ts`:
- Add `endpointId?: string;` to `WorkspaceCreatePayload`.
- In the `workspace:create` handler, pass `endpointId: input.endpointId` in the object given to `backendForKind(kind).createWorkspace({...})` AND set `endpointId: input.endpointId` on the `spec: WorkspaceSpec` object written via `writeWorkspaceManifest`.
- `workspace:writeManifest` takes a full spec and merges over existing — verify `endpointId` survives the merge (it spreads the incoming spec; if the handler builds an explicit field list, add `endpointId` to it).
- Validation guard in `workspace:create`, right after the `kind === 'local'` block:

```typescript
      if (input.authMode === 'endpoint' && !input.endpointId) {
        throw new Error('Pick a model endpoint for this workspace.');
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/workspaces.test.ts` → PASS. Then `npm run typecheck` → clean (this flushes out every switch on AuthMode that needs the new arm; fix any the compiler finds — expected: none besides the files above, since existing code only compares `=== 'oauth'` / `=== 'apikey'`).

- [ ] **Step 5: Update SPEC.md data model + commit**

In `docs/SPEC.md`, find the workspace-manifest data-model section and add the `'endpoint'` authMode value and the `endpointId` field (one sentence each, edit in place per the spec-maintenance rule).

```bash
git add src/main/workspaces.ts src/main/workspaces.test.ts src/main/docker.ts src/main/ipc.ts docs/SPEC.md
git commit -m "feat(#250): AuthMode 'endpoint' + manifest endpointId — fixes silent oauth coercion on read"
```

---

### Task 4: Backend env injection in both runtimes

**Files:**
- Modify: `src/main/docker.ts` (env assembly, lines ~464-470)
- Modify: `src/main/local.ts` (`buildEnv`, lines ~100-110, and its call site ~229)
- Test: `src/main/endpoints.test.ts` (append an integration-shaped unit test for precedence)
- Modify: `docs/SPEC.md` (env-var contract with the runner container)

**Interfaces:**
- Consumes: `endpointEnv(endpointId)` from Task 1.
- Precedence contract (Global Constraints): endpoint env spread FIRST, workspace `resolveEnv` result SECOND.

- [ ] **Step 1: Write the failing test (precedence via the pure pieces)**

Append to `src/main/endpoints.test.ts`:

```typescript
describe('backend env precedence', () => {
  it('workspace env overrides compiled endpoint env when spread second', () => {
    const endpointVars = compileEndpointEnv(ep, null);
    const workspaceEnv = { CF_SUMMARY_MODEL: 'haiku', MY_VAR: '1' }; // user override
    const merged = { ...endpointVars, ...workspaceEnv };
    expect(merged.CF_SUMMARY_MODEL).toBe('haiku');          // user wins
    expect(merged.ANTHROPIC_BASE_URL).toBe(ep.baseUrl);     // endpoint fills the rest
    expect(merged.MY_VAR).toBe('1');
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/main/endpoints.test.ts` — this passes immediately (it pins the contract, the real change is the two call sites). Fine; proceed.

- [ ] **Step 3: Wire `docker.ts`**

At the top: `import { endpointEnv } from './endpoints.js';`

Replace (docker.ts ~line 467):

```typescript
  const resolvedEnv = await resolveEnv(spec.id, spec.env.plain, spec.env.secretKeys);
  const envArr = ['HOME=/home/fleet', ...Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`)];
```

with:

```typescript
  // authMode 'endpoint': compile the registry entry to claude-code's env
  // contract (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/…, #250). Spread FIRST so
  // explicit workspace env still overrides it. Resolved live — registry
  // edits/key rotation apply on next create.
  const backendVars = spec.authMode === 'endpoint' ? await endpointEnv(spec.endpointId) : {};
  const resolvedEnv = { ...backendVars, ...(await resolveEnv(spec.id, spec.env.plain, spec.env.secretKeys)) };
  const envArr = ['HOME=/home/fleet', ...Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`)];
```

Note: the OAuth credentials bind at ~line 534 is already gated `if (spec.authMode === 'oauth')` — `'endpoint'` skips it with NO change. Add one comment line there: `// 'apikey' and 'endpoint' modes get no Anthropic credential file — env only (#250).`

- [ ] **Step 4: Wire `local.ts`**

`buildEnv` currently receives `(id, ws: { env: Workspace['env'] })` and is called with the full manifest `m`. Widen the pick and merge:

```typescript
import { endpointEnv } from './endpoints.js';

async function buildEnv(
  id: string,
  ws: { env: Workspace['env']; authMode?: Workspace['authMode']; endpointId?: string }
): Promise<NodeJS.ProcessEnv> {
  const backendVars = ws.authMode === 'endpoint' ? await endpointEnv(ws.endpointId) : {};
  const resolved = await resolveEnv(id, ws.env.plain, ws.env.secretKeys);
  return {
    ...process.env,
    ...backendVars,
    ...resolved,
    TERM: 'xterm-256color'
  };
}
```

(The call site already passes the full manifest `m`, which now carries `authMode`/`endpointId` — verify, don't assume: `grep -n 'buildEnv(' src/main/local.ts`.)

- [ ] **Step 5: Typecheck, full unit suite, SPEC, commit**

```bash
npm run typecheck && npm run test:unit
```
Expected: clean. Update `docs/SPEC.md`'s runner env-contract section: endpoint workspaces receive `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CF_SUMMARY_MODEL`, compiled live from the registry, workspace env taking precedence; no OAuth credentials bind.

```bash
git add src/main/docker.ts src/main/local.ts src/main/endpoints.test.ts docs/SPEC.md
git commit -m "feat(#250): compile endpoint backend env into container and local spawn env"
```

---

### Task 5: IPC surface + preload (`endpoints:*`)

**Files:**
- Modify: `src/main/ipc.ts` (register handlers near the `config:*` block, ~line 1117)
- Modify: `src/preload/index.ts` (add `endpoints` domain next to `vault`, ~line 428)
- Modify: `docs/SPEC.md` (IPC channel table)
- Test: typecheck only (handlers are one-liners over Task 1/2 functions, which carry the unit tests)

**Interfaces:**
- Produces (renderer relies on): `window.api.endpoints.list(): Promise<ModelEndpoint[]>`, `.save(input): Promise<ModelEndpoint>`, `.delete(id): Promise<void>`, `.setApiKey(id, value: string | null): Promise<void>`, `.probe(baseUrl, modelId, apiKey?: string | null): Promise<{ ok: boolean; status?: number; message: string }>`.

- [ ] **Step 1: Register IPC handlers in `src/main/ipc.ts`**

Import: `import { listEndpoints, saveEndpoint, deleteEndpoint, setEndpointApiKey, probeEndpoint, type ModelEndpoint } from './endpoints.js';`

Next to the `config:*` handlers:

```typescript
  // ── Model-endpoint registry (#250) ─────────────────────────────────────
  ipcMain.handle('endpoints:list', () => listEndpoints());
  ipcMain.handle('endpoints:save', (_e, input: Omit<ModelEndpoint, 'id' | 'hasApiKey'> & { id?: string }) =>
    saveEndpoint(input)
  );
  ipcMain.handle('endpoints:delete', (_e, id: string) => deleteEndpoint(id));
  ipcMain.handle('endpoints:setApiKey', (_e, id: string, value: string | null) => setEndpointApiKey(id, value));
  ipcMain.handle('endpoints:probe', (_e, baseUrl: string, modelId: string, apiKey?: string | null) =>
    probeEndpoint(baseUrl, modelId, apiKey ?? null)
  );
```

- [ ] **Step 2: Expose in `src/preload/index.ts`**

Add to the `api` object (mirror the `vault` block's style exactly, including explicit return types):

```typescript
  endpoints: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('endpoints:list'),
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('endpoints:save', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('endpoints:delete', id),
    setApiKey: (id: string, value: string | null): Promise<void> =>
      ipcRenderer.invoke('endpoints:setApiKey', id, value),
    probe: (baseUrl: string, modelId: string, apiKey?: string | null): Promise<unknown> =>
      ipcRenderer.invoke('endpoints:probe', baseUrl, modelId, apiKey ?? null)
  },
```

(If the preload file uses concrete shared types rather than `unknown` — check the `vault`/`config` blocks — follow that convention instead; there may be a `src/renderer/src/types.ts` or shared d.ts declaring `window.api`. Find it with `grep -rn 'endpoints\|vault:' src/renderer/src/env.d.ts src/preload/` and extend the same declaration the vault domain uses.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: SPEC + commit**

Add the five `endpoints:*` channels to SPEC.md's IPC table, and a data-model line: endpoint registry persists at `<userData>/endpoints.json`, API keys in the vault under scope `endpoint:<id>`, key `ANTHROPIC_AUTH_TOKEN`.

```bash
git add src/main/ipc.ts src/preload/index.ts docs/SPEC.md
git commit -m "feat(#250): endpoints:* IPC surface + preload api.endpoints"
```

---

### Task 6: `get_config` reports the workspace's backend

**Files:**
- Modify: `src/main/config.ts` (`resolveWorkspaceConfig`, line ~249)
- Modify: `src/main/ipc.ts` (the `setConfigResolver` callback, line ~1045)
- Modify: `src/main/mcpServer.ts` (get_config `description`, line ~1328)
- Test: `src/main/config.test.ts` (extend existing `resolveWorkspaceConfig` tests)
- Modify: `docs/SPEC.md` (fleet-state MCP section, get_config payload)

**Interfaces:**
- `resolveWorkspaceConfig` gains a 5th parameter:
  `backend?: { mode: 'oauth' | 'apikey' | 'endpoint'; endpoint: { name: string; baseUrl: string; modelId: string } | null }`
  and returns it as a `backend` field (defaulting to `{ mode: 'oauth', endpoint: null }` when omitted — never the token).

- [ ] **Step 1: Write the failing test**

Open `src/main/config.test.ts`, find the existing `resolveWorkspaceConfig` describe block, and add:

```typescript
it('reports the backend, never a token', () => {
  const cfg = resolveWorkspaceConfig('ws1', {}, '0.9.0', undefined, {
    mode: 'endpoint',
    endpoint: { name: 'org-vllm', baseUrl: 'http://10.0.0.5:8000', modelId: 'qwen3-32b' }
  });
  expect(cfg.backend).toEqual({
    mode: 'endpoint',
    endpoint: { name: 'org-vllm', baseUrl: 'http://10.0.0.5:8000', modelId: 'qwen3-32b' }
  });
  expect(JSON.stringify(cfg)).not.toContain('AUTH_TOKEN');
});

it('defaults backend to oauth with no endpoint', () => {
  const cfg = resolveWorkspaceConfig('ws1', {}, '0.9.0');
  expect(cfg.backend).toEqual({ mode: 'oauth', endpoint: null });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/config.test.ts` → FAIL (extra argument / missing `backend`).

- [ ] **Step 3: Implement**

`resolveWorkspaceConfig` signature and return (keep every existing field untouched):

```typescript
export function resolveWorkspaceConfig(
  workspaceId: string,
  env: Record<string, string>,
  appVersion: string,
  image?: string,
  backend?: { mode: 'oauth' | 'apikey' | 'endpoint'; endpoint: { name: string; baseUrl: string; modelId: string } | null }
): { /* existing fields */; backend: { mode: 'oauth' | 'apikey' | 'endpoint'; endpoint: { name: string; baseUrl: string; modelId: string } | null } } {
  // ...existing body, plus in the returned object:
  backend: backend ?? { mode: 'oauth', endpoint: null },
```

In `ipc.ts`'s `setConfigResolver` callback (import `getEndpoint` from `./endpoints.js`):

```typescript
  setConfigResolver(async (callerId) => {
    const m = await readWorkspaceManifest(callerId);
    const ep = m?.authMode === 'endpoint' && m.endpointId ? await getEndpoint(m.endpointId) : null;
    return resolveWorkspaceConfig(callerId, m?.env?.plain ?? {}, appVersionString(), m?.image, {
      mode: m?.authMode ?? 'oauth',
      endpoint: ep ? { name: ep.name, baseUrl: ep.baseUrl, modelId: ep.modelId } : null
    });
  });
```

In `mcpServer.ts`, extend the get_config `description` with: `Also reports backend — the model backend this workspace was created with ({ mode: oauth|apikey|endpoint, endpoint: { name, baseUrl, modelId } | null }; never a token).`

- [ ] **Step 4: Run tests** — `npx vitest run src/main/config.test.ts src/main/mcpServer.test.ts` → PASS (the MCP contract unit test pins tool names, not descriptions; if it pins the description, update it — memory note `mcp-contract-tests` says both unit and e2e pin the surface).

- [ ] **Step 5: SPEC + commit**

SPEC.md fleet-state MCP section: get_config payload gains `backend`.

```bash
git add src/main/config.ts src/main/config.test.ts src/main/ipc.ts src/main/mcpServer.ts docs/SPEC.md
git commit -m "feat(#250): get_config reports the workspace backend (mode + endpoint, no token)"
```

---### Task 7: Settings → Model Endpoints panel

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx`
- Verify manually via `CLAUDE_FLEET_MOCK=1 npm run dev` only if a display is available; otherwise typecheck + the Task 11 e2e covers the wiring.

**Interfaces:**
- Consumes: `window.api.endpoints.*` (Task 5).

- [ ] **Step 1: Implement the panel**

Add a new section to `SettingsModal.tsx` following the visual pattern of the existing sections (fleet root / budget). Behavior spec:

- On mount (or section open), `window.api.endpoints.list()` → local state `endpoints`.
- List each endpoint: `name`, `baseUrl`, `modelId`, a `key set` / `no key` chip (from `hasApiKey`), Edit and Delete buttons.
- "Add endpoint" opens an inline form (same modal): inputs `name`*, `baseUrl`* (placeholder `http://host.docker.internal:11434`), `modelId`* (placeholder `qwen3:4b`), `smallFastModelId` (optional), `contextLength` (optional number), `notes` (optional), `apiKey` (optional password input, placeholder `(none — local endpoints usually need no key)`).
- **Test connection** button: calls `window.api.endpoints.probe(baseUrl, modelId, apiKey || null)` with the *form's current values* (works before save); renders `result.message` in green (`ok`) or red (`!ok`).
- Save: `window.api.endpoints.save({...fields})`, then if the apiKey input is non-empty `window.api.endpoints.setApiKey(saved.id, apiKey)`; refresh list; clear form.
- Edit: prefills the form (apiKey input stays empty — placeholder `••••• (unchanged)` when `hasApiKey`).
- Delete: `window.api.endpoints.delete(id)` after a `confirm()` naming the endpoint; refresh.
- Empty state line: `No model endpoints yet. Register an Anthropic-format (/v1/messages) URL — see docs/local-models.md for Ollama/vLLM/LiteLLM recipes.`

- [ ] **Step 2: Typecheck** — `npm run typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(#250): Model Endpoints settings panel — CRUD + probe"
```

---

### Task 8: Backend picker in the workspace form

**Files:**
- Modify: `src/renderer/src/components/WorkspaceForm.tsx` (auth radios ~639-672, `WorkspaceFormSubmit` ~27-55, state ~150, submit build ~363)
- Modify: `src/renderer/src/App.tsx` (both `window.api.workspace.create({...})` call sites, ~864 and ~942 — add `endpointId`)
- Modify: `src/renderer/src/components/EditWorkspaceModal.tsx` (`containerLevelChanged`, ~130-155)

**Interfaces:**
- `WorkspaceFormSubmit` gains `endpointId?: string`.
- The third radio's semantics: selecting it requires an endpoint chosen from the registry dropdown.

- [ ] **Step 1: Implement the form changes**

In `WorkspaceForm.tsx`:

1. State: `const [endpointId, setEndpointId] = useState<string | undefined>(initial?.endpointId);` and `const [endpoints, setEndpoints] = useState<Array<{ id: string; name: string; modelId: string; baseUrl: string }>>([]);` — fetch once in the existing on-mount `useEffect` (alongside `images.list()`): `window.api.endpoints.list().then(setEndpoints)`.
2. Add `endpointId?: string;` to `WorkspaceFormSubmit` (doc comment: `authMode 'endpoint' only — registry reference`).
3. Third radio in the `kind-radios` group, after "API key" (mirror its disabled pattern):

```tsx
          <label
            className={`kind-radio ${authMode === 'endpoint' ? 'active' : ''} ${endpoints.length ? '' : 'disabled'}`}
            title={endpoints.length ? '' : 'Add a model endpoint in Settings to enable'}
          >
            <input
              type="radio"
              name="auth-mode"
              value="endpoint"
              checked={authMode === 'endpoint'}
              onChange={() => setAuthMode('endpoint')}
              disabled={busy || endpoints.length === 0}
            />
            <span>Endpoint {endpoints.length === 0 && '🔒'}</span>
            <span className="kind-help">
              {endpoints.length ? 'non-Claude model via registry' : 'register one in Settings'}
            </span>
          </label>
```

4. Directly below the radio row, render the picker only when `authMode === 'endpoint'`:

```tsx
      {authMode === 'endpoint' && (
        <div className="form-row">
          <label>Model endpoint</label>
          <select
            value={endpointId ?? ''}
            onChange={(e) => setEndpointId(e.target.value || undefined)}
            disabled={busy}
          >
            <option value="">— pick an endpoint —</option>
            {endpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.name} — {ep.modelId} ({ep.baseUrl})
              </option>
            ))}
          </select>
        </div>
      )}
```

5. In the submit-build path (~line 363 where `authMode` is placed into the submit object): add `endpointId: authMode === 'endpoint' ? endpointId : undefined`, and in the form's validation (wherever `nameOk`-style gating happens before submit) block submit with an error message `Pick a model endpoint.` when `authMode === 'endpoint' && !endpointId`.

In `App.tsx`: add `endpointId: values.endpointId` to BOTH `window.api.workspace.create({...})` payloads (lines ~864, ~942) and to the `workspace:writeManifest` spec object in the edit-save path (find it: `grep -n 'writeManifest' src/renderer/src/App.tsx`).

In `EditWorkspaceModal.tsx` `containerLevelChanged`, after the authMode check:

```typescript
  if ((before.endpointId ?? '') !== (after.endpointId ?? '')) return true;
```

(`WorkspaceSummary` must carry `endpointId` — it derives from the manifest spec; check its type declaration with `grep -rn 'interface WorkspaceSummary' src/renderer` and add `endpointId?: string` where it's declared. Also add `endpointId` to the `initial` prefill mapping where `EditWorkspaceModal` builds `WorkspaceForm`'s `initial` from the summary.)

- [ ] **Step 2: Typecheck** — `npm run typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/WorkspaceForm.tsx src/renderer/src/components/EditWorkspaceModal.tsx src/renderer/src/App.tsx
git commit -m "feat(#250): backend picker — Endpoint auth mode + registry dropdown in workspace form"
```

---

### Task 9: Cost display honesty for unpriced models

**Files:**
- Modify: `src/renderer/src/components/SessionsPane.tsx` and `src/renderer/src/components/ObservabilityPane.tsx` (wherever a `usd` value is rendered — find each: `grep -n 'usd' <file>`)

**Rationale (from spec §C):** tokens are real for endpoint workspaces, but `costFor` prices unknown models at $0. Rendering `$0.00` next to millions of tokens fabricates a price. Rule: **when `usd === 0` and the session/workspace has nonzero total tokens, render `—` instead of a dollar figure** (tooltip/title text: `no price table for this model (local/endpoint backend)`). A genuine all-zero session keeps rendering whatever it does today.

- [ ] **Step 1: Implement** — in both components, wrap the usd formatting in a small local helper (copy into each file, or place in an existing shared renderer util if one obviously fits — check `src/renderer/src/lib/` or where `formatTokens`-style helpers live):

```typescript
function formatUsd(usd: number, totalTokens: number): string {
  if (usd === 0 && totalTokens > 0) return '—';
  return `$${usd.toFixed(2)}`;
}
```

Match the existing decimal formatting in each component (if a pane shows `$1.2345`, keep its precision — only the zero-with-tokens case changes).

- [ ] **Step 2: Typecheck** — `npm run typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SessionsPane.tsx src/renderer/src/components/ObservabilityPane.tsx
git commit -m "feat(#250): render — instead of \$0.00 for sessions on unpriced (local) models"
```

---

### Task 10: Inference test fixture + docs

**Files:**
- Create: `docker/inference/compose.yaml`
- Create: `docs/local-models.md`
- Modify: `docs/SPEC.md` (one line in non-goals/dev-fixtures: fleet consumes endpoints, never manages inference; the compose file is a dev/test fixture only)

- [ ] **Step 1: Write `docker/inference/compose.yaml`**

```yaml
# Dev/test inference fixture (#250) — NOT a product feature. Fleet consumes
# endpoints; it never manages inference. This runs a local Ollama that fleet
# workspaces reach at http://host.docker.internal:11434 (register that URL in
# Settings → Model Endpoints).
#
#   docker compose -f docker/inference/compose.yaml up -d
#   docker compose -f docker/inference/compose.yaml exec ollama ollama pull qwen3:4b
#
# GPU (NVIDIA): docker compose -f docker/inference/compose.yaml --profile gpu up -d
services:
  ollama:
    image: ollama/ollama:latest
    ports:
      - '11434:11434'
    volumes:
      - ollama-models:/root/.ollama
    environment:
      # claude-code's FIRST request is ~35K tokens. Ollama's 4096 default
      # SILENTLY TRUNCATES it into garbage; 32K is also not enough.
      # Empirically validated 2026-07-22 — do not lower this.
      OLLAMA_CONTEXT_LENGTH: '40960'

  ollama-gpu:
    profiles: ['gpu']
    image: ollama/ollama:latest
    ports:
      - '11434:11434'
    volumes:
      - ollama-models:/root/.ollama
    environment:
      OLLAMA_CONTEXT_LENGTH: '40960'
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

volumes:
  ollama-models:
```

- [ ] **Step 2: Write `docs/local-models.md`**

Cover, in this order (content source: the design spec's "Empirically validated" section + decisions):
1. **What fleet needs from an endpoint:** Anthropic Messages API (`POST {baseUrl}/v1/messages`). `count_tokens` NOT required. One endpoint = one registry entry (Settings → Model Endpoints); workspaces pick it at create.
2. **Ollama** (v0.14+ for Anthropic compat; the fixture above): the `OLLAMA_CONTEXT_LENGTH=40960` trap in bold — claude-code's first request is ~35K tokens, the 4,096 default silently truncates, 32K is not enough; models need tool-calling support (qwen3 family works); CPU is functionally correct but slow — fine for testing the integration, use GPU or org endpoints for real work.
3. **vLLM:** serves `/v1/messages` natively; needs `--enable-auto-tool-choice --tool-call-parser <parser>`; register `http://host:8000`.
4. **OpenAI-only endpoints:** front with a LiteLLM gateway and register the gateway URL — fleet ships zero protocol translation by design. Pin LiteLLM versions (PyPI supply-chain incidents exist).
5. **What degrades:** cost shows `—` (no price table); everything else — transcripts, sessions, summaries (`CF_SUMMARY_MODEL` auto-set to the endpoint model), committee — works identically.
6. **Optional:** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` as a workspace env var populates claude's `/model` picker from a gateway's `/v1/models`.

- [ ] **Step 3: Commit**

```bash
git add docker/inference/compose.yaml docs/local-models.md docs/SPEC.md
git commit -m "docs(#250): local-model recipes + Ollama compose test fixture (40960 ctx floor)"
```

---

### Task 11: End-to-end proof (local runtime, env-printing stub)

**Files:**
- Create: `tests/fixtures/claude-env-stub.js`
- Create: `tests/endpoint-workspace.spec.ts`

**Pattern to copy:** `tests/local-backend.spec.ts` (seeded manifest in a temp `userDataDir`, `CLAUDE_FLEET_LOCAL_CLAUDE_BIN=<process.execPath>` + `CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS=<stub path>`, launch via `_electron`, open the Saved tab, Resume, assert on the terminal). This proves the FULL chain — endpoints.json → manifest authMode/endpointId → `buildEnv` merge → real PTY spawn — with no Docker and no model.

- [ ] **Step 1: Write the stub**

```javascript
#!/usr/bin/env node
// Env-printing claude stub (#250): prints the backend env vars an endpoint
// workspace should have injected, then stays alive like claude would.
'use strict';
const keys = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CF_SUMMARY_MODEL'
];
for (const k of keys) process.stdout.write(`${k}=${process.env[k] ?? '<unset>'}\r\n`);
process.stdout.write('env-stub: ready\r\n');
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
```

- [ ] **Step 2: Write the spec**

Structure copied from `tests/local-backend.spec.ts` with three deltas — seed `endpoints.json` in the temp `userDataDir`, seed the manifest with `authMode: 'endpoint'` + `endpointId`, and assert the terminal output:

```typescript
// Endpoint workspaces (#250): a local workspace with authMode 'endpoint'
// spawns claude with the registry-compiled backend env. Uses an env-printing
// stub so the assertion reads the REAL spawned process's environment.
import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

test('endpoint workspace: compiled backend env reaches the spawned claude (#250)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-endpoint-'));
  const id = '01ENDPOINTTESTWS000000000W';
  const epId = 'ep-e2e-1';

  writeFileSync(
    path.join(userDataDir, 'endpoints.json'),
    JSON.stringify([
      {
        id: epId,
        name: 'e2e-fake',
        baseUrl: 'http://127.0.0.1:59999',
        modelId: 'qwen3:4b',
        hasApiKey: false
      }
    ])
  );

  const stateDir = path.join(userDataDir, 'state', id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name: 'endpoint-e2e',
      labels: [],
      workspaceRoot: tmpdir(),
      workspaceSubdir: '',
      kind: 'local',
      authMode: 'endpoint',
      endpointId: epId,
      env: { plain: { CF_SUMMARY_MODEL: 'user-override' }, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'claude-env-stub.js');
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_FLEET_LOCAL_CLAUDE_BIN: process.execPath,
      CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS: stubPath
    } as Record<string, string>
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Open the Saved tab and resume the seeded workspace — copy the exact
    // locator sequence from tests/local-backend.spec.ts (Add workspace →
    // Saved tab → row 'endpoint-e2e' → Resume) including its waits.
    // …
    const term = window.locator('.xterm');   // same terminal locator local-backend.spec.ts uses
    await expect(term).toContainText('ANTHROPIC_BASE_URL=http://127.0.0.1:59999', { timeout: 20_000 });
    await expect(term).toContainText('ANTHROPIC_MODEL=qwen3:4b');
    await expect(term).toContainText('ANTHROPIC_AUTH_TOKEN=claude-fleet');   // placeholder, no key stored
    await expect(term).toContainText('CF_SUMMARY_MODEL=user-override');      // workspace env beats endpoint env
  } finally {
    await app.close();
  }
});
```

(Implementer: the `// …` is the ONLY intentionally-elided block — lift the resume-flow locators verbatim from `tests/local-backend.spec.ts` lines ~66-90, including the terminal locator it really uses; adjust `.xterm` to match.)

- [ ] **Step 3: Run it**

Requires a display (WSLg is available in this container's host setup — if `npx playwright test tests/endpoint-workspace.spec.ts` fails on display/deps, note it and rely on CI; do NOT mark the task complete on a display failure without saying so).

Run: `npm run build && npx playwright test tests/endpoint-workspace.spec.ts`
Expected: PASS — all four `toContainText` assertions.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/claude-env-stub.js tests/endpoint-workspace.spec.ts
git commit -m "test(#250): e2e — endpoint workspace env compilation through a real local spawn"
```

---

### Task 12: Full gate + spec closeout

**Files:**
- Modify: `docs/SPEC.md` (final self-check), `docs/superpowers/specs/2026-07-23-model-endpoint-workspaces-design.md` (status line only)

- [ ] **Step 1: Run the full gate**

```bash
npm run typecheck && npm run test:unit && npm test
```
Expected: all green (`npm test` = unit → build → playwright; e2e needs the display caveat from Task 11).

- [ ] **Step 2: SPEC self-check** — walk SPEC.md's checklist (stack/architecture/data model/user flows/security model/non-goals): the endpoint registry, `endpoints:*` IPC, `'endpoint'` authMode + no-creds-bind, env contract, get_config backend, and the "fleet never manages inference" non-goal must all be present. Fix any gap in place.

- [ ] **Step 3: Update the design spec's status line** to `**Status:** implemented (this branch)` and commit:

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-07-23-model-endpoint-workspaces-design.md
git commit -m "docs(#250): SPEC closeout for model-endpoint workspaces"
```

- [ ] **Step 4: Push and open the PR** (use the finishing-a-development-branch skill; PR title `feat: model-endpoint workspaces — run non-Claude models behind claude-code (#250)`).
