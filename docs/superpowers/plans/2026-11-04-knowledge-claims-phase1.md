# Knowledge Claims Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents across the fleet can record and search durable knowledge claims. The app captures claims in the background from every interactive session by running headless forks of it.

**Architecture:**
- **Storage.** Claims live in `inbox.db` (schema v6), behind a Kysely `ClaimStore` and `CaptureRunStore`.
- **Logic.** A `ClaimService` holds validation, the secret filter, near-duplicate merging, supersede/retract, and hybrid FTS5 + vector search ranked by reciprocal rank fusion.
- **MCP.** The fleet-state server exposes the service through setter-injected handlers (the `setInboxHandlers` pattern), and adds an `instructions` string containing the standing rule.
- **Capture.** A `CaptureScheduler` listens to JSONL ingest. It computes context fill and turn counts from `state.db`, applies a pure trigger policy, and runs `claude -p --resume <id> --fork-session --session-id <fork> …` through a per-backend executor (container `execScript`, native host spawn, WSL `wsl.exe --exec`), with a concurrency cap and timeout.

**Tech Stack:** TypeScript (Electron main), better-sqlite3 + Kysely, SQLite FTS5, existing bge-small embedder (`EmbedFn`), vitest, Playwright (CI-only e2e), React renderer.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-04-knowledge-claims-design.md` (PR #482, issue #483).
- Claim text ≤ 600 chars. Kinds: exactly `decision | fact | gotcha | root-cause | rejected`. Topics: 1–3, each matching `^[a-z0-9-]{2,40}$`. Visibility: `fleet` (default) or `private`.
- Near-duplicate threshold: cosine ≥ **0.92**, same `kind`.
- Capture triggers: context fill **0.60** and **0.85** of the model window, plus every **30** user turns. At least **10 min** between captures of one session, at most **2** concurrent app-wide, queued triggers dropped after **15 min**, fork wall-clock timeout **5 min**, `--max-turns 12`.
- The fork's tools are restricted to exactly `mcp__claude-fleet-state__record_claim,mcp__claude-fleet-state__search_claims`.
- Background capture is **on by default**: per-workspace `knowledgeCapture` manifest flag (absent = on) plus a global `knowledgeCapture` config flag (absent = on).
- Provenance is host-stamped. The workspace id comes only from MCP `ctx.callerId`; the session only from a validated `capture_run` token.
- No synchronous `inbox.db` access on the main thread: claims go through the async Kysely handle (`InboxStore.kysely`). Inside a Kysely transaction callback, query only through `trx`.
- Every IPC, data-model or security change updates `docs/SPEC.md` in the same commit (`.claude/rules/spec-maintenance.md`).
- Test env (worktree-local): `npm ci --ignore-scripts --no-audit --no-fund`, then `printf 'electron-stub' > node_modules/electron/path.txt`. Run `npm run typecheck:node` **and** `npm run typecheck:web` separately; never rely on `npm run typecheck`, which short-circuits.
- Never call the `claude-fleet-state` MCP `query` tool while developing (#476).

## File Structure

| File | Responsibility |
|---|---|
| `src/main/inbox/inboxDb.ts` (modify) | v6 migration SQL; bump `INBOX_SCHEMA_VERSION` to 6 |
| `src/main/store/inboxSchema.ts` (modify) | Kysely types for `claims`, `claim_sources`, `claim_vectors`, `capture_runs` |
| `src/main/claims/types.ts` | Shared claim types and constants |
| `src/main/claims/claimValidate.ts` | Pure input validation + secret scanner |
| `src/main/claims/claimRank.ts` | Pure FTS query builder, RRF fusion, topic suggestion |
| `src/main/claims/claimStore.ts` | Kysely persistence for claims, sources, vectors, FTS |
| `src/main/claims/captureRunStore.ts` | Kysely persistence for capture runs |
| `src/main/claims/claimService.ts` | `record` / `search` / `retract` business logic |
| `src/main/claims/capturePolicy.ts` | Pure trigger decision |
| `src/main/claims/captureCommand.ts` | Pure fork command / prompt / output parsing |
| `src/main/claims/captureExec.ts` | Per-backend executors (container, native, WSL) |
| `src/main/claims/captureScheduler.ts` | Ingest-driven scheduling, queue, concurrency, run bookkeeping |
| `src/main/claims/captureForks.ts` | In-memory registry of capture-fork session ids (for the Sessions rail) |
| `src/main/db.ts` (modify) | `sessionCaptureSignals(sessionId)`, `isAutomationSession(sessionId)` |
| `src/main/mcpServer.ts` (modify) | 3 tools, `setClaimHandlers`, `instructions`, search_transcripts copy |
| `src/main/index.ts` (modify) | Wiring |
| `src/main/workspaces.ts`, `src/main/config.ts`, `src/main/ipc.ts`, `src/preload/index.ts` (modify) | Switches + `capture` flag on sessions |
| `src/renderer/src/sessionsView.ts`, `components/SessionsPane.tsx`, `components/WorkspaceForm.tsx`, `components/SettingsModal.tsx`, `workspaceLifecycle.ts` (modify) | UI |
| `docs/SPEC.md` (modify) | Tools, data model, security exception, capture |

---

### Task 1: Feasibility gate (manual; no code merged)

**Purpose:** confirm that the fork mechanism the rest of the plan depends on works on the pinned Claude Code (2.1.281). **If any check fails, stop and report to Troy before Task 9.** Tasks 2–8 don't depend on it and may proceed.

**Files:**
- Create: `docs/superpowers/plans/2026-11-04-knowledge-claims-gate-results.md` (findings)

- [ ] **Step 1: Pick a live container workspace session.** In the app, start a session in a test container workspace and get it working on a long task (e.g. "read every file under src/main and summarize each"). Find its claude session id: `ls -t ~/.claude/projects/*/ | head` inside the container (via the app's terminal on a second tab).

- [ ] **Step 2: Fork it mid-turn, with a pre-assigned id and restricted tools.** In a second tab of the same workspace (same cwd):

```bash
FORK=$(cat /proc/sys/kernel/random/uuid)
claude -p "List three facts you learned in this conversation. Then call search_claims with query 'test'." \
  --resume <LIVE_SESSION_ID> --fork-session --session-id "$FORK" \
  --allowedTools mcp__claude-fleet-state__search_claims \
  --max-turns 4 --output-format json > /tmp/fork.json; echo "exit=$?"
jq '{session_id, num_turns, total_cost_usd, usage}' /tmp/fork.json
ls ~/.claude/projects/*/"$FORK".jsonl
```

Expected:
- `exit=0`
- `session_id` equals `$FORK`
- a `$FORK.jsonl` transcript exists
- `search_claims` shows as an unknown tool (fine before Task 6) or is called; it is not a permission denial

- [ ] **Step 3: Verify the live session is unharmed.** Let the live turn finish. Then:
  - (a) its transcript still parses: `jq -c . ~/.claude/projects/*/<LIVE_SESSION_ID>.jsonl > /dev/null && echo ok`;
  - (b) it contains no lines carrying the fork's session id: `grep -c "$FORK" …/<LIVE_SESSION_ID>.jsonl` → `0`;
  - (c) the tab still accepts input;
  - (d) after `/exit`, `claude --resume <LIVE_SESSION_ID>` reopens it.

- [ ] **Step 4: Repeat Step 2 five times while the live session is busy.** Re-check Step 3. Record cost per fork: `usage.cache_read_input_tokens` should dominate `input_tokens`, which confirms the prompt-cache hit.

- [ ] **Step 5: Repeat Steps 2–3 for a native local workspace and a WSL workspace on the Windows host.** For native local, also pass `--mcp-config <path>`, the path the app writes for that workspace (`ensureMcpConfig`; the workspace's existing session command line shows it in Task Manager).

- [ ] **Step 6: Record results and commit.** Write the outcomes (pass/fail per check, cost numbers, any surprises) to the gate-results file:

```bash
git add docs/superpowers/plans/2026-11-04-knowledge-claims-gate-results.md
git commit -m "docs(plan): knowledge-claims fork feasibility gate results (#483)"
```

---

### Task 2: inbox.db v6 schema

**Files:**
- Modify: `src/main/inbox/inboxDb.ts:15` (version) and the `MIGRATIONS` map (after key `5`, ~line 183)
- Modify: `src/main/store/inboxSchema.ts` (header comment + new interfaces + `InboxDb`)
- Modify: `src/main/inbox/inboxDb.test.ts:164`
- Test: `src/main/inbox/inboxDb.test.ts`

**Interfaces:**
- Produces: tables `claims`, `claim_sources`, `claim_vectors`, `claims_fts` (FTS5), `capture_runs`; Kysely types `ClaimsTable`, `ClaimSourcesTable`, `ClaimVectorsTable`, `CaptureRunsTable`; rows `ClaimRow`, `ClaimSourceRow`, `CaptureRunRow`.

- [ ] **Step 1: Write the failing test.** Change the pinned version and add a v6 shape test in `src/main/inbox/inboxDb.test.ts`:

```ts
// line 164
expect(INBOX_SCHEMA_VERSION).toBe(6);
```

```ts
it('v6 creates the claims tables and an FTS5 index', () => {
  const store = InboxStore.memory();
  const raw = (store as unknown as { raw: import('better-sqlite3').Database }).raw;
  const names = (raw.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  expect(names).toEqual(expect.arrayContaining(['claims', 'claim_sources', 'claim_vectors', 'claims_fts', 'capture_runs']));
  raw.prepare(`INSERT INTO claims_fts (claim_id, text, topics) VALUES ('c1', 'query snapshot froze the app', 'mcp-query')`).run();
  const hit = raw.prepare(`SELECT claim_id FROM claims_fts WHERE claims_fts MATCH '"snapshot"'`).get() as { claim_id: string };
  expect(hit.claim_id).toBe('c1');
  store.close();
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npx vitest run src/main/inbox/inboxDb.test.ts`
Expected: FAIL (version is 5; `claims` missing).

- [ ] **Step 3: Add the migration.** In `src/main/inbox/inboxDb.ts`, set `export const INBOX_SCHEMA_VERSION = 6;` and add to `MIGRATIONS` after key `5`:

```ts
  // #483: knowledge claims (phase 1) + background capture runs.
  6: `
    CREATE TABLE claims (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, topics TEXT NOT NULL,
      refs TEXT, visibility TEXT NOT NULL DEFAULT 'fleet', status TEXT NOT NULL DEFAULT 'current',
      superseded_by TEXT, retract_reason TEXT, workspace_id TEXT NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claims_status_vis ON claims (status, visibility, workspace_id);
    CREATE TABLE claim_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      session_id TEXT, via TEXT NOT NULL, capture_run TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_sources_claim ON claim_sources (claim_id);
    CREATE TABLE claim_vectors (claim_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, vec BLOB NOT NULL);
    CREATE VIRTUAL TABLE claims_fts USING fts5(claim_id UNINDEXED, text, topics);
    CREATE TABLE capture_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, fork_session_id TEXT,
      trigger TEXT NOT NULL, status TEXT NOT NULL, claims_recorded INTEGER NOT NULL DEFAULT 0,
      usage TEXT, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX idx_capture_runs_session ON capture_runs (session_id, started_at);
    CREATE INDEX idx_capture_runs_status ON capture_runs (status);
  `
```

(The spec sketched `claims_fts` as an external-content table. A standalone FTS5 table with an `UNINDEXED claim_id` column avoids sync triggers, and claim text never changes after insert.)

- [ ] **Step 4: Add the Kysely types.** In `src/main/store/inboxSchema.ts`, change the header to `Mirrors MIGRATIONS 1–6` and add:

```ts
export interface ClaimsTable {
  id: string; text: string; kind: string; topics: string; refs: string | null;
  visibility: Generated<string>; status: Generated<string>; superseded_by: string | null; retract_reason: string | null;
  workspace_id: string; confirmations: Generated<number>; created_at: number; updated_at: number;
}
export interface ClaimSourcesTable {
  id: Generated<number>; claim_id: string; workspace_id: string; session_id: string | null;
  via: string; capture_run: string | null; ts: number;
}
export interface ClaimVectorsTable { claim_id: string; model_id: string; vec: Buffer }
export interface CaptureRunsTable {
  id: string; workspace_id: string; session_id: string; fork_session_id: string | null; trigger: string;
  status: string; claims_recorded: Generated<number>; usage: string | null; error: string | null;
  started_at: number; ended_at: number | null;
}
```

Add `claims: ClaimsTable; claim_sources: ClaimSourcesTable; claim_vectors: ClaimVectorsTable; capture_runs: CaptureRunsTable;` to `InboxDb`, and the row exports:

```ts
export type ClaimRow = Selectable<ClaimsTable>;
export type ClaimSourceRow = Selectable<ClaimSourcesTable>;
export type CaptureRunRow = Selectable<CaptureRunsTable>;
```

(`claims_fts` is queried with raw `sql`; it stays out of `InboxDb`.)

- [ ] **Step 5: Run the tests.**

Run: `npx vitest run src/main/inbox/`
Expected: PASS (including the existing upgrade/backup tests).

- [ ] **Step 6: Commit.**

```bash
git add src/main/inbox/inboxDb.ts src/main/store/inboxSchema.ts src/main/inbox/inboxDb.test.ts
git commit -m "feat(claims): inbox.db v6 — claims, sources, vectors, FTS5, capture_runs (#483)"
```

---

### Task 3: Claim types, validation, secret filter, ranking helpers (pure)

**Files:**
- Create: `src/main/claims/types.ts`, `src/main/claims/claimValidate.ts`, `src/main/claims/claimRank.ts`
- Test: `src/main/claims/claimValidate.test.ts`, `src/main/claims/claimRank.test.ts`

**Interfaces:**
- Produces:
  - `ClaimKind`, `CLAIM_KINDS`, `ClaimVisibility`, `ClaimStatus`, `ClaimInput`, `ClaimRecord`, `ClaimSourceInput` (types.ts)
  - `validateClaimInput(args: Record<string, unknown>): ClaimInput` (throws `Error` with a user-facing message)
  - `findSecret(text: string): string | null` (returns a pattern class name)
  - `ftsQuery(q: string): string | null`, `rrf(lists: string[][], k?: number): string[]`, `suggestTopics(neighbors: { topics: string[] }[], given: string[], max?: number): string[]`

- [ ] **Step 1: Write `types.ts`** (types only; nothing to test):

```ts
// Knowledge claims (#483): shared types for the claims store/service.
export const CLAIM_KINDS = ['decision', 'fact', 'gotcha', 'root-cause', 'rejected'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type ClaimVisibility = 'fleet' | 'private';
export type ClaimStatus = 'current' | 'superseded' | 'retracted';
export const CLAIM_TEXT_MAX = 600;
export const TOPIC_RE = /^[a-z0-9-]{2,40}$/;
export const DEDUPE_COSINE = 0.92;

export interface ClaimInput {
  text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; supersedes: string | null; captureRun: string | null;
}
export interface ClaimRecord {
  id: string; text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; status: ClaimStatus; supersededBy: string | null; retractReason: string | null;
  workspaceId: string; confirmations: number; createdAt: number; updatedAt: number;
}
export interface ClaimSourceInput {
  workspaceId: string; sessionId: string | null; via: 'agent' | 'capture'; captureRun: string | null;
}
```

- [ ] **Step 2: Write the failing tests.** `src/main/claims/claimValidate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateClaimInput, findSecret } from './claimValidate.js';

const ok = { text: 'MCP query copies the whole workspace history per call', kind: 'root-cause', topics: ['mcp-query'] };

describe('validateClaimInput', () => {
  it('normalizes a valid claim with defaults', () => {
    expect(validateClaimInput(ok)).toEqual({
      text: ok.text, kind: 'root-cause', topics: ['mcp-query'], refs: [],
      visibility: 'fleet', supersedes: null, captureRun: null
    });
  });
  it('trims text, lowercases and dedupes topics', () => {
    const r = validateClaimInput({ ...ok, text: `  ${ok.text}  `, topics: ['MCP-Query', 'mcp-query', 'state-db'] });
    expect(r.text).toBe(ok.text);
    expect(r.topics).toEqual(['mcp-query', 'state-db']);
  });
  it.each([
    [{ ...ok, text: '' }, /text/],
    [{ ...ok, text: 'x'.repeat(601) }, /600/],
    [{ ...ok, kind: 'opinion' }, /kind/],
    [{ ...ok, topics: [] }, /topics/],
    [{ ...ok, topics: ['a', 'b', 'c', 'd'] }, /topics/],
    [{ ...ok, topics: ['has space'] }, /topic/],
    [{ ...ok, visibility: 'public' }, /visibility/],
    [{ ...ok, refs: 'not-an-array' }, /refs/],
    [{ ...ok, refs: Array(11).fill('#1') }, /refs/]
  ])('rejects %j', (args, msg) => {
    expect(() => validateClaimInput(args as Record<string, unknown>)).toThrow(msg);
  });
  it('accepts supersedes, capture_run and private visibility', () => {
    const r = validateClaimInput({ ...ok, visibility: 'private', supersedes: '01ABC', capture_run: '01RUN', refs: ['#476'] });
    expect(r).toMatchObject({ visibility: 'private', supersedes: '01ABC', captureRun: '01RUN', refs: ['#476'] });
  });
});

describe('findSecret', () => {
  it.each([
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['github_pat_' + 'A'.repeat(30), 'github-token'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['sk-ant-api03-' + 'x'.repeat(40), 'anthropic-key'],
    ['sk-' + 'a'.repeat(40), 'openai-key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['postgres://user:hunter2@db.internal:5432/app', 'credential-url'],
    ['api_key=Zx8vQ2mP9rT4wY7uK1nB5cD3', 'assignment-secret']
  ])('flags %s as %s', (text, cls) => {
    expect(findSecret(`see ${text} here`)).toBe(cls);
  });
  it.each([
    'MCP query copies the whole workspace history per call (#476)',
    'postgres://db.internal:5432/app has no auth in dev',
    'set token=<redacted> in the vault, never in the manifest',
    'src/main/mcpServer.ts:buildSnapshot is O(history)'
  ])('passes %s', (text) => {
    expect(findSecret(text)).toBeNull();
  });
});
```

`src/main/claims/claimRank.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ftsQuery, rrf, suggestTopics } from './claimRank.js';

describe('ftsQuery', () => {
  it('quotes tokens and ORs them, keeping #, _ . and -', () => {
    expect(ftsQuery('why did #476 freeze buildSnapshot?')).toBe('"why" OR "did" OR "#476" OR "freeze" OR "buildSnapshot"');
  });
  it('returns null for punctuation-only input', () => {
    expect(ftsQuery('?? !!')).toBeNull();
  });
  it('strips embedded quotes', () => {
    expect(ftsQuery('a"b')).toBe('"ab"');
  });
});

describe('rrf', () => {
  it('fuses rank lists, favouring items high in both', () => {
    expect(rrf([['a', 'b', 'c'], ['b', 'c', 'd']])).toEqual(['b', 'c', 'a', 'd']);
  });
  it('handles an empty list', () => {
    expect(rrf([[], ['x']])).toEqual(['x']);
  });
});

describe('suggestTopics', () => {
  it('ranks neighbour topics by frequency, excluding given ones', () => {
    const n = [{ topics: ['state-db', 'mcp-query'] }, { topics: ['state-db'] }, { topics: ['perf'] }];
    expect(suggestTopics(n, ['mcp-query'], 2)).toEqual(['state-db', 'perf']);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail.**

Run: `npx vitest run src/main/claims/`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `claimValidate.ts`:**

```ts
// Knowledge claims (#483): input validation + secret backstop for record_claim.
import { CLAIM_KINDS, CLAIM_TEXT_MAX, TOPIC_RE, type ClaimInput, type ClaimKind } from './types.js';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function validateClaimInput(a: Record<string, unknown>): ClaimInput {
  const text = str(a.text)?.trim() ?? '';
  if (!text) throw new Error('text is required');
  if (text.length > CLAIM_TEXT_MAX) throw new Error(`text must be at most ${CLAIM_TEXT_MAX} characters — split it into separate claims`);
  const kind = str(a.kind);
  if (!kind || !(CLAIM_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${CLAIM_KINDS.join(', ')}`);
  if (!Array.isArray(a.topics)) throw new Error('topics must be an array of 1-3 slugs');
  const topics = [...new Set(a.topics.map((t) => String(t).trim().toLowerCase()))];
  if (topics.length < 1 || topics.length > 3) throw new Error('topics must be an array of 1-3 slugs');
  const badTopic = topics.find((t) => !TOPIC_RE.test(t));
  if (badTopic !== undefined) throw new Error(`topic "${badTopic}" must match ${TOPIC_RE}`);
  let refs: string[] = [];
  if (a.refs !== undefined) {
    if (!Array.isArray(a.refs) || a.refs.length > 10) throw new Error('refs must be an array of at most 10 strings');
    refs = a.refs.map((r) => String(r).slice(0, 200));
  }
  const visibility = a.visibility === undefined ? 'fleet' : a.visibility;
  if (visibility !== 'fleet' && visibility !== 'private') throw new Error('visibility must be "fleet" or "private"');
  return {
    text, kind: kind as ClaimKind, topics, refs, visibility,
    supersedes: str(a.supersedes), captureRun: str(a.capture_run)
  };
}

// Pattern classes, most specific first. A backstop, not a guarantee (spec §7).
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
  ['assignment-secret', /\b(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*['"]?[A-Za-z0-9_\-/+]{16,}/i]
];

export function findSecret(text: string): string | null {
  for (const [cls, re] of SECRET_PATTERNS) if (re.test(text)) return cls;
  return null;
}
```

- [ ] **Step 5: Implement `claimRank.ts`:**

```ts
// Knowledge claims (#483): pure ranking helpers for search_claims.

/** Safe FTS5 MATCH expression: each token quoted (no operator injection), ORed. */
export function ftsQuery(q: string): string | null {
  const toks = q.replace(/"/g, '').match(/[A-Za-z0-9#_.-]+/g)
    ?.map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length > 0) ?? [];
  return toks.length === 0 ? null : toks.map((t) => `"${t}"`).join(' OR ');
}

