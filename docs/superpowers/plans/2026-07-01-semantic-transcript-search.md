# Semantic Transcript Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents (and the committee manager) local, on-host semantic search over past transcript content, exposed as one scoped `search_transcripts` MCP tool — without weakening cross-workspace confinement.

**Architecture:** The `JsonlWatcher` already ingests every JSONL line into SQLite (`events`). We hang an async embedding pipeline off its `'ingest'` event: turn text is embedded by a local WASM model and stored as Float32 BLOBs in a new `embeddings` table in `state.db`. A new scoped MCP tool embeds the query and brute-force cosine-ranks candidate rows filtered by `allowedWorkspaces`.

**Tech Stack:** Electron main (Node), `better-sqlite3`, `@huggingface/transformers` (native `onnxruntime-node` backend), `bge-small-en-v1.5` (384-dim), vitest.

## Global Constraints

- **Native embedding backend (revised decision).** `@huggingface/transformers` in Node hard-requires the native `onnxruntime-node` — there is no WASM-only path in the main process. This is accepted: `onnxruntime-node` (prebuilt per platform) joins the cross-build native modules (better-sqlite3, keytar, node-pty). Its `.node` binaries must be `asarUnpack`ed. The transitive `sharp` dep is image-only and unused → **exclude it from packaging** (electron-builder `files: "!**/node_modules/sharp/**"`).
- **Embedding model id:** `Xenova/bge-small-en-v1.5`. **Dim:** `384`. Vectors are **L2-normalized at embed time**, so cosine similarity = dot product.
- **Vector storage:** Float32 little-endian BLOB in SQLite; brute-force cosine in JS. No `sqlite-vec`.
- **Schema migration is `user_version = 6`** (v5 = `errors` table already exists). Additive only — do NOT drop `events`/`sessions`.
- **Every read is scoped by `allowedWorkspaces`** using the existing `inClause` pattern. The tool never returns a row outside the caller's allowed set.
- **`@huggingface/transformers` goes in `dependencies`** (not devDependencies) so electron-builder packs it.
- TDD, DRY, YAGNI, frequent commits. Run one test file with `npx vitest run <path>`.
- **Update `docs/SPEC.md` in this PR** (observability schema, §11 Fleet-state MCP tool list, runner JSONL contract) per `.claude/rules/spec-maintenance.md`.

**Phasing:** Tasks 1–9 = **Phase 1**, a fully functional turn-level search (shippable alone). Task 10 = **Phase 2**, per-session summaries via a runner hook (separable follow-on PR; the summary *ingest + embed* path lands in Phase 1 so the pipe is ready). Task 11 = docs + final gate.

---

### Task 1: Add the embedding dependency and verify it loads in Node

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `electron-builder.yml` (asarUnpack for the model runtime)
- Create (scratch, deleted at end of task): `scratch-embed-check.mjs`

**Interfaces:**
- Produces: the `@huggingface/transformers` package available to main-process modules; `pipeline('feature-extraction', ...)` proven to run on the WASM backend in this environment.

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install @huggingface/transformers@^3
```
Expected: added under `dependencies` in `package.json`. Confirm it is NOT in devDependencies and that `onnxruntime-node` was NOT pulled in as a direct dep:
```bash
jq '.dependencies["@huggingface/transformers"], (.dependencies["onnxruntime-node"] // "absent (good)")' package.json
```

- [ ] **Step 2: Write a scratch load+embed check**

Create `scratch-embed-check.mjs`:
```js
import { pipeline, env } from '@huggingface/transformers';
env.allowRemoteModels = true;           // download weights once on first run
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
const out = await extractor(['hello world', 'goodbye'], { pooling: 'mean', normalize: true });
const rows = out.tolist();
const norm = Math.sqrt(rows[0].reduce((s, x) => s + x * x, 0));
console.log('dim=', rows[0].length, 'rows=', rows.length, 'norm≈', norm.toFixed(4));
```

- [ ] **Step 3: Run it and confirm shape + normalization**

Run: `node scratch-embed-check.mjs`
Expected (first run downloads the model, then): `dim= 384 rows= 2 norm≈ 1.0000`
If it errors trying to load `onnxruntime-node`, the WASM fallback isn't engaging — ensure `onnxruntime-node` is not installed; transformers.js uses `onnxruntime-web` (WASM) when the node binding is absent.

- [ ] **Step 4: Add asarUnpack (native onnx binaries) + exclude sharp**

In `electron-builder.yml`, merge into any existing `asarUnpack:` list:
```yaml
asarUnpack:
  - "**/node_modules/@huggingface/transformers/**"
  - "**/node_modules/onnxruntime-node/**"
```
And exclude the unused image lib from the package (add to / create the `files:` list):
```yaml
files:
  - "!**/node_modules/sharp/**"
```
Rationale: `onnxruntime-node`'s `.node` binaries can't be loaded from inside the asar archive; `sharp` is image-only and unused by text feature-extraction.

- [ ] **Step 5: Remove the scratch file and commit**

```bash
rm scratch-embed-check.mjs
git add package.json package-lock.json electron-builder.yml
git commit -m "build: add @huggingface/transformers (WASM) for local embeddings"
```

---

### Task 2: Pure vector codec + similarity (`vectors.ts`)

**Files:**
- Create: `src/main/vectors.ts`
- Test: `src/main/vectors.test.ts`

**Interfaces:**
- Produces:
  - `export const EMBED_MODEL_ID = 'Xenova/bge-small-en-v1.5'`
  - `export const EMBED_DIM = 384`
  - `export function encodeVector(v: Float32Array): Buffer`
  - `export function decodeVector(buf: Buffer): Float32Array`
  - `export function dot(a: Float32Array, b: Float32Array): number`
  - `export function topK(query: Float32Array, candidates: { vec: Float32Array }[], k: number): { index: number; score: number }[]` — returns indices into `candidates`, highest score first.

- [ ] **Step 1: Write the failing test**

`src/main/vectors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, dot, topK, EMBED_DIM } from './vectors.js';