/** Reciprocal rank fusion: score = Σ 1/(k + rank). Ties keep first-seen order. */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Topics most used by the nearest claims, so agents converge on shared slugs. */
export function suggestTopics(neighbors: { topics: string[] }[], given: string[], max = 5): string[] {
  const n = new Map<string, number>();
  for (const c of neighbors) for (const t of c.topics) if (!given.includes(t)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
}
```

- [ ] **Step 6: Run the tests.**

Run: `npx vitest run src/main/claims/`
Expected: PASS. If an `rrf` tie-order expectation fails, the test is wrong only if the scores are truly equal; `b` (ranks 2 and 1) must come first.

- [ ] **Step 7: Commit.**

```bash
git add src/main/claims/types.ts src/main/claims/claimValidate.ts src/main/claims/claimRank.ts src/main/claims/*.test.ts
git commit -m "feat(claims): validation, secret filter, FTS/RRF ranking helpers (#483)"
```

---

### Task 4: ClaimStore and CaptureRunStore (Kysely)

**Files:**
- Create: `src/main/claims/claimStore.ts`, `src/main/claims/captureRunStore.ts`
- Test: `src/main/claims/claimStore.test.ts`, `src/main/claims/captureRunStore.test.ts`

**Interfaces:**
- Consumes: `InboxStore.memory()`, `.kysely`, `newId(now)` from `src/main/inbox/inboxDb.ts`; the Task 2 row types; the Task 3 types.
- Produces:
  - `class ClaimStore(db: Kysely<InboxDb>)`, with methods:
    - `insert(c: NewClaim, vec: Buffer | null, modelId: string, src: ClaimSourceInput): Promise<void>`
    - `get(id): Promise<ClaimRecord | null>`
    - `visible(callerId, modelId, includeInactive: boolean): Promise<Array<{ claim: ClaimRecord; vec: Buffer | null }>>`
    - `confirm(id, src, now): Promise<void>`
    - `supersede(oldId, newId, now): Promise<void>`
    - `retract(id, reason, now): Promise<void>`
    - `ftsIds(callerId, match: string, limit: number, includeInactive: boolean): Promise<string[]>`
    - `sources(ids: string[]): Promise<Map<string, ClaimSourceRow[]>>`
    - `missingVectors(modelId, limit): Promise<Array<{ id: string; text: string }>>`
    - `setVector(id, modelId, vec): Promise<void>`
  - `type NewClaim = { id; text; kind; topics; refs; visibility; workspaceId; now }`
  - `class CaptureRunStore(db)`, with methods:
    - `start({ workspaceId, sessionId, forkSessionId, trigger, now }): Promise<string>`
    - `runningFor(token, workspaceId): Promise<CaptureRunRow | null>`
    - `finish(id, { status, usage, error, now }): Promise<void>`
    - `incrementClaims(id): Promise<void>`
    - `lastFor(sessionId): Promise<CaptureRunRow | null>`
    - `forkSessionIds(): Promise<string[]>`
    - `failRunning(now, error): Promise<number>`

- [ ] **Step 1: Write the failing tests.** `src/main/claims/claimStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { ClaimStore, type NewClaim } from './claimStore.js';
import type { ClaimSourceInput } from './types.js';

let inbox: InboxStore; let s: ClaimStore;
beforeEach(() => { inbox = InboxStore.memory(); s = new ClaimStore(inbox.kysely); });
afterEach(() => inbox.close());

const M = 'model@q8';
const src = (ws: string): ClaimSourceInput => ({ workspaceId: ws, sessionId: null, via: 'agent', captureRun: null });
const claim = (id: string, ws: string, over: Partial<NewClaim> = {}): NewClaim => ({
  id, text: `claim ${id} about snapshot`, kind: 'fact', topics: ['mcp-query'], refs: ['#476'],
  visibility: 'fleet', workspaceId: ws, now: 1000, ...over
});

describe('ClaimStore', () => {
  it('round-trips a claim with its vector and source', async () => {
    await s.insert(claim('c1', 'wsA'), Buffer.from([1, 2]), M, src('wsA'));
    expect(await s.get('c1')).toMatchObject({ id: 'c1', topics: ['mcp-query'], refs: ['#476'], status: 'current', confirmations: 1 });
    const v = await s.visible('wsA', M, false);
    expect(v.map((x) => [x.claim.id, x.vec?.length])).toEqual([['c1', 2]]);
    expect((await s.sources(['c1'])).get('c1')).toHaveLength(1);
  });

  it('hides other workspaces\' private claims but shows fleet ones', async () => {
    await s.insert(claim('pubB', 'wsB'), null, M, src('wsB'));
    await s.insert(claim('privB', 'wsB', { visibility: 'private' }), null, M, src('wsB'));
    await s.insert(claim('privA', 'wsA', { visibility: 'private' }), null, M, src('wsA'));
    const ids = (await s.visible('wsA', M, false)).map((x) => x.claim.id).sort();
    expect(ids).toEqual(['privA', 'pubB']);
    expect((await s.ftsIds('wsA', '"snapshot"', 10, false)).sort()).toEqual(['privA', 'pubB']);
  });

  it('confirm bumps confirmations and adds a source', async () => {
    await s.insert(claim('c1', 'wsA'), null, M, src('wsA'));
    await s.confirm('c1', src('wsB'), 2000);
    expect(await s.get('c1')).toMatchObject({ confirmations: 2, updatedAt: 2000 });
    expect((await s.sources(['c1'])).get('c1')).toHaveLength(2);
  });

  it('supersede and retract remove claims from the default visible set', async () => {
    await s.insert(claim('old', 'wsA'), null, M, src('wsA'));
    await s.insert(claim('new', 'wsA'), null, M, src('wsA'));
    await s.insert(claim('bad', 'wsA'), null, M, src('wsA'));
    await s.supersede('old', 'new', 3000);
    await s.retract('bad', 'wrong', 3000);
    expect((await s.visible('wsA', M, false)).map((x) => x.claim.id)).toEqual(['new']);
    expect((await s.visible('wsA', M, true)).length).toBe(3);
    expect(await s.get('old')).toMatchObject({ status: 'superseded', supersededBy: 'new' });
    expect(await s.get('bad')).toMatchObject({ status: 'retracted', retractReason: 'wrong' });
    expect(await s.ftsIds('wsA', '"snapshot"', 10, false)).toEqual(['new']);
  });

  it('lists and fills missing vectors', async () => {
    await s.insert(claim('c1', 'wsA'), null, M, src('wsA'));
    expect(await s.missingVectors(M, 10)).toEqual([{ id: 'c1', text: 'claim c1 about snapshot' }]);
    await s.setVector('c1', M, Buffer.from([9]));
    expect(await s.missingVectors(M, 10)).toEqual([]);
  });
});
```

`src/main/claims/captureRunStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { CaptureRunStore } from './captureRunStore.js';

let inbox: InboxStore; let r: CaptureRunStore;
beforeEach(() => { inbox = InboxStore.memory(); r = new CaptureRunStore(inbox.kysely); });
afterEach(() => inbox.close());

describe('CaptureRunStore', () => {
  it('validates tokens only for running runs in the same workspace', async () => {
    const id = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'ctx-60', now: 1 });
    expect((await r.runningFor(id, 'wsA'))?.session_id).toBe('s1');
    expect(await r.runningFor(id, 'wsB')).toBeNull();
    expect(await r.runningFor('nope', 'wsA')).toBeNull();
    await r.finish(id, { status: 'done', usage: { cost: 0.1 }, error: null, now: 2 });
    expect(await r.runningFor(id, 'wsA')).toBeNull();
  });
  it('counts claims, reports last run and fork ids, fails stale running runs', async () => {
    const a = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'turns', now: 1 });
    await r.incrementClaims(a); await r.incrementClaims(a);
    const b = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f2', trigger: 'ctx-85', now: 5 });
    expect((await r.lastFor('s1'))?.id).toBe(b);
    expect((await r.lastFor('s1'))?.claims_recorded).toBe(0);
    expect((await r.forkSessionIds()).sort()).toEqual(['f1', 'f2']);
    expect(await r.failRunning(9, 'interrupted by app restart')).toBe(2);
    expect(await r.runningFor(a, 'wsA')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npx vitest run src/main/claims/claimStore.test.ts src/main/claims/captureRunStore.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `claimStore.ts`:**

```ts
// Knowledge claims (#483): inbox.db persistence. Async Kysely only — inside a
// transaction callback query through trx, never this.db (mutex deadlock).
import { sql, type Kysely } from 'kysely';
import type { ClaimRow, ClaimSourceRow, InboxDb } from '../store/inboxSchema.js';
import type { ClaimKind, ClaimRecord, ClaimSourceInput, ClaimStatus, ClaimVisibility } from './types.js';

export interface NewClaim {
  id: string; text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; workspaceId: string; now: number;
}

function toRecord(r: ClaimRow): ClaimRecord {
  return {
    id: r.id, text: r.text, kind: r.kind as ClaimKind, topics: JSON.parse(r.topics) as string[],
    refs: r.refs ? (JSON.parse(r.refs) as string[]) : [], visibility: r.visibility as ClaimVisibility,
    status: r.status as ClaimStatus, supersededBy: r.superseded_by, retractReason: r.retract_reason,
    workspaceId: r.workspace_id, confirmations: r.confirmations, createdAt: r.created_at, updatedAt: r.updated_at
  };
}

export class ClaimStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async insert(c: NewClaim, vec: Buffer | null, modelId: string, src: ClaimSourceInput): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('claims').values({
        id: c.id, text: c.text, kind: c.kind, topics: JSON.stringify(c.topics),
        refs: c.refs.length ? JSON.stringify(c.refs) : null, visibility: c.visibility,
        superseded_by: null, retract_reason: null, workspace_id: c.workspaceId, created_at: c.now, updated_at: c.now
      }).execute();
      await sql`INSERT INTO claims_fts (claim_id, text, topics) VALUES (${c.id}, ${c.text}, ${c.topics.join(' ')})`.execute(trx);
      if (vec) await trx.insertInto('claim_vectors').values({ claim_id: c.id, model_id: modelId, vec }).execute();
      await trx.insertInto('claim_sources').values({
        claim_id: c.id, workspace_id: src.workspaceId, session_id: src.sessionId, via: src.via,
        capture_run: src.captureRun, ts: c.now
      }).execute();
    });
  }

  async get(id: string): Promise<ClaimRecord | null> {
    const r = await this.db.selectFrom('claims').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRecord(r) : null;
  }

  async visible(callerId: string, modelId: string, includeInactive: boolean): Promise<Array<{ claim: ClaimRecord; vec: Buffer | null }>> {
    let q = this.db.selectFrom('claims')
      .leftJoin('claim_vectors', (j) => j.onRef('claim_vectors.claim_id', '=', 'claims.id').on('claim_vectors.model_id', '=', modelId))
      .selectAll('claims').select('claim_vectors.vec')
      .where((eb) => eb.or([eb('claims.visibility', '=', 'fleet'), eb('claims.workspace_id', '=', callerId)]));
    if (!includeInactive) q = q.where('claims.status', '=', 'current');
    const rows = await q.orderBy('claims.created_at').execute();
    return rows.map((r) => ({ claim: toRecord(r), vec: (r.vec as Buffer | null) ?? null }));
  }

  async confirm(id: string, src: ClaimSourceInput, now: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('claims').set((eb) => ({ confirmations: eb('confirmations', '+', 1), updated_at: now })).where('id', '=', id).execute();
      await trx.insertInto('claim_sources').values({
        claim_id: id, workspace_id: src.workspaceId, session_id: src.sessionId, via: src.via, capture_run: src.captureRun, ts: now
      }).execute();
    });
  }

  async supersede(oldId: string, newId: string, now: number): Promise<void> {
    await this.db.updateTable('claims').set({ status: 'superseded', superseded_by: newId, updated_at: now }).where('id', '=', oldId).execute();
  }

  async retract(id: string, reason: string, now: number): Promise<void> {
    await this.db.updateTable('claims').set({ status: 'retracted', retract_reason: reason, updated_at: now }).where('id', '=', id).execute();
  }

  async ftsIds(callerId: string, match: string, limit: number, includeInactive: boolean): Promise<string[]> {
    const rows = await sql<{ id: string }>`
      SELECT c.id AS id FROM claims_fts f JOIN claims c ON c.id = f.claim_id
      WHERE claims_fts MATCH ${match}
        AND (c.visibility = 'fleet' OR c.workspace_id = ${callerId})
        AND (${includeInactive ? 1 : 0} = 1 OR c.status = 'current')
      ORDER BY bm25(claims_fts) LIMIT ${limit}`.execute(this.db);
    return rows.rows.map((r) => r.id);
  }

  async sources(ids: string[]): Promise<Map<string, ClaimSourceRow[]>> {
    const out = new Map<string, ClaimSourceRow[]>();
    if (ids.length === 0) return out;
    const rows = await this.db.selectFrom('claim_sources').selectAll().where('claim_id', 'in', ids).orderBy('ts').execute();
    for (const r of rows) out.set(r.claim_id, [...(out.get(r.claim_id) ?? []), r]);
    return out;
  }

  async missingVectors(modelId: string, limit: number): Promise<Array<{ id: string; text: string }>> {
    return this.db.selectFrom('claims')
      .leftJoin('claim_vectors', (j) => j.onRef('claim_vectors.claim_id', '=', 'claims.id').on('claim_vectors.model_id', '=', modelId))
      .select(['claims.id as id', 'claims.text as text']).where('claim_vectors.claim_id', 'is', null).limit(limit).execute();
  }

  async setVector(id: string, modelId: string, vec: Buffer): Promise<void> {
    await this.db.insertInto('claim_vectors').values({ claim_id: id, model_id: modelId, vec })
      .onConflict((oc) => oc.column('claim_id').doUpdateSet({ model_id: modelId, vec })).execute();
  }
}
```

- [ ] **Step 4: Implement `captureRunStore.ts`:**

```ts
// Knowledge claims (#483): background capture run bookkeeping. A run id is
// also the token the fork passes to record_claim (capture_run).
import type { Kysely } from 'kysely';
import { newId } from '../inbox/inboxDb.js';
import type { CaptureRunRow, InboxDb } from '../store/inboxSchema.js';

export type CaptureTrigger = 'ctx-60' | 'ctx-85' | 'turns';
export type CaptureStatus = 'running' | 'done' | 'failed' | 'timed-out';

export class CaptureRunStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async start(o: { workspaceId: string; sessionId: string; forkSessionId: string; trigger: CaptureTrigger; now: number }): Promise<string> {
    const id = newId(o.now);
    await this.db.insertInto('capture_runs').values({
      id, workspace_id: o.workspaceId, session_id: o.sessionId, fork_session_id: o.forkSessionId,
      trigger: o.trigger, status: 'running', usage: null, error: null, started_at: o.now, ended_at: null
    }).execute();
    return id;
  }

  async runningFor(token: string, workspaceId: string): Promise<CaptureRunRow | null> {
    return (await this.db.selectFrom('capture_runs').selectAll()
      .where('id', '=', token).where('workspace_id', '=', workspaceId).where('status', '=', 'running')
      .executeTakeFirst()) ?? null;
  }

  async finish(id: string, o: { status: Exclude<CaptureStatus, 'running'>; usage: unknown; error: string | null; now: number }): Promise<void> {
    await this.db.updateTable('capture_runs').set({
      status: o.status, usage: o.usage === undefined || o.usage === null ? null : JSON.stringify(o.usage),
      error: o.error, ended_at: o.now
    }).where('id', '=', id).execute();
  }

  async incrementClaims(id: string): Promise<void> {
    await this.db.updateTable('capture_runs').set((eb) => ({ claims_recorded: eb('claims_recorded', '+', 1) })).where('id', '=', id).execute();
  }

  async lastFor(sessionId: string): Promise<CaptureRunRow | null> {
    return (await this.db.selectFrom('capture_runs').selectAll().where('session_id', '=', sessionId)
      .orderBy('started_at', 'desc').limit(1).executeTakeFirst()) ?? null;
  }

  async forkSessionIds(): Promise<string[]> {
    const rows = await this.db.selectFrom('capture_runs').select('fork_session_id').where('fork_session_id', 'is not', null).execute();
    return rows.map((r) => r.fork_session_id as string);
  }

  /** Startup sweep: a run still 'running' was orphaned by an app exit. */
  async failRunning(now: number, error: string): Promise<number> {
    const r = await this.db.updateTable('capture_runs').set({ status: 'failed', error, ended_at: now })
      .where('status', '=', 'running').executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
```

- [ ] **Step 5: Run the tests.**

Run: `npx vitest run src/main/claims/`
Expected: PASS. If `failRunning` is flaky for runs started in the same millisecond, the ordering in `lastFor` uses `started_at` (1 vs 5), so it's deterministic.

- [ ] **Step 6: Commit.**

```bash
git add src/main/claims/claimStore.ts src/main/claims/captureRunStore.ts src/main/claims/claimStore.test.ts src/main/claims/captureRunStore.test.ts
git commit -m "feat(claims): ClaimStore + CaptureRunStore on the async Kysely layer (#483)"
```

---

### Task 5: ClaimService (record, search, retract, vector backfill)

**Files:**
- Create: `src/main/claims/claimService.ts`
- Test: `src/main/claims/claimService.test.ts`

**Interfaces:**
- Consumes: `ClaimStore`, `CaptureRunStore` (Task 4); `validateClaimInput`, `findSecret` (Task 3); `ftsQuery`, `rrf`, `suggestTopics` (Task 3); `encodeVector`, `decodeVector`, `dot`, `EMBED_MODEL_ID` from `src/main/vectors.ts`; `EmbedFn` from `src/main/transcriptIndex.ts`; `newId` from `src/main/inbox/inboxDb.ts`.
- Produces:
  - `class ClaimService(deps: ClaimServiceDeps)`, with methods:
    - `record(callerId: string, args: Record<string, unknown>): Promise<{ id: string; deduped: boolean; suggestedTopics: string[] }>`
    - `search(callerId, args): Promise<{ results: ClaimSearchResult[] }>`
    - `retract(callerId, args): Promise<{ id: string; status: 'retracted' }>`
    - `backfillVectors(): Promise<number>`
  - `ClaimServiceDeps = { claims: ClaimStore; runs: CaptureRunStore; embed: EmbedFn | null; workspaceName: (id: string) => Promise<string | null>; now?: () => number }`

- [ ] **Step 1: Write the failing tests.** `src/main/claims/claimService.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { ClaimStore } from './claimStore.js';
import { CaptureRunStore } from './captureRunStore.js';
import { ClaimService } from './claimService.js';

// Deterministic fake embedder: texts sharing a leading word get identical
// vectors (cosine 1); different leading words are orthogonal.
const DIM = 384;
const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(DIM); v[t.split(/\s+/)[0].length % DIM] = 1; return v;
});

let inbox: InboxStore; let svc: ClaimService; let runs: CaptureRunStore; let t = 1000;
beforeEach(() => {
  inbox = InboxStore.memory();
  runs = new CaptureRunStore(inbox.kysely);
  svc = new ClaimService({ claims: new ClaimStore(inbox.kysely), runs, embed: fakeEmbed,
    workspaceName: async (id) => `name-${id}`, now: () => ++t });
});
afterEach(() => inbox.close());

const base = { kind: 'root-cause', topics: ['mcp-query'] };

describe('ClaimService.record', () => {
  it('records and returns suggested topics from neighbours', async () => {
    await svc.record('wsA', { ...base, text: 'snapshot copies history', topics: ['mcp-query', 'state-db'] });
    const r = await svc.record('wsB', { ...base, text: 'snapshot freezes main', kind: 'fact' });
    expect(r.deduped).toBe(false);
    expect(r.suggestedTopics).toContain('state-db');
  });
  it('dedupes a near-identical claim of the same kind', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsB', { ...base, text: 'snapshot copies everything' });
    expect(b).toMatchObject({ id: a.id, deduped: true });
  });
  it('does not dedupe across kinds', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsA', { ...base, kind: 'decision', text: 'snapshot moves to a worker' });
    expect(b.id).not.toBe(a.id);
  });
  it('rejects secrets without echoing them', async () => {
    await expect(svc.record('wsA', { ...base, text: 'use ghp_' + 'a'.repeat(36) })).rejects.toThrow(/secret \(github-token\)/);
    await expect(svc.record('wsA', { ...base, text: 'use ghp_' + 'a'.repeat(36) })).rejects.not.toThrow(/ghp_a/);
  });
  it('supersedes a visible current claim and skips dedupe', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsA', { ...base, text: 'snapshot runs in a worker now', supersedes: a.id });
    expect(b.deduped).toBe(false);
    const hits = await svc.search('wsA', { query: 'snapshot', include_superseded: true });
    expect(hits.results.find((h) => h.id === a.id)).toMatchObject({ status: 'superseded', supersededBy: b.id });
  });
  it('refuses to supersede another workspace\'s private claim', async () => {
    const a = await svc.record('wsB', { ...base, text: 'private thing', visibility: 'private' });
    await expect(svc.record('wsA', { ...base, text: 'other thing', supersedes: a.id })).rejects.toThrow(/supersedes/);
  });
  it('stamps capture provenance only for a running run in the caller workspace', async () => {
    const run = await runs.start({ workspaceId: 'wsA', sessionId: 'live-1', forkSessionId: 'f1', trigger: 'ctx-60', now: 1 });
    const r = await svc.record('wsA', { ...base, text: 'captured fact', capture_run: run });
    const hit = (await svc.search('wsA', { query: 'captured' })).results.find((h) => h.id === r.id);
    expect(hit?.sources[0]).toMatchObject({ via: 'capture', sessionId: 'live-1' });
    expect((await runs.lastFor('live-1'))?.claims_recorded).toBe(1);
    await expect(svc.record('wsB', { ...base, text: 'forged', capture_run: run })).rejects.toThrow(/capture_run/);
  });
  it('still records (FTS-only) when the embedder throws, and backfills later', async () => {
    const failing = new ClaimService({ claims: new ClaimStore(inbox.kysely), runs, embed: async () => { throw new Error('model down'); },
      workspaceName: async () => null, now: () => ++t });
    const r = await failing.record('wsA', { ...base, text: 'offline claim' });
    expect((await failing.search('wsA', { query: 'offline' })).results.map((h) => h.id)).toEqual([r.id]);
    expect(await svc.backfillVectors()).toBe(1);
  });
});