describe('vectors', () => {
  it('round-trips a Float32 vector through BLOB encode/decode', () => {
    const v = Float32Array.from([0.5, -0.25, 1, 0]);
    const back = decodeVector(encodeVector(v));
    expect(Array.from(back)).toEqual([0.5, -0.25, 1, 0]);
  });

  it('decodeVector copies (independent of the source buffer)', () => {
    const v = Float32Array.from([1, 2, 3]);
    const buf = encodeVector(v);
    const back = decodeVector(buf);
    buf.fill(0);
    expect(Array.from(back)).toEqual([1, 2, 3]);
  });

  it('dot of unit vectors is cosine similarity', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0]);
    const c = Float32Array.from([0, 1]);
    expect(dot(a, b)).toBeCloseTo(1);
    expect(dot(a, c)).toBeCloseTo(0);
  });

  it('topK ranks by descending score and respects k', () => {
    const q = Float32Array.from([1, 0]);
    const cands = [
      { vec: Float32Array.from([0, 1]) },   // 0.0
      { vec: Float32Array.from([1, 0]) },   // 1.0
      { vec: Float32Array.from([0.7071, 0.7071]) }, // ~0.707
    ];
    const out = topK(q, cands, 2);
    expect(out.map((r) => r.index)).toEqual([1, 2]);
    expect(out[0].score).toBeCloseTo(1);
  });

  it('exposes the model identity constants', () => {
    expect(EMBED_DIM).toBe(384);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/vectors.test.ts`
Expected: FAIL — `Cannot find module './vectors.js'`.

- [ ] **Step 3: Implement `vectors.ts`**

```ts
// Pure vector helpers shared by the indexer (write side) and the MCP search
// tool (read side). No transformers/db imports here so mcpServer can use it
// without pulling in the model runtime.

export const EMBED_MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;

/** Float32Array → little-endian BLOB. */
export function encodeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** BLOB → Float32Array. Copies, so the result is independent of `buf`. */
export function decodeVector(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Dot product. For L2-normalized vectors this equals cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function topK(
  query: Float32Array,
  candidates: { vec: Float32Array }[],
  k: number,
): { index: number; score: number }[] {
  const scored = candidates.map((c, index) => ({ index, score: dot(query, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/vectors.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/vectors.ts src/main/vectors.test.ts
git commit -m "feat(search): pure vector codec + cosine/topK helpers"
```

---

### Task 3: Schema migration v6 + embedding/summary DB helpers

**Files:**
- Modify: `src/main/db.ts` (add migration block after the `< 5` block; add helpers near the other query helpers)
- Test: `src/main/dbEmbeddings.test.ts`

**Interfaces:**
- Consumes: `openDb`, existing `events`/`sessions` schema, `encodeVector` (Task 2).
- Produces:
  - Tables `embeddings` and `session_summaries` (see spec §Data model).
  - `export interface EmbeddingInsert { workspaceId: string; sessionId: string; kind: 'turn' | 'summary'; refEventId: number | null; ts: number | null; text: string; modelId: string; dim: number; vec: Buffer; dedupKey: string }`
  - `export function insertEmbedding(row: EmbeddingInsert): boolean` — INSERT OR IGNORE, returns whether inserted.
  - `export interface UnembeddedTurn { id: number; workspaceId: string; ts: number | null; rawJsonl: string }`
  - `export function unembeddedTurnEvents(sessionId: string, modelId: string, limit?: number): UnembeddedTurn[]`
  - `export function maxEventId(sessionId: string): number` — 0 if none.

- [ ] **Step 1: Write the failing test**

`src/main/dbEmbeddings.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, insertEmbedding, unembeddedTurnEvents, maxEventId } from './db.js';
import { encodeVector, EMBED_MODEL_ID } from './vectors.js';

let dir: string;
const WS = '01WS';
const SES = 'ses-1';

function userLine(id: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid: id, timestamp: '2026-07-01T00:00:00Z', message: { content: text } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-emb-'));
  openDb(dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('embeddings schema + helpers', () => {
  it('lists user/assistant events that have no turn embedding yet', () => {
    ingestLine(WS, SES, userLine('u1', 'hello there'));
    ingestLine(WS, SES, userLine('u2', 'second message'));
    const pending = unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(pending.length).toBe(2);
    expect(pending[0].rawJsonl).toContain('hello there');
  });

  it('insertEmbedding removes a turn from the pending set and dedupes', () => {
    ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const row = {
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text: 'hello there', modelId: EMBED_MODEL_ID, dim: 3,
      vec: encodeVector(Float32Array.from([1, 0, 0])), dedupKey: `t${ev.id}`,
    };
    expect(insertEmbedding(row)).toBe(true);
    expect(insertEmbedding(row)).toBe(false); // dedup
    expect(unembeddedTurnEvents(SES, EMBED_MODEL_ID).length).toBe(0);
  });

  it('maxEventId returns the largest event id for a session', () => {
    ingestLine(WS, SES, userLine('u1', 'a'));
    ingestLine(WS, SES, userLine('u2', 'b'));
    expect(maxEventId(SES)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/dbEmbeddings.test.ts`
Expected: FAIL — `insertEmbedding is not a function` (or migration/table missing).

- [ ] **Step 3: Add the migration block**

In `src/main/db.ts` `migrate()`, after the `user_version = 5` block and before the closing `}`:
```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 6) {
    // Semantic transcript search (rebuildable from JSONL — additive).
    d.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,          -- 'turn' | 'summary'
        ref_event_id INTEGER,
        ts           INTEGER,
        text         TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        vec          BLOB NOT NULL,
        dedup_key    TEXT NOT NULL,
        UNIQUE(session_id, kind, dedup_key)
      );
      CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
      CREATE INDEX idx_emb_session   ON embeddings(session_id);
      CREATE INDEX idx_emb_ref_event ON embeddings(ref_event_id);

      CREATE TABLE session_summaries (
        session_id          TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        source_max_event_id INTEGER NOT NULL,
        model               TEXT,
        generated_at        INTEGER NOT NULL
      );
    `);
    d.pragma('user_version = 6');
  }
```

- [ ] **Step 4: Add the helpers**

In `src/main/db.ts`, add near the other query helpers (import `encodeVector` is NOT needed here — callers pass a `Buffer`):
```ts
export interface EmbeddingInsert {
  workspaceId: string;
  sessionId: string;
  kind: 'turn' | 'summary';
  refEventId: number | null;
  ts: number | null;
  text: string;
  modelId: string;
  dim: number;
  vec: Buffer;
  dedupKey: string;
}

export function insertEmbedding(row: EmbeddingInsert): boolean {
  const d = openDbOrThrow();
  const info = d
    .prepare(`
      INSERT OR IGNORE INTO embeddings
        (workspace_id, session_id, kind, ref_event_id, ts, text, model_id, dim, vec, dedup_key)
      VALUES (@workspaceId, @sessionId, @kind, @refEventId, @ts, @text, @modelId, @dim, @vec, @dedupKey)
    `)
    .run(row);
  return info.changes > 0;
}

export interface UnembeddedTurn {
  id: number;
  workspaceId: string;
  ts: number | null;
  rawJsonl: string;
}

/** user/assistant events in a session with no 'turn' embedding for `modelId`. */
export function unembeddedTurnEvents(sessionId: string, modelId: string, limit = 200): UnembeddedTurn[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT e.id AS id, e.workspace_id AS workspaceId, e.ts AS ts, e.raw_jsonl AS rawJsonl
      FROM events e
      LEFT JOIN embeddings em
        ON em.ref_event_id = e.id AND em.kind = 'turn' AND em.model_id = ?
      WHERE e.session_id = ? AND e.type IN ('user', 'assistant') AND em.id IS NULL
      ORDER BY e.id ASC
      LIMIT ?
    `)
    .all(modelId, sessionId, limit) as UnembeddedTurn[];
  return rows;
}

export function maxEventId(sessionId: string): number {
  const d = openDbOrThrow();
  const row = d.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE session_id = ?`).get(sessionId) as { m: number };
  return row.m;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/dbEmbeddings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/db.ts src/main/dbEmbeddings.test.ts
git commit -m "feat(search): v6 migration (embeddings + session_summaries) + DB helpers"
```

---

### Task 4: Local embedder (`embeddings.ts`)

**Files:**
- Create: `src/main/embeddings.ts`
- Test: `src/main/embeddings.test.ts` (real model — downloads weights on first run)

**Interfaces:**
- Consumes: `@huggingface/transformers`, `EMBED_MODEL_ID`, `EMBED_DIM`, `l2` (local).
- Produces:
  - `export function makeEmbedder(cacheDir: string): (texts: string[]) => Promise<Float32Array[]>` — lazily loads the model (once), returns normalized 384-dim vectors. Empty input → `[]`.

- [ ] **Step 1: Write the failing test**

`src/main/embeddings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEmbedder } from './embeddings.js';
import { EMBED_DIM, dot } from './vectors.js';

describe('embeddings (real model)', () => {
  it('returns normalized 384-d vectors; related text scores higher than unrelated', async () => {
    const embed = makeEmbedder(mkdtempSync(join(tmpdir(), 'cf-model-')));
    const [q, near, far] = await embed([
      'how do I fix the broker PTY reconnect bug',
      'debugging the broker pseudo-terminal reconnection issue',
      'a recipe for banana bread',
    ]);
    expect(q.length).toBe(EMBED_DIM);
    expect(Math.sqrt(dot(q, q))).toBeCloseTo(1, 2);
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  }, 120_000); // first run downloads the model

  it('returns [] for empty input', async () => {
    const embed = makeEmbedder(mkdtempSync(join(tmpdir(), 'cf-model-')));
    expect(await embed([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/embeddings.test.ts`
Expected: FAIL — `Cannot find module './embeddings.js'`.

- [ ] **Step 3: Implement `embeddings.ts`**

```ts
// Local, on-host embedding model (native onnxruntime-node backend). Transcript
// text never leaves the machine. Lazy-loads the model once per process.
import { EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export function makeEmbedder(cacheDir: string): (texts: string[]) => Promise<Float32Array[]> {
  let extractorP: Promise<Extractor> | null = null;

  async function load(): Promise<Extractor> {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;          // cache weights under <userData>
    env.allowRemoteModels = true;     // fetch once on first use
    return (await pipeline('feature-extraction', EMBED_MODEL_ID)) as unknown as Extractor;
  }

  return async function embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!extractorP) extractorP = load();
    const extractor = await extractorP;
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist().map((row) => {
      const v = new Float32Array(EMBED_DIM);
      for (let i = 0; i < EMBED_DIM; i++) v[i] = row[i] ?? 0;
      return v;
    });
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/embeddings.test.ts`
Expected: PASS (2 tests; the first is slow on a cold cache).

- [ ] **Step 5: Commit**

```bash
git add src/main/embeddings.ts src/main/embeddings.test.ts
git commit -m "feat(search): local WASM embedder (bge-small-en-v1.5)"
```

---

### Task 5: Turn extraction + indexer write path (`transcriptIndex.ts`)

**Files:**
- Create: `src/main/transcriptIndex.ts`
- Test: `src/main/transcriptIndex.test.ts`

**Interfaces:**
- Consumes: `unembeddedTurnEvents`, `insertEmbedding` (Task 3); `encodeVector`, `EMBED_MODEL_ID`, `EMBED_DIM` (Task 2). An injected `embed` fn (so tests use a stub, not the real model).
- Produces:
  - `export function extractText(message: unknown): string` — joins text from a `message.content` that is either a string or a block array; returns `''` for non-text (tool_use/tool_result only) messages.
  - `export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>`
  - `export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch?: number): Promise<number>` — embeds all pending turns for a session, returns count inserted.

- [ ] **Step 1: Write the failing test**

`src/main/transcriptIndex.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, unembeddedTurnEvents } from './db.js';
import { extractText, indexSessionTurns } from './transcriptIndex.js';
import { EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

// Deterministic stub embedder: unit vector whose first slot is text length mod 1.
const stubEmbed = async (texts: string[]) =>
  texts.map((t) => { const v = new Float32Array(EMBED_DIM); v[0] = 1; v[1] = t.length / 1000; return v; });

let dir: string;
const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-idx-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('extractText', () => {
  it('reads a string content', () => {
    expect(extractText({ content: 'hello' })).toBe('hello');
  });
  it('joins text blocks and ignores tool blocks', () => {
    const msg = { content: [{ type: 'text', text: 'part one' }, { type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: 'part two' }] };
    expect(extractText(msg)).toBe('part one\npart two');
  });
  it('returns empty for a tool-only message', () => {
    expect(extractText({ content: [{ type: 'tool_result', tool_use_id: 'x' }] })).toBe('');
  });
});

describe('indexSessionTurns', () => {
  it('embeds pending user/assistant turns and skips empty/tool-only ones', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'first prompt' } }));
    ingestLine(WS, SES, line({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-01T00:00:01Z', message: { content: [{ type: 'text', text: 'a reply' }] } }));
    ingestLine(WS, SES, line({ type: 'assistant', uuid: 'a2', timestamp: '2026-07-01T00:00:02Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));

    const inserted = await indexSessionTurns(SES, stubEmbed);
    expect(inserted).toBe(2); // two text turns; tool-only assistant skipped
    expect(unembeddedTurnEvents(SES, EMBED_MODEL_ID).length).toBe(0);
  });

  it('is idempotent — a second run inserts nothing', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    await indexSessionTurns(SES, stubEmbed);
    expect(await indexSessionTurns(SES, stubEmbed)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/transcriptIndex.test.ts`
Expected: FAIL — `Cannot find module './transcriptIndex.js'`.

- [ ] **Step 3: Implement `transcriptIndex.ts`**

```ts
// Incremental transcript indexer: turns JSONL turn text into embeddings.
// Pure text extraction + a write path that embeds pending turns. The embed
// function is injected so this module has no dependency on the model runtime
// (and tests can stub it).
import { insertEmbedding, unembeddedTurnEvents } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

const MAX_CHARS = 2000;

/** Human-readable text of a JSONL event's `message`, or '' if it carries none. */
export function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Embed every pending turn for a session. Returns rows inserted. */
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch = 64): Promise<number> {
  let total = 0;
  // Loop so a session with a large backlog drains across batches.
  // unembeddedTurnEvents only returns rows still lacking an embedding, so the
  // cursor advances naturally as rows are inserted.
  for (;;) {
    const pending = unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch);
    if (pending.length === 0) break;

    const prepared = pending
      .map((ev) => {
        let text = '';
        try { text = extractText((JSON.parse(ev.rawJsonl) as { message?: unknown }).message); } catch { /* skip */ }
        return { ev, text: text.slice(0, MAX_CHARS) };
      })
      .filter((p) => p.text.length > 0);

    if (prepared.length === 0) {
      // Nothing embeddable in this batch (all tool-only/empty). Insert a
      // zero-vector placeholder so these rows leave the pending set and the
      // loop terminates. They score ~0 and never surface in search.
      for (const { ev } of pending) {
        insertEmbedding({
          workspaceId: ev.workspaceId, sessionId, kind: 'turn', refEventId: ev.id, ts: ev.ts,
          text: '', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
          vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
        });
      }
      continue;
    }

    const vecs = await embed(prepared.map((p) => p.text));
    prepared.forEach((p, i) => {
      const ok = insertEmbedding({
        workspaceId: p.ev.workspaceId, sessionId, kind: 'turn', refEventId: p.ev.id, ts: p.ev.ts,
        text: p.text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: `t${p.ev.id}`,
      });
      if (ok) total++;
    });
    // Placeholder-insert the skipped (empty) rows in this batch too, so they
    // don't reappear as pending forever.
    for (const ev of pending) {
      if (!prepared.some((p) => p.ev.id === ev.id)) {
        insertEmbedding({
          workspaceId: ev.workspaceId, sessionId, kind: 'turn', refEventId: ev.id, ts: ev.ts,
          text: '', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
          vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
        });
      }
    }
  }
  return total;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/transcriptIndex.test.ts`
Expected: PASS (5 tests). Note the first `indexSessionTurns` test expects `2` inserts (the tool-only assistant gets an empty placeholder, which is not counted because `insertEmbedding` returns true for it — verify: placeholder inserts DO return true).

> **Implementer note:** the test asserts `inserted === 2`. The placeholder for the tool-only turn also inserts a row (returns true). To keep `total` = embedded turns only, the placeholder inserts in Step 3 intentionally do **not** increment `total` (they're outside the `if (ok) total++`). Confirm the count matches; if not, the boundary is wrong — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add src/main/transcriptIndex.ts src/main/transcriptIndex.test.ts
git commit -m "feat(search): transcript turn extraction + incremental indexer"
```

---

### Task 6: Session-summary ingest routing + summary embedding

**Files:**
- Modify: `src/main/db.ts` (route `session-summary` event type; add `unembeddedSummaries`)
- Modify: `src/main/transcriptIndex.ts` (add `indexSessionSummaries`)
- Test: `src/main/dbSummaries.test.ts`, extend `src/main/transcriptIndex.test.ts`

**Interfaces:**
- Produces:
  - `session-summary` JSONL events route into `session_summaries` (upsert by `session_id`, stamping `source_max_event_id = maxEventId(sessionId)`).
  - `export interface PendingSummary { sessionId: string; workspaceId: string; summary: string; sourceMaxEventId: number; ts: number | null }`
  - `export function unembeddedSummaries(modelId: string, limit?: number): PendingSummary[]`
  - `export async function indexSessionSummaries(embed: EmbedFn, batch?: number): Promise<number>` (in transcriptIndex.ts)

- [ ] **Step 1: Write the failing test**

`src/main/dbSummaries.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine, unembeddedSummaries } from './db.js';
import { EMBED_MODEL_ID } from './vectors.js';

let dir: string; const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-sum-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('session-summary ingest', () => {
  it('routes a session-summary event into session_summaries as a pending embedding', () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    ingestLine(WS, SES, line({ type: 'session-summary', summary: 'Worked on the broker reconnect bug.', timestamp: '2026-07-01T00:01:00Z' }));
    const pending = unembeddedSummaries(EMBED_MODEL_ID);
    expect(pending.length).toBe(1);
    expect(pending[0].summary).toContain('broker reconnect');
    expect(pending[0].sourceMaxEventId).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/dbSummaries.test.ts`
Expected: FAIL — `unembeddedSummaries is not a function`.

- [ ] **Step 3: Route the event + add the query helper (db.ts)**

Add a prepared statement + wire it into the `ingestLine` routing chain. Near the other `updateSession*` statements:
```ts
const upsertSessionSummary = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO session_summaries (session_id, workspace_id, summary, source_max_event_id, model, generated_at)
    VALUES (@session_id, @workspace_id, @summary, @source_max_event_id, @model, @generated_at)
    ON CONFLICT(session_id) DO UPDATE SET
      summary = excluded.summary,
      source_max_event_id = excluded.source_max_event_id,
      model = excluded.model,
      generated_at = excluded.generated_at
  `);
```
Add it to the `Cache` interface + `getStmts`. Then in `ingestLine`, add a branch to the routing `else if` chain:
```ts
  } else if (type === 'session-summary' && typeof parsed.summary === 'string') {
    s.upsertSessionSummary.run({
      session_id: sessionId,
      workspace_id: workspaceId,
      summary: parsed.summary,
      source_max_event_id: maxEventId(sessionId),
      model: typeof parsed.model === 'string' ? parsed.model : null,
      generated_at: ts ?? Date.now(),
    });
  }
```
Then the query helper:
```ts
export interface PendingSummary {
  sessionId: string;
  workspaceId: string;
  summary: string;
  sourceMaxEventId: number;
  ts: number | null;
}

/** Summaries whose current (session, source_max_event_id) has no embedding. */
export function unembeddedSummaries(modelId: string, limit = 100): PendingSummary[] {
  const d = openDbOrThrow();
  return d
    .prepare(`
      SELECT s.session_id AS sessionId, s.workspace_id AS workspaceId, s.summary AS summary,
             s.source_max_event_id AS sourceMaxEventId, s.generated_at AS ts
      FROM session_summaries s
      LEFT JOIN embeddings em
        ON em.session_id = s.session_id AND em.kind = 'summary'
       AND em.model_id = ? AND em.dedup_key = CAST(s.source_max_event_id AS TEXT)
      WHERE em.id IS NULL
      ORDER BY s.generated_at DESC
      LIMIT ?
    `)
    .all(modelId, limit) as PendingSummary[];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/dbSummaries.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `indexSessionSummaries` + test (transcriptIndex.ts)**

Append to `src/main/transcriptIndex.ts`:
```ts
import { unembeddedSummaries } from './db.js'; // add to existing import from './db.js'

export async function indexSessionSummaries(embed: EmbedFn, batch = 64): Promise<number> {
  let total = 0;
  for (;;) {
    const pending = unembeddedSummaries(EMBED_MODEL_ID, batch);
    if (pending.length === 0) break;
    const vecs = await embed(pending.map((p) => p.summary.slice(0, MAX_CHARS)));
    pending.forEach((p, i) => {
      const ok = insertEmbedding({
        workspaceId: p.workspaceId, sessionId: p.sessionId, kind: 'summary', refEventId: null, ts: p.ts,
        text: p.summary.slice(0, MAX_CHARS), modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: String(p.sourceMaxEventId),
      });
      if (ok) total++;
    });
    if (pending.length < batch) break;
  }
  return total;
}
```
Add to `transcriptIndex.test.ts`:
```ts
import { indexSessionSummaries } from './transcriptIndex.js';
// ...
describe('indexSessionSummaries', () => {
  it('embeds a pending session summary once', async () => {
    ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    ingestLine(WS, SES, line({ type: 'session-summary', summary: 'Fixed the reconnect bug.', timestamp: '2026-07-01T00:01:00Z' }));
    expect(await indexSessionSummaries(stubEmbed)).toBe(1);
    expect(await indexSessionSummaries(stubEmbed)).toBe(0);
  });
});
```

- [ ] **Step 6: Run both test files, then commit**

Run: `npx vitest run src/main/dbSummaries.test.ts src/main/transcriptIndex.test.ts`
Expected: PASS.
```bash
git add src/main/db.ts src/main/transcriptIndex.ts src/main/dbSummaries.test.ts src/main/transcriptIndex.test.ts
git commit -m "feat(search): session-summary ingest routing + summary embedding"
```

---

### Task 7: `searchTranscripts` — scoped brute-force query

**Files:**
- Modify: `src/main/transcriptIndex.ts` (add `searchTranscripts`)
- Test: `src/main/transcriptSearch.test.ts`

**Interfaces:**
- Consumes: `decodeVector`, `topK`, `EMBED_MODEL_ID` (Task 2); an injected `embed` fn; the module-level `db` via a new read helper.
- Produces:
  - `export interface SearchHit { sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; score: number }`
  - `export async function searchTranscripts(query: string, allowedWorkspaces: Set<string>, embed: EmbedFn, opts?: { limit?: number; kind?: 'turn' | 'summary' }): Promise<SearchHit[]>`

- [ ] **Step 1: Write the failing test**

`src/main/transcriptSearch.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, ingestLine } from './db.js';
import { indexSessionTurns, searchTranscripts } from './transcriptIndex.js';
import { EMBED_DIM } from './vectors.js';

// Stub embedder mapping known phrases to fixed directions in 2 dims of the space.
const dir2 = (a: number, b: number) => { const v = new Float32Array(EMBED_DIM); v[0] = a; v[1] = b; return v; };
const stub = async (texts: string[]) => texts.map((t) =>
  t.includes('banana') ? dir2(0, 1) : dir2(1, 0));

let dir: string; const A = '01WSA', B = '01WSB';
const line = (o: object) => JSON.stringify(o);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-search-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

async function seed() {
  ingestLine(A, 'sa', line({ type: 'user', uuid: 'a1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'fixing the broker bug' } }));
  ingestLine(B, 'sb', line({ type: 'user', uuid: 'b1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'a banana recipe' } }));
  await indexSessionTurns('sa', stub);
  await indexSessionTurns('sb', stub);
}

describe('searchTranscripts', () => {
  it('ranks the semantically closest turn first', async () => {
    await seed();
    const hits = await searchTranscripts('broker debugging', new Set([A, B]), stub, { limit: 5 });
    expect(hits[0].text).toContain('broker bug');
  });

  it('never returns rows outside allowedWorkspaces', async () => {
    await seed();
    const hits = await searchTranscripts('banana', new Set([A]), stub); // only A allowed
    expect(hits.every((h) => h.workspaceId === A)).toBe(true);
    expect(hits.some((h) => h.workspaceId === B)).toBe(false);
  });

  it('returns [] for an empty allowed set', async () => {
    await seed();
    expect(await searchTranscripts('x', new Set<string>(), stub)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/transcriptSearch.test.ts`
Expected: FAIL — `searchTranscripts is not a function`.

- [ ] **Step 3: Implement `searchTranscripts`**

Append to `src/main/transcriptIndex.ts` (add `decodeVector`, `topK` to the vectors import):
```ts
import { getDb } from './db.js'; // add: a getter that returns the open db (see note)

export interface SearchHit {
  sessionId: string;
  workspaceId: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}

export async function searchTranscripts(
  query: string,
  allowedWorkspaces: Set<string>,
  embed: EmbedFn,
  opts: { limit?: number; kind?: 'turn' | 'summary' } = {},
): Promise<SearchHit[]> {
  const ids = [...allowedWorkspaces];
  if (ids.length === 0 || query.trim().length === 0) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

  const [qvec] = await embed([query.trim()]);
  const d = getDb();
  const where = [`workspace_id IN (${ids.map(() => '?').join(',')})`, `model_id = ?`, `text <> ''`];
  const params: unknown[] = [...ids, EMBED_MODEL_ID];
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }

  const rows = d
    .prepare(`SELECT session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text, vec
              FROM embeddings WHERE ${where.join(' AND ')}`)
    .all(...params) as Array<{ sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; vec: Buffer }>;

  const cands = rows.map((r) => ({ vec: decodeVector(r.vec) }));
  return topK(qvec, cands, limit).map(({ index, score }) => {
    const r = rows[index];
    return { sessionId: r.sessionId, workspaceId: r.workspaceId, kind: r.kind, ts: r.ts, text: r.text, score };
  });
}
```
> **Note:** add a small getter to `db.ts` so this module reads the shared connection without re-implementing scan SQL there:
> ```ts
> export function getDb(): Database.Database { return openDbOrThrow(); }
> ```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/transcriptSearch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/transcriptIndex.ts src/main/transcriptSearch.test.ts
git commit -m "feat(search): scoped brute-force searchTranscripts"
```

---

### Task 8: `search_transcripts` MCP tool + scope regression test

**Files:**
- Modify: `src/main/mcpServer.ts` (add `setQueryEmbedder` + `search_transcripts` in `TOOLS`)
- Modify: `src/main/mcpServer.test.ts` (add isolation test)
- Modify: `tests/mcp-*.spec.ts` — the CI-only e2e contract spec (add the tool to the expected surface) — see the file that lists expected tool names.

**Interfaces:**
- Consumes: `searchTranscripts`, `EmbedFn`, `SearchHit` (Task 7); existing `inClause`, `ToolCtx`, `clampLimit`.
- Produces:
  - `export function setQueryEmbedder(fn: EmbedFn): void`
  - a `search_transcripts` entry in `TOOLS` whose `run` is async and scoped by `ctx.allowedWorkspaces`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/mcpServer.test.ts` (reuse its `makeDb`/`tool` harness; it seeds `events` for WS_A and WS_B). Add near the other scope tests:
```ts
import { setQueryEmbedder } from './mcpServer.js';
import { EMBED_DIM } from './vectors.js';
import { insertEmbedding } from './db.js'; // if the harness uses a real openDb; otherwise insert via raw SQL on the in-memory db

// A stub embedder returning a fixed unit vector (dim EMBED_DIM).
const unit = () => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };

describe('search_transcripts is workspace-scoped (#146)', () => {
  it('never returns a hit outside the caller allowed set', async () => {
    // Insert one embedding row per workspace directly into the test db.
    const enc = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    db.prepare(`CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, session_id TEXT, kind TEXT, ref_event_id INTEGER, ts INTEGER, text TEXT, model_id TEXT, dim INTEGER, vec BLOB, dedup_key TEXT, UNIQUE(session_id,kind,dedup_key))`).run();
    const ins = db.prepare(`INSERT INTO embeddings (workspace_id,session_id,kind,ref_event_id,ts,text,model_id,dim,vec,dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ins.run(WS_A, 'sa', 'turn', 1, 1000, 'A content', 'Xenova/bge-small-en-v1.5', EMBED_DIM, enc(unit()), 't1');
    ins.run(WS_B, 'sb', 'turn', 2, 2000, 'B secret content', 'Xenova/bge-small-en-v1.5', EMBED_DIM, enc(unit()), 't2');

    setQueryEmbedder(async (texts) => texts.map(() => unit()));
    const hits = (await tool('search_transcripts').run(db, { query: 'anything' }, ctxA)) as Array<{ workspace_id?: string; workspaceId?: string }>;
    const wss = hits.map((h) => h.workspaceId ?? h.workspace_id);
    expect(wss).not.toContain(WS_B);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: FAIL — `search_transcripts` not found in `TOOLS` (and/or `setQueryEmbedder` missing).

- [ ] **Step 3: Add the injection setter (near `setReadScopeResolver`)**

```ts
import type { EmbedFn } from './transcriptIndex.js';
import { searchTranscripts } from './transcriptIndex.js';

let queryEmbedder: EmbedFn | null = null;
export function setQueryEmbedder(fn: EmbedFn): void { queryEmbedder = fn; }
```

- [ ] **Step 4: Add the tool to `TOOLS`**

Insert an entry (place it after `list_events`):
```ts
  {
    name: 'search_transcripts',
    description:
      'Semantic search over past transcript content in your allowed workspaces. Embeds the query and returns the most similar turns (and session summaries) by meaning. Args: query (required), limit (default 10, max 50), workspace_id (narrows), kind ("turn"|"summary").',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'default 10, max 50' },
        workspace_id: { type: 'string' },
        kind: { type: 'string', enum: ['turn', 'summary'] },
      },
      required: ['query'],
    },
    run: async (_db, a, ctx) => {
      if (typeof a.query !== 'string' || a.query.trim().length === 0) throw new Error('query is required');
      if (!queryEmbedder) throw new Error('transcript search index is unavailable');
      // A caller-supplied workspace_id can only NARROW within the allowed set.
      let allowed = ctx.allowedWorkspaces;
      if (typeof a.workspace_id === 'string') {
        allowed = allowed.has(a.workspace_id) ? new Set([a.workspace_id]) : new Set<string>();
      }
      const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(a.limit))) : 10;
      const kind = a.kind === 'turn' || a.kind === 'summary' ? a.kind : undefined;
      return searchTranscripts(a.query, allowed, queryEmbedder, { limit, kind });
    },
  },
```
> `searchTranscripts` reads via `getDb()` (the live connection), not the `_db` handle the tool is passed — the tool's `db` arg is the readonly MCP connection, but embeddings live in the same file and `getDb()` returns the main connection opened at startup. Both point at the same `state.db`. (If the test harness opens only an in-memory `db`, wire `searchTranscripts` to accept an optional `db` param for the test — see note.)

> **Implementer note (testability):** so the in-memory test `db` is the one searched, give `searchTranscripts` an optional final `db` param defaulting to `getDb()`, and have the tool pass the `_db` it receives: `searchTranscripts(a.query, allowed, queryEmbedder, { limit, kind }, _db)`. Update Task 7's signature accordingly (`db = getDb()`). This keeps production wiring while letting the test drive the seeded connection.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS, including the new isolation test.

- [ ] **Step 6: Update the CI-only e2e contract spec**

Find the spec that pins the tool surface (`grep -rl "list_events\|session_summary" tests/`) and add `search_transcripts` to its expected tool-name list. Match the existing assertion style in that file.

- [ ] **Step 7: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts src/main/transcriptIndex.ts tests/
git commit -m "feat(mcp): scoped search_transcripts tool"
```

---

### Task 9: Wire the indexer + embedder into the app (`index.ts`)

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `makeEmbedder` (Task 4), `indexSessionTurns`/`indexSessionSummaries` (Tasks 5–6), `setQueryEmbedder` (Task 8), `logError`, the `JsonlWatcher` `'ingest'` event.

- [ ] **Step 1: Add imports**

```ts
import { makeEmbedder } from './embeddings.js';
import { indexSessionTurns, indexSessionSummaries } from './transcriptIndex.js';
import { setQueryEmbedder } from './mcpServer.js';
import { join } from 'node:path'; // if not already imported
```

- [ ] **Step 2: Initialize the embedder and wire the indexer (inside the `if (jsonlWatcher)` block, after `startMcpServer(...)`)**

```ts
    // Local embedder for semantic transcript search (native onnxruntime-node, on-host).
    const embed = makeEmbedder(join(app.getPath('userData'), 'models'));
    setQueryEmbedder(embed);

    // Index new turns/summaries as they land. Fire-and-forget: indexing must
    // never block ingest, and a failure degrades search silently (logged).
    jsonlWatcher.on('ingest', ({ sessionId }) => {
      indexSessionTurns(sessionId, embed).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'transcript-index', message: String(e) }));
    });
    jsonlWatcher.on('ingest', () => {
      indexSessionSummaries(embed).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'summary-index', message: String(e) }));
    });
```

- [ ] **Step 3: Backfill on startup (after `jsonlWatcher.start(...)`)**

```ts
    // Backfill embeddings for sessions ingested before this feature / after a
    // model change. Non-blocking; walks every known session once.
    void (async () => {
      try {
        for (const s of listSessions()) await indexSessionTurns(s.id, embed);
        await indexSessionSummaries(embed);
      } catch (e) {
        logError({ source: 'main', level: 'warn', type: 'index-backfill', message: String(e) });
      }
    })();
```
(Ensure `listSessions` is imported from `./db.js`.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck:node`
Expected: no errors. Then `npm run build` — expected: succeeds (confirms the transformers import bundles/externalizes cleanly for the main process).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(search): wire embedder + incremental indexer + backfill into main"
```

---

### Task 10 (Phase 2): In-runner session-summary hook

**Files:**
- Create: `docker/hooks/session-summary.sh` (runner-side Stop hook)
- Modify: `docker/Dockerfile` (ship the hook asset)
- Modify: the runner Claude settings that register Stop hooks (grep `grep -rn "hooks" docker/ .claude/` for where runner hooks are configured)

**Interfaces:**
- Produces: on session stop, a `{"type":"session-summary","summary":"…","timestamp":"…"}` line appended to the session's JSONL — consumed by Task 6's ingest routing.

> **Ship note:** Phase 1 (Tasks 1–9) delivers working turn-level search on its own. This task adds whole-session "match by gist". It can be a **separate PR**. Because summary generation runs `claude -p` inside the container, verify the runner image has the pinned claude CLI and credentials before relying on it.

- [ ] **Step 1: Write the hook script**

`docker/hooks/session-summary.sh`:
```bash
#!/usr/bin/env bash
# Runner Stop hook: summarize the session and append a session-summary event to
# the active JSONL transcript. Best-effort; a failure must never block the stop.
set -uo pipefail
payload=$(cat)
transcript=$(printf '%s' "$payload" | jq -r '.transcript_path // empty')
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0

# Summarize the recent transcript text with a cheap headless claude call.
recent=$(tail -c 60000 "$transcript")
summary=$(printf '%s' "$recent" | claude -p --model claude-haiku-4-5-20251001 \
  "Summarize what this coding session worked on, key decisions, and outcomes in <=120 words. Output only the summary." 2>/dev/null)
[ -n "$summary" ] || exit 0

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -nc --arg s "$summary" --arg ts "$ts" '{type:"session-summary", summary:$s, timestamp:$ts}' >> "$transcript"
exit 0
```

- [ ] **Step 2: Ship the asset in the image**

In `docker/Dockerfile`, copy the hook into the image alongside the other hook assets (match the existing `COPY` pattern for hooks) and `chmod +x`. Register it as a `Stop` hook in the runner's Claude settings (follow the existing runner-hook registration — see the grep in Files).

- [ ] **Step 3: Build the runner image and smoke-test the hook script logic locally**

Run (logic only, no claude): 
```bash
echo '{"transcript_path":"/tmp/t.jsonl"}' > /tmp/p.json
printf '%s\n' '{"type":"user","message":{"content":"hi"}}' > /tmp/t.jsonl
SUMMARY_TEST=1 bash docker/hooks/session-summary.sh < /tmp/p.json || true
```
Expected: exits 0 (with real `claude` present it appends a `session-summary` line). Confirm the append shape with `tail -1 /tmp/t.jsonl` when run in-container.

- [ ] **Step 4: Commit**

```bash
git add docker/
git commit -m "feat(search): runner Stop hook emits session-summary events (Phase 2)"
```

---

### Task 11: Docs + final gate

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/superpowers/specs/2026-06-30-semantic-transcript-search-design.md` (flip Status)

- [ ] **Step 1: Update `docs/SPEC.md`**

- Observability/data-model section: add the `embeddings` and `session_summaries` tables and the `session-summary` JSONL event type + note vectors are local (native `onnxruntime-node`, `bge-small-en-v1.5`, 384-d, normalized) and rebuildable; record that `onnxruntime-node` is a cross-build native module and `sharp` is excluded from packaging.
- §11 Fleet-state MCP: add `search_transcripts` to the tool list with its args + the scoping guarantee (results confined to `allowedWorkspaces`).
- Runner contract: document the `session-summary` event (Phase 2) written by the runner Stop hook.

- [ ] **Step 2: Flip the design doc status**

Change `**Status:** Approved (brainstorming) — pending implementation plan` → `**Status:** Implemented (Phase 1) / Phase 2 = runner summary hook`.

- [ ] **Step 3: Full test gate**

Run: `npm run test:unit`
Expected: all unit tests pass (new files: `vectors`, `dbEmbeddings`, `embeddings`, `transcriptIndex`, `dbSummaries`, `transcriptSearch`, plus the `mcpServer` isolation addition).
Then: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-06-30-semantic-transcript-search-design.md
git commit -m "docs: SPEC + design status for semantic transcript search"
```

---

## Self-Review

**Spec coverage:**
- Local embeddings (native onnxruntime-node backend; sharp excluded) → Tasks 1, 4 + Global Constraints. ✅
- `bge-small-en-v1.5`, 384-d, normalized → Task 2 constants, Task 4. ✅
- BLOB vectors + brute-force cosine, no sqlite-vec → Tasks 2, 7. ✅
- Migration additive, v6 → Task 3. ✅
- Turn text only (skip tool_use/tool_result) + per-session summary → Tasks 5, 6. ✅
- Incremental index on ingest + backfill → Tasks 5, 9. ✅
- Summary via in-runner hook → Task 10 (Phase 2), ingest path in Task 6. ✅
- Scoped `search_transcripts` MCP tool, `allowedWorkspaces` filter → Tasks 7, 8. ✅
- Error handling: indexing degrades silently, search errors "unavailable" → Tasks 8 (throw), 9 (catch+log). ✅
- Tests: unit + MCP contract (unit + e2e) → Task 8 step 6, Task 11. ✅
- SPEC.md updated same PR → Task 11. ✅
- Non-goals (no renderer UI, no re-ranking) → not built. ✅

**Placeholder scan:** no TBD/TODO; every code step has concrete code. The two `> Implementer note` blocks flag real boundary decisions (placeholder-insert count; test `db` injection) rather than deferring work.

**Type consistency:** `EmbedFn` defined in Task 5, reused in Tasks 6–8. `EmbeddingInsert`/`insertEmbedding` names consistent Tasks 3→5→6. `searchTranscripts` signature gains an optional `db` param (Task 7 note + Task 8 note) — consistent. `EMBED_MODEL_ID`/`EMBED_DIM` from Task 2 used everywhere. `dedup_key` = `t<id>` for turns, `String(sourceMaxEventId)` for summaries — matches the `unembeddedSummaries` JOIN (`dedup_key = CAST(source_max_event_id AS TEXT)`). ✅