describe('ClaimService.search / retract', () => {
  it('fuses keyword and vector hits and includes provenance', async () => {
    const a = await svc.record('wsA', { ...base, text: 'buildSnapshot is O(history) #476', refs: ['#476'] });
    const res = await svc.search('wsB', { query: '#476' });
    expect(res.results[0]).toMatchObject({ id: a.id, workspaceId: 'wsA', workspaceName: 'name-wsA', status: 'current' });
    expect(res.results[0].sources[0]).toMatchObject({ via: 'agent', sessionId: null });
  });
  it('filters by kind and topics', async () => {
    await svc.record('wsA', { ...base, text: 'alpha one', topics: ['perf'] });
    await svc.record('wsA', { ...base, kind: 'gotcha', text: 'beta two', topics: ['perf'] });
    expect((await svc.search('wsA', { query: 'alpha beta', kind: 'gotcha' })).results.map((h) => h.text)).toEqual(['beta two']);
    expect((await svc.search('wsA', { query: 'alpha beta', topics: ['nope'] })).results).toEqual([]);
  });
  it('only the authoring workspace may retract', async () => {
    const a = await svc.record('wsA', { ...base, text: 'wrong claim' });
    await expect(svc.retract('wsB', { id: a.id, reason: 'x' })).rejects.toThrow(/authoring workspace/);
    expect(await svc.retract('wsA', { id: a.id, reason: 'was wrong' })).toEqual({ id: a.id, status: 'retracted' });
    expect((await svc.search('wsA', { query: 'wrong' })).results).toEqual([]);
  });
  it('requires a query', async () => {
    await expect(svc.search('wsA', {})).rejects.toThrow(/query/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npx vitest run src/main/claims/claimService.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `claimService.ts`:**

```ts
// Knowledge claims (#483): record / search / retract. Provenance is
// host-stamped: workspace from the MCP caller, session only via a validated
// capture_run token (spec §2, §3, §7).
import { newId } from '../inbox/inboxDb.js';
import type { EmbedFn } from '../transcriptIndex.js';
import { decodeVector, dot, encodeVector, EMBED_MODEL_ID } from '../vectors.js';
import type { CaptureRunStore } from './captureRunStore.js';
import type { ClaimStore } from './claimStore.js';
import { ftsQuery, rrf, suggestTopics } from './claimRank.js';
import { findSecret, validateClaimInput } from './claimValidate.js';
import { CLAIM_KINDS, DEDUPE_COSINE, type ClaimRecord, type ClaimSourceInput } from './types.js';

export interface ClaimServiceDeps {
  claims: ClaimStore; runs: CaptureRunStore; embed: EmbedFn | null;
  workspaceName: (id: string) => Promise<string | null>; now?: () => number;
}
export interface ClaimSearchResult extends ClaimRecord {
  workspaceName: string | null;
  sources: Array<{ workspaceId: string; sessionId: string | null; via: string; ts: number }>;
}

export class ClaimService {
  private readonly now: () => number;
  constructor(private readonly d: ClaimServiceDeps) { this.now = d.now ?? Date.now; }

  private async embedOne(text: string): Promise<Float32Array | null> {
    if (!this.d.embed) return null;
    try { return (await this.d.embed([text]))[0] ?? null; } catch { return null; }
  }

  async record(callerId: string, args: Record<string, unknown>): Promise<{ id: string; deduped: boolean; suggestedTopics: string[] }> {
    const input = validateClaimInput(args);
    const secret = findSecret([input.text, ...input.refs].join('\n'));
    if (secret) throw new Error(`claim rejected: it looks like it contains a secret (${secret}); remove it and retry`);
    let source: ClaimSourceInput = { workspaceId: callerId, sessionId: null, via: 'agent', captureRun: null };
    if (input.captureRun) {
      const run = await this.d.runs.runningFor(input.captureRun, callerId);
      if (!run) throw new Error('capture_run is not an active capture run for this workspace');
      source = { workspaceId: callerId, sessionId: run.session_id, via: 'capture', captureRun: run.id };
    }
    const vec = await this.embedOne(input.text);
    const visible = await this.d.claims.visible(callerId, EMBED_MODEL_ID, false);
    if (input.supersedes && !visible.some((v) => v.claim.id === input.supersedes)) {
      throw new Error('supersedes must name a current claim you can see');
    }
    const scored = vec
      ? visible.filter((v) => v.vec).map((v) => ({ v, score: dot(vec, decodeVector(v.vec as Buffer)) })).sort((a, b) => b.score - a.score)
      : [];
    const suggested = suggestTopics(scored.slice(0, 5).map((s) => s.v.claim), input.topics);
    const now = this.now();
    const dup = input.supersedes ? undefined : scored.find((s) => s.score >= DEDUPE_COSINE && s.v.claim.kind === input.kind);
    if (dup) {
      await this.d.claims.confirm(dup.v.claim.id, source, now);
      if (source.captureRun) await this.d.runs.incrementClaims(source.captureRun);
      return { id: dup.v.claim.id, deduped: true, suggestedTopics: suggested };
    }
    const id = newId(now);
    await this.d.claims.insert(
      { id, text: input.text, kind: input.kind, topics: input.topics, refs: input.refs, visibility: input.visibility, workspaceId: callerId, now },
      vec ? encodeVector(vec) : null, EMBED_MODEL_ID, source
    );
    if (input.supersedes) await this.d.claims.supersede(input.supersedes, id, now);
    if (source.captureRun) await this.d.runs.incrementClaims(source.captureRun);
    return { id, deduped: false, suggestedTopics: suggested };
  }

  async search(callerId: string, args: Record<string, unknown>): Promise<{ results: ClaimSearchResult[] }> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
    const includeInactive = args.include_superseded === true;
    const kind = typeof args.kind === 'string' && (CLAIM_KINDS as readonly string[]).includes(args.kind) ? args.kind : null;
    const topics = Array.isArray(args.topics) ? args.topics.map((t) => String(t).toLowerCase()) : [];
    const pool = (await this.d.claims.visible(callerId, EMBED_MODEL_ID, includeInactive))
      .filter((v) => (!kind || v.claim.kind === kind) && (topics.length === 0 || v.claim.topics.some((t) => topics.includes(t))));
    const allowed = new Set(pool.map((v) => v.claim.id));
    const qvec = await this.embedOne(query);
    const vecIds = qvec
      ? pool.filter((v) => v.vec).map((v) => ({ id: v.claim.id, s: dot(qvec, decodeVector(v.vec as Buffer)) }))
          .sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.id)
      : [];
    const match = ftsQuery(query);
    const ftsIds = match ? (await this.d.claims.ftsIds(callerId, match, 50, includeInactive)).filter((id) => allowed.has(id)) : [];
    const ids = rrf([vecIds, ftsIds]).slice(0, limit);
    const byId = new Map(pool.map((v) => [v.claim.id, v.claim]));
    const srcs = await this.d.claims.sources(ids);
    const names = new Map<string, string | null>();
    const results: ClaimSearchResult[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (!names.has(c.workspaceId)) names.set(c.workspaceId, await this.d.workspaceName(c.workspaceId));
      results.push({
        ...c, workspaceName: names.get(c.workspaceId) ?? null,
        sources: (srcs.get(id) ?? []).map((s) => ({ workspaceId: s.workspace_id, sessionId: s.session_id, via: s.via, ts: s.ts }))
      });
    }
    return { results };
  }

  async retract(callerId: string, args: Record<string, unknown>): Promise<{ id: string; status: 'retracted' }> {
    const id = typeof args.id === 'string' ? args.id : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
    if (!id || !reason) throw new Error('id and reason are required');
    const c = await this.d.claims.get(id);
    if (!c || c.workspaceId !== callerId) throw new Error('only the authoring workspace can retract a claim');
    await this.d.claims.retract(id, reason, this.now());
    return { id, status: 'retracted' };
  }

  /** Fill vectors for claims recorded while the embedder was unavailable. */
  async backfillVectors(): Promise<number> {
    if (!this.d.embed) return 0;
    let n = 0;
    for (const m of await this.d.claims.missingVectors(EMBED_MODEL_ID, 200)) {
      const v = await this.embedOne(m.text);
      if (!v) break;
      await this.d.claims.setVector(m.id, EMBED_MODEL_ID, encodeVector(v)); n++;
    }
    return n;
  }
}
```

- [ ] **Step 4: Run the tests.**

Run: `npx vitest run src/main/claims/`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/main/claims/claimService.ts src/main/claims/claimService.test.ts
git commit -m "feat(claims): ClaimService — record/dedupe/supersede, hybrid search, retract (#483)"
```

---

### Task 6: MCP tools, standing rule, wiring, SPEC

**Files:**
- Modify: `src/main/mcpServer.ts` (handlers setter near lines 134–161; `initialize` at ~605; `search_transcripts` description at ~1012; new tools appended before `get_config` at ~1681)
- Modify: `src/main/index.ts` (after `InboxStore.open` at ~164 and after `setQueryEmbedder(embed)` at ~197)
- Modify: `src/main/mcpServer.test.ts`, `tests/mcp-server.spec.ts:100-129`
- Modify: `docs/SPEC.md` (§11 Fleet-state MCP tool list, §9 security, the inbox.db schema section)

**Interfaces:**
- Consumes: `ClaimService` (Task 5), `ClaimStore`, `CaptureRunStore` (Task 4).
- Produces:
  - `export interface ClaimHandlers { record(callerId, args): Promise<unknown>; search(callerId, args): Promise<unknown>; retract(callerId, args): Promise<unknown> }`
  - `export function setClaimHandlers(h: ClaimHandlers | null): void`
  - `export const STANDING_RULE: string`
  - MCP tools `record_claim`, `search_claims`, `retract_claim`

- [ ] **Step 1: Write the failing unit tests.** Append to `src/main/mcpServer.test.ts`:

```ts
describe('knowledge claims tools (#483)', () => {
  afterEach(() => setClaimHandlers(null));
  it('registers record_claim, search_claims, retract_claim', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['record_claim', 'search_claims', 'retract_claim']));
  });
  it('passes the host caller id, never a wire-supplied one', async () => {
    const seen: string[] = [];
    setClaimHandlers({
      record: async (c) => { seen.push(c); return { id: 'x' }; },
      search: async (c) => { seen.push(c); return { results: [] }; },
      retract: async (c) => { seen.push(c); return { id: 'x', status: 'retracted' }; }
    });
    await tool('record_claim').run(makeDb(), { text: 't', kind: 'fact', topics: ['a1'], callerId: 'evil' }, ctxA);
    await tool('search_claims').run(makeDb(), { query: 'q' }, ctxA);
    await tool('retract_claim').run(makeDb(), { id: 'x', reason: 'r' }, ctxA);
    expect(seen).toEqual([WS_A, WS_A, WS_A]);
  });
  it('fails clearly when claims are unavailable', () => {
    expect(() => tool('search_claims').run(makeDb(), { query: 'q' }, ctxA)).toThrow(/claims are unavailable/);
  });
  it('search_transcripts no longer instructs agents to call mark_useful', () => {
    expect(tool('search_transcripts').description).not.toMatch(/mark_useful/);
  });
  it('the standing rule fits the 2048-char MCP instructions budget and names the tools', () => {
    expect(STANDING_RULE.length).toBeLessThan(1200);
    expect(STANDING_RULE).toMatch(/record_claim/);
    expect(STANDING_RULE).toMatch(/search_claims/);
  });
});
```

Add `setClaimHandlers, STANDING_RULE` to the import from `./mcpServer.js` at line 18, and `afterEach` to the vitest import if it's missing.

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: FAIL (`setClaimHandlers` not exported).

- [ ] **Step 3: Add the handlers setter and the standing rule** in `src/main/mcpServer.ts`, next to `setInboxHandlers` (~line 161):

```ts
/** Knowledge claims (#483) — injected by index.ts so mcpServer stays store-free. */
export interface ClaimHandlers {
  record(callerId: string, args: Record<string, unknown>): Promise<unknown>;
  search(callerId: string, args: Record<string, unknown>): Promise<unknown>;
  retract(callerId: string, args: Record<string, unknown>): Promise<unknown>;
}
let claimHandlers: ClaimHandlers | null = null;
export function setClaimHandlers(h: ClaimHandlers | null): void { claimHandlers = h; }
function claims(): ClaimHandlers {
  if (!claimHandlers) throw new Error('claims are unavailable');
  return claimHandlers;
}

/** Fleet-wide standing rule, delivered as the MCP initialize `instructions`
 *  (Claude Code injects it as a first-turn system reminder; 2,048-char cap). */
export const STANDING_RULE =
  'Fleet knowledge: when you settle a decision, find a root cause, learn a non-obvious fact or gotcha, ' +
  'or rule something out (and why), call record_claim with one short self-contained sentence or two, ' +
  '1-3 topic slugs, and refs (issue/PR/file). Before re-investigating something, call search_claims — ' +
  'another session may already know. Never put secrets in claims; use visibility "private" for ' +
  'workspace-specific details.';
```

- [ ] **Step 4: Add `instructions` to `initialize`** (~line 605):

```ts
case 'initialize':
  return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: STANDING_RULE };
```

(Leave `PROTOCOL_VERSION` unchanged. Clients ignore unknown result fields, and Task 11 confirms on the host that Claude Code surfaces it.)

- [ ] **Step 5: Change the `search_transcripts` description** (~line 1012). Replace the trailing sentence `If a result leads you to the information you needed, call mark_useful with its sessionId.` with `For settled knowledge (decisions, root causes, gotchas), prefer search_claims.`

- [ ] **Step 6: Add the three tools** to `TOOLS`, immediately before the `get_config` entry:

```ts
  {
    name: 'record_claim',
    description:
      'Record one durable piece of fleet knowledge: a decision, root cause, non-obvious fact, gotcha, or a rejected option with its reason. ' +
      'Args: text (required, <=600 chars, self-contained), kind (required: decision|fact|gotcha|root-cause|rejected), ' +
      'topics (required, 1-3 slugs like "mcp-query"), refs (optional issue/PR/file strings), visibility ("fleet" default | "private"), ' +
      'supersedes (optional claim id this replaces), capture_run (only when a capture prompt gives you one). ' +
      'Near-duplicates are merged. Never include secrets. Returns { id, deduped, suggestedTopics }.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, kind: { type: 'string', enum: ['decision', 'fact', 'gotcha', 'root-cause', 'rejected'] },
        topics: { type: 'array', items: { type: 'string' } }, refs: { type: 'array', items: { type: 'string' } },
        visibility: { type: 'string', enum: ['fleet', 'private'] }, supersedes: { type: 'string' }, capture_run: { type: 'string' }
      },
      required: ['text', 'kind', 'topics']
    },
    run: (_db, a, ctx) => claims().record(ctx.callerId, a)
  },
  {
    name: 'search_claims',
    description:
      'Search fleet knowledge claims (decisions, root causes, gotchas, rejected options) by keyword and meaning. ' +
      'Args: query (required), topics (optional slugs), kind (optional), include_superseded (default false), limit (default 10, max 50). ' +
      'Returns claims with provenance (workspace, session when known, date) and supersededBy links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', enum: ['decision', 'fact', 'gotcha', 'root-cause', 'rejected'] },
        include_superseded: { type: 'boolean' }, limit: { type: 'number' }
      },
      required: ['query']
    },
    run: (_db, a, ctx) => claims().search(ctx.callerId, a)
  },
  {
    name: 'retract_claim',
    description: 'Retract a claim your workspace recorded that turned out to be wrong. Args: id (required), reason (required). To replace a claim with a corrected one, use record_claim with supersedes instead.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    run: (_db, a, ctx) => claims().retract(ctx.callerId, a)
  },
```

- [ ] **Step 7: Wire it in `src/main/index.ts`.** Right after `setQueryEmbedder(embed);`, inside the same `if (!isMock)` block that has `inboxStore` and `embed` in scope:

```ts
    if (inboxStore) {
      const claimStore = new ClaimStore(inboxStore.kysely);
      const captureRuns = new CaptureRunStore(inboxStore.kysely);
      const claimService = new ClaimService({
        claims: claimStore, runs: captureRuns, embed,
        workspaceName: async (id) => (await readWorkspaceManifest(id))?.name ?? null
      });
      setClaimHandlers({
        record: (c, a) => claimService.record(c, a),
        search: (c, a) => claimService.search(c, a),
        retract: (c, a) => claimService.retract(c, a)
      });
      void captureRuns.failRunning(Date.now(), 'interrupted by app restart');
      void claimService.backfillVectors().catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'claims-backfill', message: String(e) }));
    }
```

Add the imports: `ClaimStore` from `./claims/claimStore.js`, `CaptureRunStore` from `./claims/captureRunStore.js`, `ClaimService` from `./claims/claimService.js`, `setClaimHandlers` from `./mcpServer.js` (extend the existing import), and `readWorkspaceManifest` from `./workspaces.js` (extend it if already imported). If `inboxStore` is opened *after* this point in the file, move this block to just after `inboxStore = InboxStore.open(...)` and make `embed` available there by hoisting `makeEmbedder(...)` above it.

- [ ] **Step 8: Update the e2e contract test.** In `tests/mcp-server.spec.ts`, add `'record_claim', 'search_claims', 'retract_claim'` to the `arrayContaining` list (~line 129), and add `expect(typeof init.result.instructions).toBe('string');` after the `serverInfo` assertion.

- [ ] **Step 9: Update `docs/SPEC.md`.**
  - §11 Fleet-state MCP: add `record_claim`, `search_claims`, `retract_claim` with the argument and return shapes from Step 6; note the `instructions` standing rule; replace the `mark_useful` instruction note with "kept for compatibility; no longer advertised".
  - §9 security: add the spec §7 bullets (fleet claims are an intentional agent-authored exception; secret filter is a backstop; provenance is host-stamped).
  - Inbox store section: add the v6 tables from Task 2.

- [ ] **Step 10: Run the gates.**

Run: `npx vitest run src/main/mcpServer.test.ts src/main/claims/ && npm run typecheck:node && npm run typecheck:web`
Expected: all PASS; both typechecks clean.

- [ ] **Step 11: Commit.**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts src/main/index.ts tests/mcp-server.spec.ts docs/SPEC.md
git commit -m "feat(claims): record_claim/search_claims/retract_claim MCP tools + standing rule (#483)"
```

---

### Task 7: Capture signals from state.db + trigger policy (pure)

**Files:**
- Modify: `src/main/db.ts` (append two exported functions near `listSessions`)
- Create: `src/main/claims/capturePolicy.ts`
- Test: `src/main/claims/capturePolicy.test.ts`, `src/main/dbCaptureSignals.test.ts`

**Interfaces:**
- Consumes: `contextWindowFor(model, observedMax)` from `src/main/contextWindow.ts`; `CaptureTrigger` from Task 4.
- Produces:
  - `sessionCaptureSignals(sessionId: string): CaptureSignals | null`
  - `isAutomationSession(sessionId: string): boolean` (db.ts)
  - `type CaptureSignals = { workspaceId: string; model: string | null; contextTokens: number; userTurns: number; compactions: number }`
  - `decideCapture(sig, state: SessionCaptureState | undefined, hasPriorRun: boolean, cfg: CapturePolicyConfig, now: number): { trigger: CaptureTrigger | null; next: SessionCaptureState }`
  - `DEFAULT_CAPTURE_POLICY`

- [ ] **Step 1: Write the failing db test.** `src/main/dbCaptureSignals.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, ingestLine, openDb, sessionCaptureSignals, isAutomationSession } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'capsig-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 's1', timestamp: '2026-11-04T00:00:00Z', ...o });

describe('sessionCaptureSignals', () => {
  it('reads latest context usage, user turns and compactions', () => {
    ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }));
    ingestLine('wsA', 's1', line({ type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 }, content: [] } }));
    ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'again' } }));
    ingestLine('wsA', 's1', line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }));
    expect(sessionCaptureSignals('s1')).toEqual({ workspaceId: 'wsA', model: 'claude-opus-5-5', contextTokens: 1100, userTurns: 2, compactions: 1 });
  });
  it('returns null for an unknown session', () => {
    expect(sessionCaptureSignals('nope')).toBeNull();
  });
  it('isAutomationSession is false without an auto- broker mapping', () => {
    expect(isAutomationSession('s1')).toBe(false);
  });
});
```

(If `ingestLine` derives `tool_use_id` for user lines only from `tool_result` content, plain-string user content counts as a turn. Keep the fixture as is.)

- [ ] **Step 2: Write the failing policy test.** `src/main/claims/capturePolicy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideCapture, DEFAULT_CAPTURE_POLICY as P } from './capturePolicy.js';

const sig = (contextTokens: number, userTurns = 1, compactions = 0) =>
  ({ workspaceId: 'w', model: 'claude-sonnet-5', contextTokens, userTurns, compactions });
const MIN = 60_000;

describe('decideCapture', () => {
  it('fires ctx-60 once when fill first crosses 60%', () => {
    const a = decideCapture(sig(130_000), undefined, true, P, 0);
    expect(a.trigger).toBe('ctx-60');
    const b = decideCapture(sig(140_000), a.next, true, P, 20 * MIN);
    expect(b.trigger).toBeNull();
  });
  it('fires ctx-85 after ctx-60, respecting the 10-minute interval', () => {
    const a = decideCapture(sig(130_000), undefined, true, P, 0);
    expect(decideCapture(sig(180_000), a.next, true, P, 5 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(180_000), a.next, true, P, 11 * MIN).trigger).toBe('ctx-85');
  });
  it('resets bands after a compaction', () => {
    const a = decideCapture(sig(130_000, 1, 0), undefined, true, P, 0);
    const b = decideCapture(sig(40_000, 2, 1), a.next, true, P, 20 * MIN);
    expect(b.trigger).toBeNull();
    expect(decideCapture(sig(125_000, 3, 1), b.next, true, P, 40 * MIN).trigger).toBe('ctx-60');
  });
  it('fires turns every 30 user turns', () => {
    const a = decideCapture(sig(1_000, 10), undefined, true, P, 0);
    expect(a.trigger).toBeNull();
    expect(decideCapture(sig(1_000, 39), a.next, true, P, 20 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(1_000, 40), a.next, true, P, 20 * MIN).trigger).toBe('turns');
  });
  it('captures history once for a never-captured session with >= 30 turns', () => {
    expect(decideCapture(sig(1_000, 45), undefined, false, P, 0).trigger).toBe('turns');
    expect(decideCapture(sig(1_000, 45), undefined, true, P, 0).trigger).toBeNull();
  });
  it('uses the 1M window for [1m] models', () => {
    const s = { ...sig(300_000), model: 'claude-opus-5-5[1m]' };
    expect(decideCapture(s, undefined, true, P, 0).trigger).toBeNull();
  });
});
```

- [ ] **Step 3: Run them and confirm they fail.**

Run: `npx vitest run src/main/dbCaptureSignals.test.ts src/main/claims/capturePolicy.test.ts`
Expected: FAIL (functions missing).

- [ ] **Step 4: Implement the db helpers.** Append to `src/main/db.ts` (use `grep -a` to navigate; the file contains NUL bytes):

```ts
export interface CaptureSignals {
  workspaceId: string; model: string | null; contextTokens: number; userTurns: number; compactions: number;
}

/** Knowledge capture (#483): per-session inputs for the trigger policy. Small
 *  indexed reads (idx_events_session_type) — safe on the ingest path. */
export function sessionCaptureSignals(sessionId: string): CaptureSignals | null {
  const d = openDbOrThrow();
  const s = d.prepare(`SELECT workspace_id FROM sessions WHERE id = ?`).get(sessionId) as { workspace_id: string } | undefined;
  if (!s) return null;
  const last = d.prepare(
    `SELECT model, COALESCE(input_tokens,0)+COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0) AS ctx
     FROM events WHERE session_id = ? AND type = 'assistant' AND input_tokens IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get(sessionId) as { model: string | null; ctx: number } | undefined;
  const turns = d.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'user' AND tool_use_id IS NULL`)
    .get(sessionId) as { n: number };
  const comp = d.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'system' AND subtype = 'compact_boundary'`)
    .get(sessionId) as { n: number };
  return { workspaceId: s.workspace_id, model: last?.model ?? null, contextTokens: last?.ctx ?? 0, userTurns: turns.n, compactions: comp.n };
}

/** True when the session was started by an automation fresh step (broker id auto-…). */
export function isAutomationSession(sessionId: string): boolean {
  const d = openDbOrThrow();
  return !!d.prepare(`SELECT 1 FROM broker_sessions WHERE claude_session_id = ? AND broker_session_id LIKE 'auto-%' LIMIT 1`).get(sessionId);
}
```

(If the file's DB accessor isn't named `openDbOrThrow`, use the one `listSessions` uses. `getDb()` at the end of db.ts returns `openDbOrThrow()`.)

- [ ] **Step 5: Implement `capturePolicy.ts`:**

```ts
// Knowledge capture (#483): pure trigger policy. State lives in the scheduler.
import { contextWindowFor } from '../contextWindow.js';
import type { CaptureSignals } from '../db.js';
import type { CaptureTrigger } from './captureRunStore.js';

export interface CapturePolicyConfig { bands: [number, number]; turnsEvery: number; minIntervalMs: number }
export const DEFAULT_CAPTURE_POLICY: CapturePolicyConfig = { bands: [0.6, 0.85], turnsEvery: 30, minIntervalMs: 10 * 60_000 };

export interface SessionCaptureState {
  fired: Array<'ctx-60' | 'ctx-85'>; compactionsSeen: number; turnsAtLastCapture: number; lastCaptureAt: number | null;
}

export function decideCapture(
  sig: CaptureSignals, state: SessionCaptureState | undefined, hasPriorRun: boolean, cfg: CapturePolicyConfig, now: number
): { trigger: CaptureTrigger | null; next: SessionCaptureState } {
  let s: SessionCaptureState = state ?? {
    fired: [], compactionsSeen: sig.compactions,
    // A never-captured session gets its history captured once (turn counter from 0).
    turnsAtLastCapture: hasPriorRun ? sig.userTurns : 0, lastCaptureAt: null
  };
  if (sig.compactions > s.compactionsSeen) s = { ...s, fired: [], compactionsSeen: sig.compactions };
  if (s.lastCaptureAt !== null && now - s.lastCaptureAt < cfg.minIntervalMs) return { trigger: null, next: s };
  const fill = sig.contextTokens / contextWindowFor(sig.model, sig.contextTokens);
  let trigger: CaptureTrigger | null = null;
  if (fill >= cfg.bands[1] && !s.fired.includes('ctx-85')) trigger = 'ctx-85';
  else if (fill >= cfg.bands[0] && !s.fired.includes('ctx-60')) trigger = 'ctx-60';
  else if (sig.userTurns - s.turnsAtLastCapture >= cfg.turnsEvery) trigger = 'turns';
  if (!trigger) return { trigger: null, next: s };
  const fired = trigger === 'turns' ? s.fired
    : trigger === 'ctx-85' ? [...new Set([...s.fired, 'ctx-60', 'ctx-85'] as const)] : [...s.fired, 'ctx-60' as const];
  return { trigger, next: { ...s, fired, turnsAtLastCapture: sig.userTurns, lastCaptureAt: now } };
}
```

- [ ] **Step 6: Run the tests.**

Run: `npx vitest run src/main/dbCaptureSignals.test.ts src/main/claims/capturePolicy.test.ts`
Expected: PASS. If the db test fails with "Module did not self-register", the worktree's better-sqlite3 binary is ABI-broken. Redo the env recipe in Global Constraints and rerun, and only rely on CI if it still fails.

- [ ] **Step 7: Commit.**

```bash
git add src/main/db.ts src/main/dbCaptureSignals.test.ts src/main/claims/capturePolicy.ts src/main/claims/capturePolicy.test.ts
git commit -m "feat(claims): capture signals from state.db + pure trigger policy (#483)"
```

---

### Task 8: Capture command builder and per-backend executors

**Files:**
- Create: `src/main/claims/captureCommand.ts`, `src/main/claims/captureExec.ts`
- Test: `src/main/claims/captureCommand.test.ts`, `src/main/claims/captureExec.test.ts`

**Interfaces:**
- Consumes: `posixQuote`, `buildWslSpawnEnv`, `wslInDistroPath`, `WorkspaceLauncher` from `src/main/localLauncher.ts`; `execScript` from `src/main/docker.ts`; `buildEnv`, `ensureMcpConfig` from `src/main/local.ts`; `findClaude` / the `resolveClaude` logic from `src/main/local.ts`.
- Produces:
  - `CAPTURE_TOOLS: string`
  - `capturePrompt(o: { runToken: string; topTopics: string[] }): string`
  - `captureArgs(o: { prompt: string; sessionId: string; forkSessionId: string; model: string | null; mcpConfigPath?: string }): string[]`
  - `parseCaptureOutput(stdout: string): { ok: boolean; sessionId: string | null; usage: unknown; error: string | null }`
  - `type CaptureTarget = { kind: 'container'; workspaceId: string; cwd: string } | { kind: 'local'; workspaceId: string; launcher: WorkspaceLauncher; workspaceRoot: string }`
  - `runCapture(target: CaptureTarget, args: string[], timeoutMs: number, deps?: CaptureExecDeps): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>`

- [ ] **Step 1: Write the failing tests.** `src/main/claims/captureCommand.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CAPTURE_TOOLS, captureArgs, capturePrompt, parseCaptureOutput } from './captureCommand.js';

describe('captureArgs', () => {
  it('forks with a pre-assigned id, same model, restricted tools, turn cap, json output', () => {
    expect(captureArgs({ prompt: 'P', sessionId: 'live', forkSessionId: 'fork', model: 'claude-opus-5-5' })).toEqual([
      '-p', 'P', '--resume', 'live', '--fork-session', '--session-id', 'fork', '--model', 'claude-opus-5-5',
      '--allowedTools', CAPTURE_TOOLS, '--max-turns', '12', '--output-format', 'json'
    ]);
  });
  it('omits --model when unknown and adds --mcp-config when given', () => {
    const a = captureArgs({ prompt: 'P', sessionId: 'l', forkSessionId: 'f', model: null, mcpConfigPath: '/x/mcp.json' });
    expect(a).not.toContain('--model');
    expect(a.slice(-2)).toEqual(['--mcp-config', '/x/mcp.json']);
  });
});

describe('capturePrompt', () => {
  it('carries the run token, topics, and the rules', () => {
    const p = capturePrompt({ runToken: '01RUN', topTopics: ['mcp-query', 'perf'] });
    expect(p.startsWith('[fleet:knowledge-capture]')).toBe(true);
    expect(p).toContain('capture_run "01RUN"');
    expect(p).toContain('mcp-query, perf');
    expect(p).toMatch(/at most 10/);
    expect(p).toMatch(/secret/i);
  });
});

describe('parseCaptureOutput', () => {
  it('reads session id and usage from claude json output', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fork', total_cost_usd: 0.02, usage: { input_tokens: 5 } });
    expect(parseCaptureOutput(out)).toEqual({ ok: true, sessionId: 'fork', usage: { total_cost_usd: 0.02, usage: { input_tokens: 5 } }, error: null });
  });
  it('reports errors and garbage', () => {
    expect(parseCaptureOutput(JSON.stringify({ is_error: true, subtype: 'error_max_turns', session_id: 'f' })).ok).toBe(false);
    expect(parseCaptureOutput('not json')).toMatchObject({ ok: false, error: expect.stringMatching(/unparseable/) });
  });
});
```

`src/main/claims/captureExec.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
const { runCapture } = await import('./captureExec.js');

describe('runCapture', () => {
  it('container: cds into the session cwd and runs quoted claude args via execScript', async () => {
    const execScript = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'container', workspaceId: 'w1', cwd: '/workspace/app' }, ['-p', "it's"], 300_000, { execScript } as never);
    expect(execScript).toHaveBeenCalledWith('w1', expect.objectContaining({
      automationId: 'knowledge-capture', timeoutMs: 300_000,
      script: `cd '/workspace/app' && exec claude '-p' 'it'"'"'s'`
    }));
  });
  it('wsl: runs claude through wsl.exe --exec with the in-distro cwd', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    const launcher = { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/home/t/.local/bin/claude', interop: true } as never;
    await runCapture({ kind: 'local', workspaceId: 'w2', launcher, workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\t\\repo' }, ['-p', 'x'], 1000,
      { spawnFile, buildEnv: async () => ({}), ensureMcpConfig: async () => undefined, resolveClaude: async () => 'claude' } as never);
    const [file, args] = spawnFile.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('wsl.exe');
    expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/home/t/repo', '--exec', '/bin/bash']);
    expect(args[7]).toBe(`exec '/home/t/.local/bin/claude' '-p' 'x'`);
  });
  it('native: spawns the resolved claude binary in the workspace root', async () => {
    const spawnFile = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }));
    await runCapture({ kind: 'local', workspaceId: 'w3', launcher: { mode: 'native' }, workspaceRoot: '/repo' }, ['-p', 'x'], 1000,
      { spawnFile, buildEnv: async () => ({ A: '1' }), ensureMcpConfig: async () => undefined, resolveClaude: async () => '/usr/bin/claude' } as never);
    expect(spawnFile).toHaveBeenCalledWith('/usr/bin/claude', ['-p', 'x'], expect.objectContaining({ cwd: '/repo', timeoutMs: 1000 }));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npx vitest run src/main/claims/captureCommand.test.ts src/main/claims/captureExec.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `captureCommand.ts`:**

```ts
// Knowledge capture (#483): headless fork command, prompt, and output parsing.
export const CAPTURE_TOOLS = 'mcp__claude-fleet-state__record_claim,mcp__claude-fleet-state__search_claims';

export function capturePrompt(o: { runToken: string; topTopics: string[] }): string {
  return [
    '[fleet:knowledge-capture] You are a background knowledge-capture pass over the conversation above.',
    `Pass capture_run "${o.runToken}" on every record_claim call.`,
    'Record only durable, cross-session-useful knowledge from this conversation: decisions and their reasons, root causes,',
    'non-obvious facts and gotchas, and options that were rejected (with why). Skip task progress, transient state, and anything',
    'only meaningful inside this session. One self-contained claim per call; record at most 10; record nothing if nothing new.',
    'Call search_claims first for each idea and skip or supersede what already exists.',
    o.topTopics.length ? `Prefer existing topic slugs where they fit: ${o.topTopics.join(', ')}.` : '',
    'Never include secrets, tokens, passwords, or connection strings. Do not reply with prose; just make the tool calls.'
  ].filter(Boolean).join('\n');
}

export function captureArgs(o: { prompt: string; sessionId: string; forkSessionId: string; model: string | null; mcpConfigPath?: string }): string[] {
  return [
    '-p', o.prompt, '--resume', o.sessionId, '--fork-session', '--session-id', o.forkSessionId,
    ...(o.model ? ['--model', o.model] : []),
    '--allowedTools', CAPTURE_TOOLS, '--max-turns', '12', '--output-format', 'json',
    ...(o.mcpConfigPath ? ['--mcp-config', o.mcpConfigPath] : [])
  ];
}

export function parseCaptureOutput(stdout: string): { ok: boolean; sessionId: string | null; usage: unknown; error: string | null } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>; }
  catch { return { ok: false, sessionId: null, usage: null, error: `unparseable claude output: ${stdout.slice(0, 200)}` }; }
  const sessionId = typeof j.session_id === 'string' ? j.session_id : null;
  const usage = { total_cost_usd: j.total_cost_usd, usage: j.usage };
  if (j.is_error === true) return { ok: false, sessionId, usage, error: `claude ${String(j.subtype ?? 'error')}` };
  return { ok: true, sessionId, usage, error: null };
}
```

- [ ] **Step 4: Implement `captureExec.ts`:**

```ts
// Knowledge capture (#483): run a headless fork in the session's own backend.
import { execFile } from 'node:child_process';
import { execScript as dockerExecScript } from '../docker.js';
import { buildEnv as localBuildEnv, ensureMcpConfig as localEnsureMcpConfig, resolveClaude as localResolveClaude } from '../local.js';
import { buildWslSpawnEnv, posixQuote, wslInDistroPath, type WorkspaceLauncher } from '../localLauncher.js';
import { readWorkspaceManifest } from '../workspaces.js';

export type CaptureTarget =
  | { kind: 'container'; workspaceId: string; cwd: string }
  | { kind: 'local'; workspaceId: string; launcher: WorkspaceLauncher; workspaceRoot: string };
export interface ExecOutcome { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

export interface CaptureExecDeps {
  execScript: typeof dockerExecScript;
  spawnFile: (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecOutcome>;
  buildEnv: (id: string) => Promise<NodeJS.ProcessEnv>;
  ensureMcpConfig: (id: string, launcher: WorkspaceLauncher) => Promise<string | undefined>;
  resolveClaude: () => Promise<string>;
}

function defaultSpawnFile(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed });
    });
  });
}

const DEFAULT_DEPS: CaptureExecDeps = {
  execScript: dockerExecScript,
  spawnFile: defaultSpawnFile,
  buildEnv: async (id) => {
    const m = await readWorkspaceManifest(id);
    return localBuildEnv(id, { env: m?.env ?? [], authMode: m?.authMode, endpointId: m?.endpointId });
  },
  ensureMcpConfig: localEnsureMcpConfig,
  resolveClaude: localResolveClaude
};

export async function runCapture(target: CaptureTarget, args: string[], timeoutMs: number, deps: CaptureExecDeps = DEFAULT_DEPS): Promise<ExecOutcome> {
  if (target.kind === 'container') {
    const script = `cd ${posixQuote(target.cwd)} && exec claude ${args.map(posixQuote).join(' ')}`;
    return deps.execScript(target.workspaceId, { automationId: 'knowledge-capture', script, env: {}, timeoutMs });
  }
  const env = await deps.buildEnv(target.workspaceId);
  const l = target.launcher;
  if (l.mode === 'wsl') {
    const cmd = `exec ${[l.claudePath, ...args].map(posixQuote).join(' ')}`;
    return deps.spawnFile('wsl.exe', ['-d', l.distro, '--cd', wslInDistroPath(target.workspaceRoot), '--exec', l.shell, '-lic', cmd],
      { cwd: process.cwd(), env: buildWslSpawnEnv(env, []), timeoutMs });
  }
  if (l.mode !== 'native') throw new Error(`knowledge capture does not support launcher mode "${l.mode}" yet`);
  return deps.spawnFile(await deps.resolveClaude(), args, { cwd: target.workspaceRoot, env, timeoutMs });
}
```

Make `resolveClaude` exported from `src/main/local.ts` if it isn't already: add `export` to `async function resolveClaude()` at ~line 286, with no behaviour change. If `buildEnv`'s second parameter type rejects `env: []`, pass `m?.env ?? {}` to match `Workspace['env']`.

- [ ] **Step 5: Run the tests.**

Run: `npx vitest run src/main/claims/captureCommand.test.ts src/main/claims/captureExec.test.ts && npm run typecheck:node`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit.**

```bash
git add src/main/claims/captureCommand.ts src/main/claims/captureExec.ts src/main/claims/captureCommand.test.ts src/main/claims/captureExec.test.ts src/main/local.ts
git commit -m "feat(claims): headless fork command + container/native/WSL capture executors (#483)"
```

---

### Task 9: CaptureScheduler (requires Task 1 = PASS)

**Files:**
- Create: `src/main/claims/captureScheduler.ts`, `src/main/claims/captureForks.ts`
- Test: `src/main/claims/captureScheduler.test.ts`
- Modify: `src/main/index.ts` (start the scheduler after `jsonlWatcher.start`)

**Interfaces:**
- Consumes:
  - `sessionCaptureSignals`, `isAutomationSession` (Task 7)
  - `decideCapture`, `DEFAULT_CAPTURE_POLICY` (Task 7)
  - `CaptureRunStore` (Task 4)
  - `capturePrompt`, `captureArgs`, `parseCaptureOutput` (Task 8)
  - `runCapture`, `CaptureTarget` (Task 8)
  - the `jsonlWatcher` `'ingest'` event `{ workspaceId, sessionId }`
- Produces:
  - `class CaptureScheduler(deps: SchedulerDeps)`, with methods `onIngest(e: { workspaceId: string; sessionId: string }): void`, `drain(): Promise<void>` (tests) and `stop(): void`
  - `captureForks.ts`: `markCaptureFork(id)`, `isCaptureFork(id)`, `loadCaptureForks(ids)`

- [ ] **Step 1: Write the failing test.** `src/main/claims/captureScheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { CaptureScheduler, type SchedulerDeps } from './captureScheduler.js';
import { isCaptureFork, markCaptureFork } from './captureForks.js';

function deps(over: Partial<SchedulerDeps> = {}): SchedulerDeps & { runs: { start: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> } } {
  let n = 0;
  const runs = {
    start: vi.fn(async () => `run${++n}`), finish: vi.fn(async () => undefined),
    lastFor: vi.fn(async () => ({ id: 'old' })), forkSessionIds: vi.fn(async () => [])
  };
  return {
    runs: runs as never,
    signals: () => ({ workspaceId: 'w', model: 'claude-sonnet-5', contextTokens: 130_000, userTurns: 5, compactions: 0 }),
    isAutomation: () => false,
    enabled: async () => true,
    target: async () => ({ kind: 'container', workspaceId: 'w', cwd: '/workspace' }),
    topTopics: async () => [],
    exec: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ session_id: 'x', is_error: false }), stderr: '', timedOut: false })),
    newUuid: (() => { let i = 0; return () => `fork-${++i}`; })(),
    now: () => 0,
    log: () => undefined,
    ...over
  } as never;
}

describe('CaptureScheduler', () => {
  it('starts one capture for a session crossing 60%, registers the fork id, finishes the run', async () => {
    const d = deps();
    const s = new CaptureScheduler(d);
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    s.onIngest({ workspaceId: 'w', sessionId: 's1' });
    await s.drain();
    expect(d.runs.start).toHaveBeenCalledTimes(1);
    expect(d.runs.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', forkSessionId: 'fork-1', trigger: 'ctx-60' }));
    expect(isCaptureFork('fork-1')).toBe(true);
    expect(d.runs.finish).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'done' }));
  });
  it('never captures capture forks, automation sessions, or disabled workspaces', async () => {
    const d = deps({ isAutomation: (id: string) => id === 'auto', enabled: async (ws: string) => ws !== 'off' } as never);
    const s = new CaptureScheduler(d);
    markCaptureFork('forkX');
    s.onIngest({ workspaceId: 'w', sessionId: 'auto' });
    s.onIngest({ workspaceId: 'off', sessionId: 's2' });
    s.onIngest({ workspaceId: 'w', sessionId: 'forkX' });
    await s.drain();
    expect(d.runs.start).not.toHaveBeenCalled();
  });
  it('caps concurrency at 2 and queues the rest', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const exec = vi.fn(async () => { await gate; return { exitCode: 0, stdout: '{"session_id":"x"}', stderr: '', timedOut: false }; });
    const d = deps({ exec } as never);
    const s = new CaptureScheduler(d);
    for (const id of ['a', 'b', 'c']) s.onIngest({ workspaceId: 'w', sessionId: id });
    await new Promise((r) => setTimeout(r, 10));
    expect(exec).toHaveBeenCalledTimes(2);
    release();
    await s.drain();
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it('marks timed-out and failed runs', async () => {
    const d = deps({ exec: vi.fn(async () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true })) } as never);
    const s = new CaptureScheduler(d);
    s.onIngest({ workspaceId: 'w', sessionId: 's9' });
    await s.drain();
    expect(d.runs.finish).toHaveBeenCalledWith('run1', expect.objectContaining({ status: 'timed-out' }));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npx vitest run src/main/claims/captureScheduler.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `captureForks.ts`:**

```ts
// Knowledge capture (#483): session ids of capture forks, so the Sessions rail
// can file them under their own collapsed group and the scheduler never
// captures a capture.
const forks = new Set<string>();
export function markCaptureFork(id: string): void { forks.add(id); }
export function isCaptureFork(id: string): boolean { return forks.has(id); }
export function loadCaptureForks(ids: Iterable<string>): void { for (const id of ids) forks.add(id); }
```

- [ ] **Step 4: Implement `captureScheduler.ts`:**

```ts
// Knowledge capture (#483): ingest-driven background capture. Decides with the
// pure policy, queues per session (newest trigger wins), caps concurrency,
// and books every run in capture_runs.
import type { CaptureSignals } from '../db.js';
import type { CaptureRunStore, CaptureTrigger } from './captureRunStore.js';
import { captureArgs, capturePrompt, parseCaptureOutput } from './captureCommand.js';
import type { CaptureTarget, ExecOutcome } from './captureExec.js';
import { isCaptureFork, markCaptureFork } from './captureForks.js';
import { decideCapture, DEFAULT_CAPTURE_POLICY, type CapturePolicyConfig, type SessionCaptureState } from './capturePolicy.js';

export const MAX_CONCURRENT_CAPTURES = 2;
export const CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const QUEUE_TTL_MS = 15 * 60_000;

export interface SchedulerDeps {
  runs: Pick<CaptureRunStore, 'start' | 'finish' | 'lastFor'>;
  signals: (sessionId: string) => CaptureSignals | null;
  isAutomation: (sessionId: string) => boolean;
  enabled: (workspaceId: string) => Promise<boolean>;
  target: (workspaceId: string) => Promise<CaptureTarget | null>;
  topTopics: (workspaceId: string) => Promise<string[]>;
  exec: (target: CaptureTarget, args: string[], timeoutMs: number) => Promise<ExecOutcome>;
  newUuid: () => string;
  now: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  policy?: CapturePolicyConfig;
}

interface Pending { workspaceId: string; sessionId: string; model: string | null; trigger: CaptureTrigger; queuedAt: number }

export class CaptureScheduler {
  private readonly state = new Map<string, SessionCaptureState>();
  private readonly priorRun = new Map<string, boolean>();
  private readonly queue = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly d: SchedulerDeps) {}

  onIngest(e: { workspaceId: string; sessionId: string }): void {
    if (this.stopped || isCaptureFork(e.sessionId) || this.checking.has(e.sessionId)) return;
    this.checking.add(e.sessionId);
    const p = this.consider(e).catch((err) => this.d.log('capture-consider-failed', { error: String(err) }))
      .finally(() => { this.checking.delete(e.sessionId); this.active.delete(p); });
    this.active.add(p);
  }

  private async consider(e: { workspaceId: string; sessionId: string }): Promise<void> {
    if (this.d.isAutomation(e.sessionId) || !(await this.d.enabled(e.workspaceId))) return;
    const sig = this.d.signals(e.sessionId);
    if (!sig) return;
    if (!this.priorRun.has(e.sessionId)) this.priorRun.set(e.sessionId, !!(await this.d.runs.lastFor(e.sessionId)));
    const { trigger, next } = decideCapture(sig, this.state.get(e.sessionId), this.priorRun.get(e.sessionId) ?? true,
      this.d.policy ?? DEFAULT_CAPTURE_POLICY, this.d.now());
    this.state.set(e.sessionId, next);
    if (!trigger) return;
    this.priorRun.set(e.sessionId, true);
    this.queue.set(e.sessionId, { workspaceId: e.workspaceId, sessionId: e.sessionId, model: sig.model, trigger, queuedAt: this.d.now() });
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.inFlight.size < MAX_CONCURRENT_CAPTURES) {
      const next = [...this.queue.values()].find((p) => !this.inFlight.has(p.sessionId));
      if (!next) return;
      this.queue.delete(next.sessionId);
      if (this.d.now() - next.queuedAt > QUEUE_TTL_MS) continue;
      this.inFlight.add(next.sessionId);
      const p = this.run(next).finally(() => { this.inFlight.delete(next.sessionId); this.active.delete(p); this.pump(); });
      this.active.add(p);
    }
  }

  private async run(p: Pending): Promise<void> {
    const target = await this.d.target(p.workspaceId);
    if (!target) return;
    const forkSessionId = this.d.newUuid();
    markCaptureFork(forkSessionId);
    const runId = await this.d.runs.start({ workspaceId: p.workspaceId, sessionId: p.sessionId, forkSessionId, trigger: p.trigger, now: this.d.now() });
    try {
      const prompt = capturePrompt({ runToken: runId, topTopics: await this.d.topTopics(p.workspaceId) });
      const out = await this.d.exec(target, captureArgs({ prompt, sessionId: p.sessionId, forkSessionId, model: p.model }), CAPTURE_TIMEOUT_MS);
      if (out.timedOut) {
        await this.d.runs.finish(runId, { status: 'timed-out', usage: null, error: `timed out after ${CAPTURE_TIMEOUT_MS / 1000}s`, now: this.d.now() });
        return;
      }
      const parsed = parseCaptureOutput(out.stdout);
      await this.d.runs.finish(runId, {
        status: parsed.ok && out.exitCode === 0 ? 'done' : 'failed', usage: parsed.usage,
        error: parsed.error ?? (out.exitCode === 0 ? null : `exit ${out.exitCode}: ${out.stderr.slice(0, 300)}`), now: this.d.now()
      });
    } catch (err) {
      await this.d.runs.finish(runId, { status: 'failed', usage: null, error: String(err), now: this.d.now() });
    }
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  stop(): void { this.stopped = true; this.queue.clear(); }
}
```

- [ ] **Step 5: Run the tests.**

Run: `npx vitest run src/main/claims/captureScheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it in `src/main/index.ts`.** Directly after `await perfSpanAsync('claude_fleet.boot.jsonl_watcher_start', …)`, add the following, reusing the `captureRuns` instance from Task 6 by hoisting it to the enclosing scope:

```ts
    if (inboxStore && captureRuns) {
      loadCaptureForks(await captureRuns.forkSessionIds());
      const scheduler = new CaptureScheduler({
        runs: captureRuns,
        signals: (id) => sessionCaptureSignals(id),
        isAutomation: (id) => isAutomationSession(id),
        enabled: async (ws) => (await getKnowledgeCapture()) && (await readWorkspaceManifest(ws))?.knowledgeCapture !== false,
        target: async (ws) => {
          const m = await readWorkspaceManifest(ws);
          if (!m) return null;
          if (m.kind === 'container') return { kind: 'container', workspaceId: ws, cwd: `/workspace/${m.workspaceSubdir}`.replace(/\/$/, '') || '/workspace' };
          return { kind: 'local', workspaceId: ws, launcher: m.launcher ?? { mode: 'native' }, workspaceRoot: m.workspaceRoot };
        },
        topTopics: async (ws) => (await claimService.search(ws, { query: 'fleet', limit: 20 })).results.flatMap((r) => r.topics).slice(0, 15),
        exec: (t, args, timeoutMs) => runCapture(t, args, timeoutMs),
        newUuid: () => randomUUID(),
        now: () => Date.now(),
        log: (message, extra) => logError({ source: 'main', level: 'info', type: 'knowledge-capture', message, extra })
      });
      jsonlWatcher.on('ingest', (e) => scheduler.onIngest(e));
    }
```

Imports to add: `CaptureScheduler` from `./claims/captureScheduler.js`; `loadCaptureForks` from `./claims/captureForks.js`; `runCapture` from `./claims/captureExec.js`; `sessionCaptureSignals`, `isAutomationSession` from `./db.js`; `getKnowledgeCapture` from `./config.js` (Task 10 adds it, so this step lands with Task 10 if done out of order); `randomUUID` from `node:crypto`. Declare `let captureRuns: CaptureRunStore | null = null; let claimService: ClaimService | null = null;` above the Task 6 block and assign them there, so this block can reference both. Inside it, use `claimService!` only after the `inboxStore && captureRuns` guard.

- [ ] **Step 7: Run the gates and commit.**

Run: `npx vitest run src/main/claims/ && npm run typecheck:node`
Expected: PASS and clean.

```bash
git add src/main/claims/captureScheduler.ts src/main/claims/captureForks.ts src/main/claims/captureScheduler.test.ts src/main/index.ts
git commit -m "feat(claims): background capture scheduler — policy, queue, cap 2, timeout, run bookkeeping (#483)"
```

---

### Task 10: Switches (per-workspace + global)

**Files:**
- Modify: `src/main/workspaces.ts` (`WorkspaceSpec` ~145–200; `readWorkspaceManifest` allowlist ~289–340)
- Modify: `src/main/workspaceMerge.ts:66-70` (carry the field like `inbox`)
- Modify: `src/main/config.ts` (`AppConfig` ~77; `read()` ~174; getter/setter)
- Modify: `src/main/ipc.ts` (`config:get` ~1669 add `knowledgeCapture`; new `config:setKnowledgeCapture` beside `config:setPerfTelemetry` ~1744)
- Modify: `src/preload/index.ts` (`config.get` type ~600–612; `setKnowledgeCapture` beside `setPerfTelemetry` ~645)
- Modify: `src/renderer/src/workspaceLifecycle.ts:6` (type), `src/renderer/src/components/WorkspaceForm.tsx` (state ~273, payload ~536, checkbox ~1376), `src/renderer/src/App.tsx:1289` (save path)
- Modify: `src/renderer/src/components/SettingsModal.tsx` (Diagnostics ~695–740; load ~132; save ~234)
- Test: `src/main/config.test.ts`, `src/main/workspaces.test.ts` (or the existing manifest test file that covers `readWorkspaceManifest`)
- Modify: `docs/SPEC.md` (manifest fields, config.json keys, IPC channel)

**Interfaces:**
- Produces:
  - `WorkspaceSpec.knowledgeCapture?: boolean` (absent = on)
  - `getKnowledgeCapture(): Promise<boolean>` (absent = on), `setKnowledgeCapture(enabled: boolean): Promise<void>`
  - IPC `config:setKnowledgeCapture(enabled: boolean) → void`
  - `config:get` result gains `knowledgeCapture: boolean`

- [ ] **Step 1: Write the failing tests.** In `src/main/config.test.ts`, following the file's existing `vi.mock('electron')` + dynamic import pattern:

```ts
it('knowledgeCapture defaults on and persists an explicit false', async () => {
  const { getKnowledgeCapture, setKnowledgeCapture, _resetConfigCacheForTests } = await import('./config.js');
  _resetConfigCacheForTests();
  expect(await getKnowledgeCapture()).toBe(true);
  await setKnowledgeCapture(false);
  _resetConfigCacheForTests();
  expect(await getKnowledgeCapture()).toBe(false);
});
```

In the manifest test file:

```ts
it('round-trips knowledgeCapture: false and omits it when absent', async () => {
  const spec = { ...baseSpec(), knowledgeCapture: false };
  await writeWorkspaceManifest(spec);
  expect((await readWorkspaceManifest(spec.id))?.knowledgeCapture).toBe(false);
  const plain = baseSpec(); await writeWorkspaceManifest(plain);
  expect((await readWorkspaceManifest(plain.id))?.knowledgeCapture).toBeUndefined();
});
```

(Use the file's existing spec fixture helper in place of `baseSpec()`. Find it with `grep -n "function .*Spec\|const .*spec = {" src/main/workspaces.test.ts`.)

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npx vitest run src/main/config.test.ts src/main/workspaces.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`src/main/config.ts`: add `knowledgeCapture?: boolean;` to `AppConfig`. In `read()`, add `knowledgeCapture: typeof parsed.knowledgeCapture === 'boolean' ? parsed.knowledgeCapture : undefined,`. Then:

```ts
/** Background knowledge capture (#483) — default on; only an explicit false disables it. */
export async function getKnowledgeCapture(): Promise<boolean> {
  return (await read()).knowledgeCapture !== false;
}
export async function setKnowledgeCapture(enabled: boolean): Promise<void> {
  const cfg = await read(); await write({ ...cfg, knowledgeCapture: enabled });
}
```

`src/main/workspaces.ts`: add `knowledgeCapture?: boolean;` to `WorkspaceSpec` with the comment `/** Background knowledge capture (#483); absent = on. */`. In `readWorkspaceManifest`'s returned object add `...(parsed.knowledgeCapture === false ? { knowledgeCapture: false } : {}),`. Carry it in `workspaceMerge.ts` exactly as `inbox` is carried at lines 66–70.

`src/main/ipc.ts`: in the `config:get` result object add `knowledgeCapture: await getKnowledgeCapture(),`. Beside `config:setPerfTelemetry`:

```ts
  ipcMain.handle('config:setKnowledgeCapture', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('config:setKnowledgeCapture expects a boolean');
    return setKnowledgeCapture(enabled);
  });
```

`src/preload/index.ts`: add `knowledgeCapture: boolean` to the `config.get` return type and `setKnowledgeCapture: (enabled: boolean): Promise<void> => ipcRenderer.invoke('config:setKnowledgeCapture', enabled),` beside `setPerfTelemetry`.

`WorkspaceForm.tsx`: add `knowledgeCapture?: boolean` to the payload type (lines 87–98), and the state `const [knowledgeCapture, setKnowledgeCapture] = useState(initial?.knowledgeCapture !== false);`. In the submit payload, add `...(knowledgeCapture ? {} : { knowledgeCapture: false })`. In the "Inbox & automations" disclosure, after the `exposeSkills` row:

```tsx
<label className="committee-reachable-row">
  <input type="checkbox" checked={knowledgeCapture} onChange={(e) => setKnowledgeCapture(e.target.checked)} disabled={busy} />
  <span>Background knowledge capture</span>
</label>
<p className="form-hint">Periodically runs a hidden fork of each session that records durable decisions, root causes and gotchas as fleet claims.</p>
```

Add `knowledgeCapture?: boolean` to the renderer workspace type in `workspaceLifecycle.ts:6`, and pass `knowledgeCapture: submit.knowledgeCapture` next to `inbox: submit.inbox` in `App.tsx:1289`.

`SettingsModal.tsx`: load `knowledgeCapture` from `window.api.config.get()` next to `perfTelemetry` (~132) into a `useState(true)`. In the Diagnostics section add a row:

```tsx
<div className="setting-row">
  <div className="setting-row-text">
    <label className="setting-title" htmlFor="knowledge-capture">Background knowledge capture</label>
    <p className="setting-desc">Global switch for capture forks (per-workspace switches still apply).</p>
  </div>
  <input id="knowledge-capture" type="checkbox" checked={knowledgeCapture}
    onChange={async (e) => { const v = e.target.checked; setKnowledgeCaptureState(v); await window.api.config.setKnowledgeCapture(v); }} />
</div>
```

(`setKnowledgeCaptureState` is the `useState` setter name, chosen to avoid clashing with the API method.)

`docs/SPEC.md`: add `knowledgeCapture` to the manifest field list and the config.json keys (with the default-on semantics), and add the `config:setKnowledgeCapture` IPC channel.

- [ ] **Step 4: Run the gates.**

Run: `npx vitest run src/main/config.test.ts src/main/workspaces.test.ts && npm run typecheck:node && npm run typecheck:web`
Expected: PASS; both typechecks clean.

- [ ] **Step 5: Commit.**

```bash
git add src/main/workspaces.ts src/main/workspaceMerge.ts src/main/config.ts src/main/ipc.ts src/preload/index.ts src/renderer/src docs/SPEC.md src/main/config.test.ts src/main/workspaces.test.ts
git commit -m "feat(claims): per-workspace + global knowledge-capture switches, default on (#483)"
```

---

### Task 11: Sessions rail "Knowledge capture" group, final SPEC, verification, PR

**Files:**
- Modify: `src/main/ipc.ts` (`sessions:list` ~1254: add `capture`)
- Modify: `src/preload/index.ts:80` (`SessionListItem.capture: boolean`)
- Modify: `src/renderer/src/sessionsView.ts` (add `splitCapture`)
- Modify: `src/renderer/src/components/SessionsPane.tsx` (~101 state, ~180 split, ~195 counts, ~456 group)
- Test: `src/renderer/src/sessionsView.test.ts`
- Modify: `docs/SPEC.md` (sessions:list field; Sessions rail group; a "Knowledge capture" subsection condensing spec §5)

**Interfaces:**
- Consumes: `isCaptureFork` (Task 9).
- Produces: `SessionListItem.capture: boolean`; `splitCapture<T extends { capture?: boolean }>(rows): { capture: T[]; rest: T[] }`.

- [ ] **Step 1: Write the failing test.** Append to `src/renderer/src/sessionsView.test.ts` (and add `splitCapture` to its import):

```ts
describe('splitCapture', () => {
  it('moves capture forks out, preserving order', () => {
    const rows = [{ id: 'a' }, { id: 'f1', capture: true }, { id: 'b', capture: false }, { id: 'f2', capture: true }];
    const { capture, rest } = splitCapture(rows);
    expect(capture.map((s) => s.id)).toEqual(['f1', 'f2']);
    expect(rest.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`sessionsView.ts`, after `splitHeadless`:

```ts
/** Pull knowledge-capture forks (#483) out of the Recent rows into their own
 *  collapsed group, like automation runs. */
export function splitCapture<T extends { capture?: boolean }>(rows: readonly T[]): { capture: T[]; rest: T[] } {
  const capture: T[] = [];
  const rest: T[] = [];
  for (const s of rows) (s.capture ? capture : rest).push(s);
  return { capture, rest };
}
```

`src/preload/index.ts` `SessionListItem`: add `/** A background knowledge-capture fork (#483), not a terminal tab. */ capture: boolean;`.

`src/main/ipc.ts` `sessions:list`: on each returned row object add `capture: isCaptureFork(r.id),` (import `isCaptureFork` from `./claims/captureForks.js`).

`SessionsPane.tsx`:
- Add `const [captureExpanded, setCaptureExpanded] = useState(false);` beside `headlessExpanded`.
- After the `splitHeadless` line (~180), add:

```tsx
  const { capture: captureRows, rest: recentRowsNoCapture } = splitCapture(recentRows);
```

- Use `recentRowsNoCapture` everywhere `recentRows` was used after that line (the `limitSessions` call for `recentShown`).
- Add `const captureShown = bypassLimits ? captureRows : limitSessions(captureRows, limitOpts, Date.now());` and `const showCapture = captureExpanded || bypassLimits;`.
- For the "All · N" count at ~195, apply `splitCapture(allSplit.rest).rest` wherever `allSplit.rest` feeds the count.
- After the automation-runs block (~456) render:

```tsx
            {captureShown.length > 0 && (
              <li className="session-group-label recent">
                <button
                  className="session-group-toggle"
                  aria-expanded={showCapture}
                  onClick={() => setCaptureExpanded((v) => !v)}
                  title={showCapture ? 'Hide knowledge capture runs' : 'Show knowledge capture runs'}
                >
                  <span className={`acc-chev ${showCapture ? 'open' : ''}`} aria-hidden>▾</span>
                  Knowledge capture · {captureShown.length}
                </button>
                <span className="session-group-line" />
              </li>
            )}
            {showCapture && captureShown.map(renderRow)}
```

Add `splitCapture` to the `../sessionsView` import at line 19.

`docs/SPEC.md`:
- Add `capture` to the `sessions:list` item fields.
- Add the "Knowledge capture" group to the Sessions rail description.
- Add a **Knowledge capture** subsection summarizing spec §5: triggers 60%/85%/30 turns, guards, cap 2, 5-minute timeout, fork command with restricted tools, `capture_runs`, switches.

- [ ] **Step 4: Run the full gate.**

Run:
```bash
npx vitest run src/renderer/src/sessionsView.test.ts
npm run typecheck:node
npm run typecheck:web
npx vitest run
```
Expected: all PASS; both typechecks clean. Record the full-suite totals for the PR body.

- [ ] **Step 5: Commit, push, open the PR.**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src docs/SPEC.md
git commit -m "feat(claims): Knowledge capture group in the Sessions rail + SPEC (#483)"
git push -u origin HEAD
gh pr create --title "feat: knowledge claims phase 1 — record/search + background capture (#483)" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-11-04-knowledge-claims-design.md (closes #483; supersedes #206).

## What
- inbox.db v6: claims, claim_sources, claim_vectors, claims_fts (FTS5), capture_runs
- MCP: record_claim / search_claims / retract_claim; standing rule as initialize `instructions`; search_transcripts no longer advertises mark_useful
- Background capture: headless `--resume --fork-session --session-id` runs at 60%/85% context fill and every 30 turns; tools limited to the claims tools; cap 2 concurrent; 5 min timeout; capture_runs bookkeeping
- Switches: per-workspace + global, default on; Sessions rail "Knowledge capture" group

## Verification
- Feasibility gate: see docs/superpowers/plans/2026-11-04-knowledge-claims-gate-results.md
- typecheck:node + typecheck:web clean (run separately)
- vitest: <totals from Step 4>
- Not run in-container: Electron app, Playwright e2e, real forks on the Windows host

## Host eyeball checklist
- [ ] A fresh session's first turn shows the standing rule (MCP instructions surfaced)
- [ ] An agent can record_claim and another workspace's agent finds it via search_claims
- [ ] A long session gets a capture run at ~60% context; a Knowledge capture group appears in the Sessions rail; claims land with via=capture
- [ ] Unchecking the workspace switch / the global switch stops captures

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:**
  - §1 data model → Task 2/4
  - §2 tools → Task 5/6
  - §3 attribution → Task 5 (capture token) / NULL for agents
  - §4 standing rule → Task 6
  - §5 capture → Tasks 7–9, 11
  - switches → Task 10
  - §6 mark_useful → Task 6 Step 5 (closing #206 is a manual step after merge)
  - §7 security → Task 6 Step 9
  - feasibility gate → Task 1
  - measurement → `capture_runs` usage/claims (Task 4/9)
  - perf spans (`claude_fleet.claims.*`, `claude_fleet.capture.run`) were left out for YAGNI and noted for a follow-up. The IPC/MCP wrapper spans already cover tool calls via `mcp-slow-call`.
- **Deviation from the spec:** `claims_fts` is a standalone FTS5 table rather than external-content (Task 2 note). The fork uses a pre-assigned `--session-id`, which the Task 1 gate verifies.
- **Type names used across tasks:** `ClaimStore`, `CaptureRunStore`, `ClaimService`, `CaptureTrigger`, `CaptureSignals`, `SessionCaptureState`, `CaptureTarget`, `ExecOutcome`, `SchedulerDeps`, `isCaptureFork`. Each is defined once and imported by these names.
