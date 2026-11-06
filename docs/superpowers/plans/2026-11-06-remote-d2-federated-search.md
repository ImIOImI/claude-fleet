# Remote workspaces (d2): `search_transcripts` on the host and federated search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote host embeds its own sessions' turns and serves `search_transcripts` to its sessions. The desktop's Sessions pane gets a transcript search that merges local hits with hits from remote hosts by score, with origin badges and unavailable sources.

**Architecture:**
- **Host embedder.** The host image ships `@huggingface/transformers` (with `onnxruntime-node`) beside the bundle, plus the `Xenova/bge-small-en-v1.5` q8 weights, baked in at build. `fleet-host` runs the embedder in a `worker_thread`, so tokenizing never stalls the attach fan-out.
- **Indexer.** The holder embeds new turns after each ingest commit, plus a backfill at start, through a perf-free copy of the desktop's indexing loop. Every insert is a fenced write.
- **Host MCP.** It serves `search_transcripts` with that embedder.
- **RPC.** A `read`-tier `history:search` takes a query **vector** and its model id, never text. The host runs only the exact pgvector scan.
- **Desktop.** The desktop embeds the query once. `FederatedReader.search` runs the local search and the remote calls in parallel (liveness-gated, 3 s), drops sources whose model id differs, and merges by score.

**Tech Stack:** as (d1), plus `@huggingface/transformers` 3.8.1 / `onnxruntime-node` 1.21.0 (already desktop dependencies), `node:worker_threads`, Docker.

**Spec:** remote-workspaces design §7 (*Semantic search results merge by score…*, *Vector search is per backend*), §11 (d). `docs/SPEC.md` §7 *JSONL→SQLite cache* (*Search*), §7 *Remote host* (*Ingest*, *Host MCP*), §4 *Host images*. (d1) `2026-11-06-remote-d1-federated-history.md`: D53–D63, D69–D70 and Tasks 1, 6–8. Part 4a D43/D44.

**Gate:** (d1) is merged.

## Global Constraints

Every task implicitly includes these.

- **Spec, verbatim:**
  - "Semantic search results merge by score. Scores are comparable because every source embeds with the same model key (`Xenova/bge-small-en-v1.5@q8`). A source reporting a different model key is left out of the merge and flagged." (§7)
  - "SQLite keeps today's brute-force cosine search over Float32 BLOBs (`vectors.ts`). Postgres uses pgvector (`vector(384)`, cosine distance, an HNSW index). Both sit behind `searchEmbeddings(query, scope, limit)`." (§7)
  - "A source that times out or errors is dropped from that result, and the response lists it under `unavailable`." (§7)
  - "Remote data is live-only." (§7)
- **(d1)'s constraints all apply:**
  - Local paths stay unchanged.
  - The host scope comes from the host.
  - Replies are untrusted.
  - The comment rules, SPEC in the same PR, the commit trailer, the environment and secret hygiene, and no UI verification in the container.
- **The host image has no network at run time for the model:** `env.allowRemoteModels = false`. The weights come only from the image.
- **The host's event loop never runs the model:** the embedder lives in a worker thread.

## Decisions (D64–D68, recorded in SPEC.md by Task 8)

- **D64: Scores are comparable; checked, not assumed.**
  - Both dialects store the same L2-normalized float32 vectors (`normalize: true`, `EMBED_DIM` 384).
  - SQLite scores a dot product. For unit vectors, that is cosine similarity.
  - Postgres scores `1 − (vec <=> q)`. `<=>` is cosine distance, so that is cosine similarity too.
  - The two differ only by float rounding (≤ 1e-6). Task 6 pins this with a fixture: the same vectors scored both ways agree to 1e-5.
  - **Every source reports `modelId`** (`EMBED_MODEL_ID`). A remote source with a different `modelId` is dropped and listed `unavailable` with reason `model`.
  - **Merge:** by score descending, then origin, `sessionId` and `ts`. Hits are not deduplicated: two turns are two hits.
- **D65: The host gets its own embedder, in the image.**
  - The `host-build` stage runs `npm i --ignore-scripts --no-save @huggingface/transformers@3.8.1` into `/opt/fleet-embed`. onnxruntime-node 1.21.0 ships its CPU binaries for linux x64 and arm64 in the package, so the postinstall (CUDA fetch only) isn't needed. sharp's `@img/sharp-linux-*` optional binaries install without scripts.
  - A build step fetches the q8 weights once into `/opt/fleet-embed/models`. The image's `fleet-host embed-selftest` must print `384` at build, or the build fails.
  - The runtime image copies `/opt/fleet-embed` to `/usr/local/lib/fleet-host/embed/` (read-only, root-owned).
  - **The bundle externalizes `@huggingface/transformers`.** The worker loads it with `createRequire` from that directory, so the import graph and the Vite bundle stay free of it.
  - **Memory:** the desktop measured ~300 MB steady for q8 at batch 8 and 1000 characters (`transcriptIndex.ts`). The reference deployment's memory request goes up by 512 Mi (Task 8 records it).
  - **Rejected, the desktop indexing the host's sessions:** it breaks one-writer-per-workspace (spec §2).
  - **Rejected, a separate embedding service:** another deployment for one model.
- **D66: `history:search` takes a vector, not text.**
  - Args: `[{ vector: number[384], modelId, limit ≤ 50, kind? }]`.
  - The host checks:
    - `modelId === EMBED_MODEL_ID` (otherwise 400 `model mismatch: host uses <id>`);
    - length 384, every element finite, a norm within 1e-3 of 1;
    - `limit` 1–50.
  - A `read` viewer therefore can't make the host spend model CPU. The scan is part 4a's exact pgvector query over `{hosted}` (D43). The reply is `{ modelId, hits: EmbeddingHit[] }`, with `text` capped at 1000 characters on both sides.
  - The host's own `search_transcripts` MCP tool embeds text in the worker, as on the desktop.
- **D67: A query vector goes only to hosts the user is searching.**
  - Search follows the Sessions pane's scope:
    - **This workspace:** the selected workspace's origin only (local or that host).
    - **All:** local plus every reachable remote bookmark.
  - The search box says which hosts receive it ("Searching this desktop + review-bot").
  - An embedding approximately reveals the query, so the user decides by scope. No local transcript text or hit is ever sent.
- **D68: Indexing on the host covers turns only, serially, fenced.**
  - The host has no summarizer (§7 *Ingest*), so only turns are indexed.
  - At holder start: `deleteEmbeddingsForOtherModels` → `listSessionIds` → `indexSessionTurns` per session. After that, one queued `indexSessionTurns(sessionId)` per `onIngested` (D69), coalesced per session, one at a time.
  - Writes go through the fenced state store, so a superseded holder's insert fails and ends the process like any other write.
  - Stop order: MCP → automations → **indexer (waits ≤ 2 s for the in-flight batch)** → ingest → stores.
  - HNSW stays deferred (D44/D70). The corpus is one workspace until (e). Task 8 re-states the trigger.

## File structure

| File | Responsibility |
|---|---|
| `src/main/transcriptIndexCore.ts` (new) | `indexSessionTurnsWith(deps, sessionId, embed, batch)`, the indexing loop with injected spans. Pure apart from db.ts. |
| `src/main/transcriptIndex.ts` | Wraps the core with `perfSpanAsync`; behaviour unchanged. |
| `src/host/embedWorker.ts` (new) | The worker entry: loads transformers from `FLEET_HOST_EMBED_DIR`, embeds batches. |
| `src/host/embedder.ts` (new) | The main-thread client: `EmbedFn` over the worker, a queue, restart on crash, `close()`. |
| `src/host/hostIndexer.ts` (new) | Backfill plus per-ingest indexing on the holder. |
| `src/host/holder.ts` | Wires the embedder, indexer and MCP embedder; stop order. |
| `src/host/hostMcp.ts` | `search_transcripts` in `HOST_MCP_TOOLS` when an embedder exists. |
| `src/main/mcpCore.ts` | `setQueryEmbedder(fn \| null)`. |
| `src/host/historyRead.ts`, `src/host/historyRpc.ts` | `parseSearchReq`, `HistoryReader.search`, `history:search`. |
| `src/host/cli.ts` | `embed-selftest` subcommand. |
| `vite.host.config.ts`, `docker/host/Dockerfile` | Worker entry, external transformers, the embed stage. |
| `src/main/federation/remoteRows.ts` | `parseSearchReply`. |
| `src/main/federation/federatedReader.ts` | `search(...)`. |
| `src/main/federation/searchMerge.ts` (new) | `mergeHits` (pure). |
| `src/main/federation/federationIpc.ts`, `src/preload/index.ts` | `history:search`. |
| `src/renderer/src/components/TranscriptSearch.tsx` (new), `SessionsPane.tsx` | The search UI. |
| `docs/SPEC.md` | Task 8. |

---

### Task 1: Perf-free indexing core

**Files:**
- Create: `src/main/transcriptIndexCore.ts`
- Modify: `src/main/transcriptIndex.ts`, `src/host/importGraph.test.ts`
- Test: `src/main/transcriptIndex.test.ts` (unchanged, must pass), `src/main/transcriptIndexCore.test.ts`

**Interfaces:**
- Produces:
  - `type SpanAsync = <T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string | number>) => Promise<T>`.
  - `indexSessionTurnsWith(span: SpanAsync, sessionId: string, embed: EmbedFn, batch?: number): Promise<number>`.
  - `extractText` moves here and is re-exported from `transcriptIndex.ts`.

- [ ] **Step 1: Write the failing test** — `src/main/transcriptIndexCore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { indexSessionTurnsWith, extractText } from './transcriptIndexCore';

describe('transcriptIndexCore', () => {
  it('exports the loop without perf and keeps extractText', async () => {
    expect(typeof indexSessionTurnsWith).toBe('function');
    expect(extractText({ content: [{ type: 'text', text: ' a ' }] })).toBe('a');
  });
});
```

Add `/^main\/transcriptIndexCore\.ts$/` to `MAIN_ALLOWED` in `src/host/importGraph.test.ts` once Task 3 imports it. Until then the walk doesn't reach it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/transcriptIndexCore.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**
  - Move `MAX_CHARS`, `EMBED_BATCH`, `extractText` and the body of `indexSessionTurns` from `transcriptIndex.ts` into `transcriptIndexCore.ts`.
  - Rename the function `indexSessionTurnsWith(span, sessionId, embed, batch = EMBED_BATCH)`. Its one `perfSpanAsync(...)` call becomes `span(...)` with the same name and attributes.
  - The core imports only `./db.js` (`insertEmbeddings`, `unembeddedTurnEvents`) and `./vectors.js`.
  - `transcriptIndex.ts` keeps its exports:

```ts
import { extractText, indexSessionTurnsWith } from './transcriptIndexCore.js';
export { extractText };
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch?: number): Promise<number> {
  return indexSessionTurnsWith(perfSpanAsync, sessionId, embed, batch);
}
```

  `perfSpanAsync`'s signature must be assignable to `SpanAsync`. If its attrs type differs, widen `SpanAsync`'s `attrs` to `Parameters<typeof perfSpanAsync>[2]`-compatible `Record<string, unknown>`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/transcriptIndexCore.test.ts src/main/transcriptIndex.test.ts src/main/transcriptSearch.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass, with existing tests unchanged; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/transcriptIndexCore.ts src/main/transcriptIndexCore.test.ts src/main/transcriptIndex.ts
git -C "$W" commit -m "refactor(index): perf-free indexing core for the host (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Host embedder in a worker, and the image

**Files:**
- Create: `src/host/embedWorker.ts`, `src/host/embedder.ts`
- Modify: `src/host/cli.ts`, `vite.host.config.ts`, `docker/host/Dockerfile`, `src/host/importGraph.test.ts`
- Test: `src/host/embedder.test.ts`

**Interfaces:**
- Produces:
  - `FLEET_HOST_EMBED_DIR` (default `/usr/local/lib/fleet-host/embed`).
  - `startEmbedder(o: { dir: string; workerUrl?: URL; log: Logger }): HostEmbedder`.
  - `HostEmbedder { embed: EmbedFn; close(): Promise<void> }`.
  - `fleet-host embed-selftest` prints `{"dim":384}` and exits 0.

- [ ] **Step 1: Write the failing test** — `src/host/embedder.test.ts`. It drives the client against a fake worker script (no model), proving the protocol, ordering, crash restart and close:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startEmbedder } from './embedder.js';
import { createLogger } from './log.js';

function fakeWorker(body: string): URL {
  const f = join(mkdtempSync(join(tmpdir(), 'ew-')), 'w.mjs');
  writeFileSync(f, `import { parentPort } from 'node:worker_threads';\n${body}`);
  return pathToFileURL(f);
}

describe('host embedder', () => {
  it('answers batches in order with Float32Array rows', async () => {
    const e = startEmbedder({ dir: '/nope', log: createLogger(() => undefined), workerUrl: fakeWorker(
      `parentPort.on('message', ({ id, texts }) => parentPort.postMessage({ id, vecs: texts.map((t) => Array(384).fill(t.length)) }));`) });
    const [a, b] = await Promise.all([e.embed(['x']), e.embed(['yy', 'zzz'])]);
    expect(a[0]).toBeInstanceOf(Float32Array);
    expect(a[0][0]).toBe(1);
    expect(b.map((v) => v[0])).toEqual([2, 3]);
    await e.close();
  });

  it('fails in-flight calls when the worker dies, then restarts', async () => {
    const e = startEmbedder({ dir: '/nope', log: createLogger(() => undefined), workerUrl: fakeWorker(
      `let n = 0; parentPort.on('message', ({ id, texts }) => { if (n++ === 0) process.exit(3); parentPort.postMessage({ id, vecs: texts.map(() => Array(384).fill(0)) }); });`) });
    await expect(e.embed(['a'])).rejects.toThrow(/embedder exited/);
    await expect(e.embed(['b'])).resolves.toHaveLength(1);
    await e.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/embedder.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**

`src/host/embedWorker.ts`:

```ts
// The host's embedding model, off the main thread. Loads transformers from the
// image's embed dir (not bundled) with remote model fetches off.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { EMBED_DIM, EMBED_DTYPE, EMBED_HF_ID } from '../main/vectors.js';

type Extractor = (texts: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
const dir = (workerData as { dir: string }).dir;
let extractor: Promise<Extractor> | null = null;

function load(): Promise<Extractor> {
  const req = createRequire(join(dir, 'package.json'));
  const { pipeline, env } = req('@huggingface/transformers') as typeof import('@huggingface/transformers');
  env.cacheDir = join(dir, 'models');
  env.allowRemoteModels = false;
  return pipeline('feature-extraction', EMBED_HF_ID, { dtype: EMBED_DTYPE }) as unknown as Promise<Extractor>;
}

parentPort!.on('message', async ({ id, texts }: { id: number; texts: string[] }) => {
  try {
    extractor ??= load();
    const out = (await (await extractor)(texts, { pooling: 'mean', normalize: true })).tolist();
    parentPort!.postMessage({ id, vecs: out.map((r) => r.slice(0, EMBED_DIM)) });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message });
  }
});
```

`src/host/embedder.ts`:

```ts
// EmbedFn over the embed worker. A crashed worker fails its in-flight calls
// and is restarted on the next call.
import { Worker } from 'node:worker_threads';
import { EMBED_DIM, type EmbedFn } from '../main/vectors.js';
import type { Logger } from './log.js';

export const DEFAULT_EMBED_DIR = '/usr/local/lib/fleet-host/embed';

export interface HostEmbedder { embed: EmbedFn; close(): Promise<void> }

export function startEmbedder(o: { dir: string; workerUrl?: URL; log: Logger }): HostEmbedder {
  const url = o.workerUrl ?? new URL('./embed-worker.mjs', import.meta.url);
  let worker: Worker | null = null;
  let seq = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  const spawn = (): Worker => {
    const w = new Worker(url, { workerData: { dir: o.dir } });
    w.unref();
    w.on('message', (m: { id: number; vecs?: number[][]; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error !== undefined || !m.vecs) return p.reject(new Error(`embed failed: ${m.error ?? 'no vectors'}`));
      p.resolve(m.vecs.map((r) => { const v = new Float32Array(EMBED_DIM); for (let i = 0; i < EMBED_DIM; i++) v[i] = r[i] ?? 0; return v; }));
    });
    w.on('error', (err) => o.log.log('warn', 'embed worker error', { error: err.message }));
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(`embedder exited (${code})`)); }
    });
    return w;
  };
  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      if (closed) throw new Error('embedder closed');
      worker ??= spawn();
      const id = ++seq;
      const w = worker;
      return new Promise<Float32Array[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, texts });
      });
    },
    async close() {
      closed = true;
      await worker?.terminate();
      worker = null;
    }
  };
}
```

`vite.host.config.ts`:
- Add `'embed-worker': 'src/host/embedWorker.ts'` to `rollupOptions.input`.
- Add `external: ['@huggingface/transformers']` to `rollupOptions`, with the comment `// Loaded at run time from FLEET_HOST_EMBED_DIR; never bundled.`.
- Keep `ssr.noExternal: true`; `rollupOptions.external` takes precedence for the bare id.

`src/host/importGraph.test.ts`:
- Add `join(SRC, 'host', 'embedWorker.ts')` to `ENTRIES`.
- Add `'@huggingface'` to `BARE_ALLOWED` with a trailing comment `// embedWorker only, external (vite.host.config.ts)`.
- Add an assertion that no file other than `host/embedWorker.ts` imports it: in `walk()`, record `bareBy: Map<string, Set<string>>` and expect `bareBy.get('@huggingface')` to equal `new Set(['host/embedWorker.ts'])`. The worker uses `req('@huggingface/transformers')`, which `SPEC_RE`'s `require(` branch doesn't match on `req(`. So list `host/embedWorker.ts` explicitly in a `RUNTIME_REQUIRES` map that the test merges in.

`src/host/cli.ts`: add a subcommand beside `init`. Match how `cli.ts` already dispatches `init`, `bootstrap` and `migrate`; any other argument stays a usage error.

```ts
  if (argv[0] === 'embed-selftest') {
    const { startEmbedder, DEFAULT_EMBED_DIR } = await import('./embedder.js');
    const e = startEmbedder({ dir: process.env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR, log: createLogger((l) => process.stderr.write(l + '\n')) });
    const [v] = await e.embed(['selftest']);
    await e.close();
    process.stdout.write(JSON.stringify({ dim: v.length }) + '\n');
    return 0;
  }
```

`docker/host/Dockerfile`:
- In the `host-build` stage, after `RUN npx vite build …`, add:

```dockerfile
# The host embedder (remote-workspaces d2): transformers + CPU onnxruntime beside the bundle, weights baked in.
RUN mkdir -p /opt/fleet-embed && cd /opt/fleet-embed && npm init -y >/dev/null \
 && npm i --ignore-scripts --no-audit --no-fund --no-save @huggingface/transformers@3.8.1 \
 && node -e "const{pipeline,env}=require('@huggingface/transformers');env.cacheDir='/opt/fleet-embed/models';pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:'q8'}).then(()=>console.log('model cached'))"
RUN FLEET_HOST_EMBED_DIR=/opt/fleet-embed node /src/out/host/fleet-host.mjs embed-selftest | grep -q '"dim":384'
```

- In the runtime stage, after `COPY --from=host-build /src/out/host/ /usr/local/lib/fleet-host/`, add:

```dockerfile
COPY --from=host-build /opt/fleet-embed/ /usr/local/lib/fleet-host/embed/
```

  The existing `chmod 0644` `find` already covers it. Executable bits on `.node` files aren't needed.
- Add `FLEET_HOST_EMBED_DIR=/usr/local/lib/fleet-host/embed` to the `ENV` block.

- [ ] **Step 4: Run the tests and the bundle, then build the image**

Run:
```bash
npx vitest run src/host/embedder.test.ts src/host/importGraph.test.ts
npx tsc -p tsconfig.host.json
npx vite build --config vite.host.config.ts && ls out/host/embed-worker.mjs
docker build -f docker/host/Dockerfile -t fleet-host-d2 . 2>&1 | tail -5   # skip if no Docker here; CI's test-runner-images builds it
```
Expected: the tests pass; the bundle has `embed-worker.mjs`; the image build's selftest line passes. Without Docker in this container, note it in the PR and rely on CI (the import-graph test already requires the files in the build context).

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/embedWorker.ts src/host/embedder.ts src/host/embedder.test.ts src/host/cli.ts vite.host.config.ts docker/host/Dockerfile src/host/importGraph.test.ts
git -C "$W" commit -m "feat(host): embedding model in a worker, baked into the host image (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Host indexer on the holder

**Files:**
- Create: `src/host/hostIndexer.ts`
- Modify: `src/host/holder.ts`, `src/host/importGraph.test.ts` (allow `main/transcriptIndexCore.ts`)
- Test: `src/host/hostIndexer.test.ts`, `src/host/hostIndexer.pg.test.ts` (add to `vitest.pg.config.ts`)

**Interfaces:**
- Consumes: `indexSessionTurnsWith` (Task 1), `listSessionIds`, `deleteEmbeddingsForOtherModels` (db.ts), `HostEmbedder` (Task 2), `onIngested` (d1 Task 4).
- Produces:
  - `startHostIndexer(o: { embed: EmbedFn; log: Logger; index?: (id: string) => Promise<number> }): HostIndexer`.
  - `HostIndexer { backfill(): Promise<void>; bump(sessionId: string): void; stop(graceMs?: number): Promise<void> }`.

- [ ] **Step 1: Write the failing tests.**

`src/host/hostIndexer.test.ts` (fake `index`):

```ts
import { describe, expect, it } from 'vitest';
import { startHostIndexer } from './hostIndexer.js';
import { createLogger } from './log.js';

describe('host indexer', () => {
  it('runs one session at a time and coalesces repeat bumps', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async (id) => { calls.push(id); if (id === 'a') await gate; return 0; } });
    ix.bump('a'); ix.bump('b'); ix.bump('b'); ix.bump('a');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['a']);
    release();
    await ix.stop(1000);
    expect(calls).toEqual(['a', 'b', 'a']);
  });

  it('logs a failure and keeps going', async () => {
    const logs: string[] = [];
    const ix = startHostIndexer({ embed: async () => [], log: createLogger((l) => logs.push(l)),
      index: async (id) => { if (id === 'x') throw new Error('boom'); return 1; } });
    ix.bump('x'); ix.bump('y');
    await ix.stop(1000);
    expect(logs.some((l) => l.includes('transcript index failed'))).toBe(true);
  });
});
```

`src/host/hostIndexer.pg.test.ts`: on an `openTestState()` Postgres store, ingest two turns for one session with `db.ingestBatch`. Run `startHostIndexer({ embed: async (t) => t.map(() => unit()) , log })` with `unit()` returning a 384-dim unit vector. Call `backfill()`, then expect 2 rows in `embeddings` for `EMBED_MODEL_ID`. Call `backfill()` again and expect no new rows.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/hostIndexer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `src/host/hostIndexer.ts`:

```ts
// Embeds the hosted workspace's turns: a backfill at holder start, then one
// pass per ingested session, serially. Inserts are fenced store writes.
import { deleteEmbeddingsForOtherModels, listSessionIds } from '../main/db.js';
import { indexSessionTurnsWith } from '../main/transcriptIndexCore.js';
import { EMBED_MODEL_ID, type EmbedFn } from '../main/vectors.js';
import type { Logger } from './log.js';

export interface HostIndexer { backfill(): Promise<void>; bump(sessionId: string): void; stop(graceMs?: number): Promise<void> }

const noSpan = <T>(_n: string, fn: () => Promise<T>): Promise<T> => fn();

export function startHostIndexer(o: { embed: EmbedFn; log: Logger; index?: (id: string) => Promise<number> }): HostIndexer {
  const index = o.index ?? ((id: string) => indexSessionTurnsWith(noSpan, id, o.embed));
  const queued = new Set<string>();
  let running: Promise<void> | null = null;
  let stopped = false;
  const drain = async (): Promise<void> => {
    while (!stopped && queued.size) {
      const [id] = queued;
      queued.delete(id);
      try {
        await index(id);
      } catch (err) {
        o.log.log('warn', 'transcript index failed', { sessionId: id, error: (err as Error).message });
      }
    }
    running = null;
  };
  const bump = (id: string): void => {
    if (stopped) return;
    queued.add(id);
    running ??= drain();
  };
  return {
    bump,
    async backfill() {
      await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID);
      for (const id of await listSessionIds()) bump(id);
    },
    async stop(graceMs = 2_000) {
      const inflight = running;
      if (inflight) await Promise.race([inflight, new Promise((r) => setTimeout(r, graceMs).unref?.())]);
      stopped = true;
      queued.clear();
    }
  };
}
```

In the unit test, `stop` drains before setting `stopped`, so queued work finishes inside the grace window. That matches the expected calls.

`src/host/holder.ts`:
- Add `embedDir: string` to `HolderOptions`. `main.ts` passes `process.env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR`.
- After `stores` open, build `const embedder = startEmbedder({ dir: o.embedDir, log: o.log });` and `const indexer = startHostIndexer({ embed: embedder.embed, log: o.log });`.
- `HostIngest`'s `onIngested` becomes `(id) => { hint.bump(); indexer.bump(id); }`.
- After `await ingest.start();`, call `void indexer.backfill().catch((err: Error) => o.log.log('warn', 'index backfill failed', { error: err.message }));`.
- In `stopAll`, after `await automations?.stop();` and before `await ingest.stop();`: `await indexer.stop(); await embedder.close();`.
- Add `/^main\/transcriptIndexCore\.ts$/` to `MAIN_ALLOWED` in `importGraph.test.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/hostIndexer.pg.test.ts src/host/main.pg.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass. `main.pg.test.ts` starts holders with no model on disk: the backfill's first `embed` fails in the worker, which is logged (`transcript index failed`) and doesn't fail the holder.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/hostIndexer.ts src/host/hostIndexer.test.ts src/host/hostIndexer.pg.test.ts src/host/holder.ts src/host/main.ts src/host/importGraph.test.ts vitest.pg.config.ts
git -C "$W" commit -m "feat(host): index hosted turns into embeddings on the holder (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `search_transcripts` on the host MCP

**Files:**
- Modify: `src/main/mcpCore.ts`, `src/host/hostMcp.ts`, `src/host/holder.ts`
- Test: `src/host/hostMcp.test.ts`

**Interfaces:**
- Produces:
  - `setQueryEmbedder(fn: EmbedFn | null)`.
  - `startHostMcp({ …, embed?: EmbedFn })`.
  - `HOST_MCP_TOOLS` gains `'search_transcripts'` (15).

- [ ] **Step 1: Write the failing test.** In `src/host/hostMcp.test.ts`:
- Update the d1 assertion to `HOST_MCP_TOOLS.has('search_transcripts') === true` and size 15.
- Add a case: start the host MCP with a fake read source whose `searchEmbeddings` returns one hit and records its scope, and `embed: async (t) => t.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)))`. Call `search_transcripts` `{ query: 'x' }` and expect one hit and a scope of exactly `{hosted}`. Call `search_transcripts` `{ query: 'x', workspace_id: 'other' }` and expect `[]`.
- After `close()`, a second MCP started without `embed` answers `search_transcripts` with `transcript search index is unavailable`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/hostMcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `mcpCore.ts`: `export function setQueryEmbedder(fn: EmbedFn | null): void { queryEmbedder = fn; }`.
  - `hostMcp.ts`:
    - Add `'search_transcripts'` to `HOST_MCP_TOOLS`.
    - Add `embed?: EmbedFn` to the options.
    - After `initReadSource(o.readSource);`, call `setQueryEmbedder(o.embed ?? null);`.
    - In `reset()`, call `setQueryEmbedder(null);`.
  - `holder.ts`: pass `embed: embedder.embed` to `startHostMcp`, through the `mcpServer` helper.
  - `noteSearchResults` records `search-impression` usage rows. On the host these are fenced writes under the hosted workspace, which is correct (spec §7 *Usefulness signals*: own sessions' marks don't count, which is (e)'s rule).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ src/main/mcpCore*.test.ts src/main/mcpServer*.test.ts && npx tsc -p tsconfig.host.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass; clean. The desktop's `tools/list` snapshot is unchanged.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/mcpCore.ts src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/holder.ts
git -C "$W" commit -m "feat(host): search_transcripts on the host MCP (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `history:search` RPC

**Files:**
- Modify: `src/host/historyRead.ts`, `src/host/historyRpc.ts`
- Test: `src/host/historyRpc.test.ts`, `src/host/historyRead.pg.test.ts`

**Interfaces:**
- Produces:
  - `SEARCH_LIMIT_MAX = 50`, `SEARCH_TEXT_MAX = 1000`.
  - `parseSearchReq(v): { vector: Float32Array; limit: number; kind?: 'turn' | 'summary' }`, which throws `HistoryArgError`, including on `model mismatch: host uses <EMBED_MODEL_ID>`.
  - `HistoryReader.search(req): Promise<{ modelId: string; hits: EmbeddingHit[] }>`.
  - The `history:search` channel (`read`).

- [ ] **Step 1: Write the failing tests.**

In `src/host/historyRpc.test.ts`:

```ts
it('history:search validates the vector and model', async () => {
  const r = { ...reader(), search: vi.fn(async () => ({ modelId: 'm', hits: [] })) };
  const reg = historyRpcChannels(() => r as never);
  const unit = Array(384).fill(1 / Math.sqrt(384));
  expect((await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: EMBED_MODEL_ID, limit: 10 }] }, caller)).status).toBe(200);
  expect(r.search.mock.calls[0][0].vector).toBeInstanceOf(Float32Array);
  for (const bad of [
    { vector: unit, modelId: 'other@fp32', limit: 10 },
    { vector: unit.slice(1), modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: Array(384).fill(1), modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: [...unit.slice(1), NaN], modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: unit, modelId: EMBED_MODEL_ID, limit: 51 },
  ]) expect((await dispatchRpc(reg, 'history:search', { args: [bad] }, caller)).status).toBe(400);
});
```

Import `EMBED_MODEL_ID` from `../main/vectors.js`.

In `src/host/historyRead.pg.test.ts`, add: insert two embeddings for the hosted workspace and one for `OTHER` (unit vectors, `EMBED_MODEL_ID`). `historyReader(() => k, HOSTED).search({ vector, limit: 10 })` returns only hosted hits, `modelId === EMBED_MODEL_ID`, and every `text.length ≤ 1000`.

- [ ] **Step 2: Run them to verify they fail.**

Run: `npx vitest run src/host/historyRpc.test.ts && npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** `src/host/historyRead.ts`:

```ts
import { EMBED_DIM, EMBED_MODEL_ID } from '../main/vectors.js';
import { pgSearchEmbeddings } from '../main/store/pgVectorSearch.js';
import type { EmbeddingHit } from '../main/db.js';

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_TEXT_MAX = 1000;
export interface SearchReq { vector: Float32Array; limit: number; kind?: 'turn' | 'summary' }

export function parseSearchReq(v: unknown): SearchReq {
  const o = v as { vector?: unknown; modelId?: unknown; limit?: unknown; kind?: unknown } | null;
  if (!o || typeof o !== 'object') throw new HistoryArgError('expected {vector, modelId, limit}');
  if (o.modelId !== EMBED_MODEL_ID) throw new HistoryArgError(`model mismatch: host uses ${EMBED_MODEL_ID}`);
  if (!Array.isArray(o.vector) || o.vector.length !== EMBED_DIM) throw new HistoryArgError(`vector must have ${EMBED_DIM} numbers`);
  const vec = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const x = o.vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new HistoryArgError('vector must be finite numbers');
    vec[i] = x;
    norm += x * x;
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) throw new HistoryArgError('vector must be unit length');
  const limit = o.limit === undefined ? 10 : o.limit;
  if (!int(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new HistoryArgError(`limit must be 1-${SEARCH_LIMIT_MAX}`);
  if (o.kind !== undefined && o.kind !== 'turn' && o.kind !== 'summary') throw new HistoryArgError('kind must be turn or summary');
  return { vector: vec, limit, kind: o.kind };
}
```

- Add `search(req: SearchReq): Promise<{ modelId: string; hits: EmbeddingHit[] }>` to `HistoryReader`.
- In `historyReader`:

```ts
    async search(req) {
      const hits = await readTransaction(k(), (q) => pgSearchEmbeddings(q, req.vector, [workspaceId], { limit: req.limit, kind: req.kind }));
      return { modelId: EMBED_MODEL_ID, hits: hits.map((h) => ({ ...h, text: h.text.slice(0, SEARCH_TEXT_MAX), score: Number(h.score), ts: h.ts === null ? null : Number(h.ts) })) };
    },
```

`historyRpc.ts`: add `['history:search', { tier: 'read', handle: ([req]) => guarded(() => need().search(parseSearchReq(req))) }]`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/historyRead.ts src/host/historyRpc.ts src/host/historyRpc.test.ts src/host/historyRead.pg.test.ts
git -C "$W" commit -m "feat(host): history:search over a caller-supplied query vector (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Desktop federated search

**Files:**
- Create: `src/main/federation/searchMerge.ts`
- Modify: `src/main/federation/remoteRows.ts`, `src/main/federation/federatedReader.ts`, `src/main/federation/federationIpc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/preload/federation.ts`
- Test: `src/main/federation/searchMerge.test.ts`, `src/main/federation/remoteRows.test.ts`, `src/main/federation/federatedReader.test.ts`, `src/main/store/pgVectorSearch.test.ts` (score parity; add to `vitest.pg.config.ts`)

**Interfaces:**
- Produces (in `preload/federation.ts`):
  - `SearchHitItem { origin; sessionId; workspaceId; workspaceName; kind; ts; text; score }`.
  - `FederatedSearchResult { hits: SearchHitItem[]; unavailable: UnavailableSource[] }`.
- Produces (elsewhere):
  - `mergeHits(sources: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[], limit: number): SearchHitItem[]`.
  - `parseSearchReply(v, workspaceId): { modelId: string; hits }`.
  - `FederatedReader.search(o: { vector: Float32Array; limit: number; origins: string[] }): Promise<{ remote: { origin; hits }[]; unavailable }>`.
  - IPC `history:search(query: string, opts: { scope: 'all' | string; limit?: number })` → `FederatedSearchResult`.

- [ ] **Step 1: Write the failing tests.**

`src/main/federation/searchMerge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeHits } from './searchMerge';

const h = (sessionId: string, score: number, ts = 1) => ({ sessionId, workspaceId: 'W', workspaceName: 'w', kind: 'turn' as const, ts, text: 't', score });
describe('mergeHits', () => {
  it('orders by score, ties by origin, session and ts, and cuts at limit', () => {
    const out = mergeHits([{ origin: 'local', hits: [h('a', 0.9), h('b', 0.5)] }, { origin: 'H', hits: [h('c', 0.9), h('d', 0.7)] }], 3);
    expect(out.map((x) => `${x.origin}:${x.sessionId}`)).toEqual(['H:c', 'local:a', 'H:d']);
  });
});
```

`remoteRows.test.ts`, add: `parseSearchReply({ modelId: 'm', hits: [{ sessionId: 's', workspaceId: W, kind: 'turn', ts: 1, text: 'x'.repeat(5000), score: 0.4 }, { …score: NaN }] }, W)` keeps one hit with text length 1000, and throws `RemoteShapeError` on a missing `modelId` or more than 50 hits.

`federatedReader.test.ts`, add:
- `search` only calls the origins it is given;
- a host whose reply `modelId` differs is listed `unavailable` with reason `model`, and its hits are absent;
- the RPC args are `[{ vector: number[], modelId: EMBED_MODEL_ID, limit }]`.

`src/main/store/pgVectorSearch.test.ts` (PG). Score parity, D64: insert 20 random unit vectors. For a random unit query, `pgSearchEmbeddings` scores equal `dot(q, v)` from `vectors.ts` within 1e-5, and the order matches `topK` except within ties under 1e-6.

- [ ] **Step 2: Run them to verify they fail.**

Run: `npx vitest run src/main/federation/ && npx vitest run -c vitest.pg.config.ts src/main/store/pgVectorSearch.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement.**

`src/preload/federation.ts`, append:

```ts
export interface SearchHitItem {
  origin: Origin;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}
export interface FederatedSearchResult { hits: SearchHitItem[]; unavailable: UnavailableSource[] }
```

`src/main/federation/searchMerge.ts`:

```ts
// Federated search merge (D64): every source scores cosine similarity on the
// same model, so scores sort together.
import { compareBytes, type SearchHitItem } from '../../preload/federation.js';

export function mergeHits(sources: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[], limit: number): SearchHitItem[] {
  const all = sources.flatMap((s) => s.hits.map((h) => ({ ...h, origin: s.origin })));
  all.sort((a, b) => b.score - a.score || compareBytes(a.origin, b.origin) || compareBytes(a.sessionId, b.sessionId) || (a.ts ?? 0) - (b.ts ?? 0));
  return all.slice(0, limit);
}
```

`remoteRows.ts`, add:

```ts
export function parseSearchReply(v: unknown, workspaceId: string): { modelId: string; hits: { sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; score: number }[] } {
  const o = v as { modelId?: unknown; hits?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.modelId !== 'string' || !Array.isArray(o.hits) || o.hits.length > 50) return fail('search reply');
  const hits = [];
  for (const raw of o.hits) {
    const h = raw as Record<string, unknown> | null;
    const ts = natOrNull(h?.ts);
    if (!h || typeof h.sessionId !== 'string' || !ID_RE.test(h.sessionId) || h.workspaceId !== workspaceId) continue;
    if ((h.kind !== 'turn' && h.kind !== 'summary') || ts === undefined || typeof h.text !== 'string') continue;
    if (typeof h.score !== 'number' || !Number.isFinite(h.score) || h.score < -1.0001 || h.score > 1.0001) continue;
    hits.push({ sessionId: h.sessionId, workspaceId, kind: h.kind, ts, text: h.text.replace(/[\x00-\x08\x0b-\x1f\x7f\p{Cf}]/gu, ' ').slice(0, 1000), score: h.score });
  }
  return { modelId: oneLine(o.modelId, 128), hits };
}
```

Search text keeps newlines; React renders it as text with `white-space: pre-wrap`.

`federatedReader.ts`:
- Import `EMBED_MODEL_ID` from `../vectors.js` and `parseSearchReply`.
- Add to the interface and implementation:

```ts
    async search(o) {
      const targets = d.sources().filter((s) => o.origins.includes(s.id));
      const remote: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[] = [];
      const unavailable: UnavailableSource[] = [];
      const vector = Array.from(o.vector);
      await Promise.all(targets.map(async (s) => {
        const r = await call(s, 'history:search', [{ vector, modelId: EMBED_MODEL_ID, limit: o.limit }], (v) => parseSearchReply(v, s.id));
        if (!r.ok) return void unavailable.push({ origin: s.id, name: s.name, reason: r.reason });
        if (r.value.modelId !== EMBED_MODEL_ID) return void unavailable.push({ origin: s.id, name: s.name, reason: 'model' });
        remote.push({ origin: s.id, hits: r.value.hits.map((h) => ({ ...h, workspaceName: s.name })) });
      }));
      return { remote, unavailable: byOrigin(unavailable) };
    },
```

A host refusing the model with 400 surfaces as `protocol`. The modelId check covers a host that answers with its own id.

`federationIpc.ts`: add a `search` dependency and the handler:

```ts
export interface LocalSearch {
  /** null: the local embedder isn't ready. */
  embed(query: string): Promise<Float32Array | null>;
  hits(vector: Float32Array, scope: string, limit: number): Promise<Omit<SearchHitItem, 'origin'>[]>;
  localIds(): Promise<Set<string>>;
}

ipc.handle('history:search', async (_e, query: unknown, opts: unknown) => {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('query must be 1-2000 characters');
  const o = (opts ?? {}) as { scope?: unknown; limit?: unknown };
  const scope = o.scope === 'all' ? 'all' : typeof o.scope === 'string' && ID_RE.test(o.scope) ? o.scope : null;
  if (!scope) throw new Error("scope must be 'all' or a workspace id");
  const limit = typeof o.limit === 'number' && Number.isSafeInteger(o.limit) ? Math.min(Math.max(o.limit, 1), 50) : 20;
  const vector = await search.embed(query.trim());
  if (!vector) throw new Error('transcript search index is unavailable');
  const local = await search.localIds();
  const origins = reader.sources().filter((s) => scope === 'all' || s.id === scope).map((s) => s.id);
  const [mine, fed] = await Promise.all([
    scope === 'all' || local.has(scope) ? search.hits(vector, scope, limit) : Promise.resolve([]),
    reader.search({ vector, limit, origins })
  ]);
  return { hits: mergeHits([{ origin: LOCAL_ORIGIN, hits: mine }, ...fed.remote], limit), unavailable: fed.unavailable };
});
```

`registerFederationIpc(ipc, reader, search)` gains the third parameter. Add `sources(): RemoteSourceInfo[]` to `FederatedReader`, returning `d.sources()`.

`ipc.ts`: pass `search`:
- `embed`: uses the embedder `index.ts` already makes, through a setter `setFederatedEmbedder(fn)` that `index.ts` calls next to `setQueryEmbedder`. It returns null until that setter runs.
- `hits(vector, scope, limit)`: calls `db.searchEmbeddings(vector, scope === 'all' ? [...localIds] : [scope], { limit })`, then maps each hit to add `workspaceName` from the manifest list.
- `localIds()`: the ids of non-remote manifests.

`preload/index.ts`: add `history: { search: (query: string, opts: { scope: 'all' | string; limit?: number }): Promise<FederatedSearchResult> => ipcRenderer.invoke('history:search', query, opts) }`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/ src/preload/ && npx vitest run -c vitest.pg.config.ts src/main/store/pgVectorSearch.test.ts && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/federation/ src/main/ipc.ts src/main/index.ts src/preload/index.ts src/preload/federation.ts src/main/store/pgVectorSearch.test.ts vitest.pg.config.ts
git -C "$W" commit -m "feat(federation): federated transcript search merged by score with model check (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Transcript search UI in the Sessions pane

**Files:**
- Create: `src/renderer/src/components/TranscriptSearch.tsx`
- Modify: `src/renderer/src/components/SessionsPane.tsx`, the Sessions stylesheet, `src/renderer/src/sessionsView.ts`
- Test: `src/renderer/src/sessionsView.test.ts`

**Interfaces:**
- Consumes: `window.api.history.search`, `SearchHitItem`, `unavailableText`, `CloudGlyph` ((d1)).
- Produces:
  - `searchTargets(scope, selectedWorkspaceId, remoteNames: Record<string, string>, isLocal: (id) => boolean): { scope: 'all' | string; label: string } | null`.
  - `<TranscriptSearch scope=… onPick={(hit) => …} />`.

- [ ] **Step 1: Write the failing test.** In `sessionsView.test.ts`:

```ts
describe('searchTargets', () => {
  const names = { R1: 'review-bot', R2: 'triage' };
  it('names who receives the query', () => {
    expect(searchTargets('all', null, names, () => false)).toEqual({ scope: 'all', label: 'Searching this desktop + review-bot, triage' });
    expect(searchTargets('workspace', 'R1', names, () => false)).toEqual({ scope: 'R1', label: 'Searching review-bot' });
    expect(searchTargets('workspace', 'L1', names, (id) => id === 'L1')).toEqual({ scope: 'L1', label: 'Searching this desktop' });
    expect(searchTargets('workspace', null, names, () => false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`sessionsView.ts`:

```ts
export function searchTargets(
  scope: 'workspace' | 'all', selected: string | null, remoteNames: Record<string, string>, isLocal: (id: string) => boolean,
): { scope: 'all' | string; label: string } | null {
  if (scope === 'all') {
    const r = Object.values(remoteNames);
    return { scope: 'all', label: `Searching this desktop${r.length ? ` + ${r.join(', ')}` : ''}` };
  }
  if (!selected) return null;
  return { scope: selected, label: isLocal(selected) || !remoteNames[selected] ? 'Searching this desktop' : `Searching ${remoteNames[selected]}` };
}
```

`TranscriptSearch.tsx`: a form with an input (`aria-label="Search transcripts"`, placeholder `Search transcript content…`) and a `Search` button. It submits on Enter, never per keystroke, because each search embeds and fans out.
- It shows the target label.
- While running, it shows `Searching…`.
- It lists hits as buttons. Each shows the cloud glyph for remote origins, the workspace name, a relative time, the score as `(0.83)`, and `text` in a `<span className="hit-text">` with `white-space: pre-wrap` and a 4-line clamp.
- Below the list it shows `unavailableText(result.unavailable)`.
- A thrown error such as `transcript search index is unavailable` shows as the message text.
- `onPick(hit)` is called on click.

`SessionsPane.tsx`:
- Add a `Transcripts` toggle button next to the search box (`aria-pressed`). When on, it renders `<TranscriptSearch …/>` above the list.
- `onPick` sets the existing text query to `hit.sessionId` and scrolls the matching `li[data-sid]` into view. `filterSessions` must match on id: if it doesn't already, extend it to match `s.id === q`, with a test case in `sessionsView.test.ts`.
- Remote names and the local check come from props `remoteTiers` ((d1)) plus a new `remoteNames?: Record<string, string>`, passed from `App` the same way.

- [ ] **Step 4: Run the renderer tests, typecheck and build.**

Run: `npx vitest run src/renderer/ && npx tsc --noEmit -p tsconfig.web.json && npm run build`
Expected: all pass; clean; the build succeeds, or the environment block is recorded.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/renderer/src/components/TranscriptSearch.tsx src/renderer/src/components/SessionsPane.tsx src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts src/renderer/src/components/LeftRail.tsx src/renderer/src/App.tsx
git -C "$W" commit -m "feat(sessions): transcript search across local and remote with origin badges (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Also stage the stylesheet you edited.

---

### Task 8: SPEC.md and the full gate

- [ ] **Step 1: Update SPEC.md.**
1. **§6:** add a `### History search` entry (or a bullet under *Sessions*) describing `history:search(query, { scope, limit })` → `{ hits, unavailable }`:
   - The desktop embeds once.
   - Local is `searchEmbeddings`.
   - A remote is `history:search` with the vector, only to the hosts in scope (D67).
   - Merge by score, then origin, session and ts (D64).
   - A source with another `modelId` is listed `unavailable` with reason `model`.
2. **§7 *JSONL→SQLite cache* → *Search*:** add the parity note (D64): SQLite dot and pgvector `1 − <=>` both equal cosine on unit float32 vectors, pinned within 1e-5 by `pgVectorSearch.test.ts`.
3. **§7 *Remote host*:**
   - **RPC channels:** add `history:search` (`read`; `[{ vector[384], modelId, limit ≤ 50, kind? }]` → `{ modelId, hits }`; `model mismatch` 400; text ≤ 1000).
   - ***Ingest*:** replace "no embeddings or summaries on the host" with "turns are embedded by the holder's indexer (`hostIndexer.ts`): backfill at start, then per ingested session, serially, fenced; no summaries".
   - ***Host MCP* *Tools*:** 15, adding `search_transcripts`, which embeds in the worker.
   - **A new *Embedder* paragraph:** `embedWorker.ts` in a `worker_thread`; transformers 3.8.1 + onnxruntime-node 1.21.0 CPU and the q8 weights under `/usr/local/lib/fleet-host/embed` (`FLEET_HOST_EMBED_DIR`), `allowRemoteModels = false`; a crashed worker fails in-flight calls and restarts on the next; `fleet-host embed-selftest`; about 300 MB steady, so raise the pod memory request by 512 Mi.
   - **Env contract table:** add `FLEET_HOST_EMBED_DIR`.
4. **§4 *Host images*:** the embed stage and the build-time selftest.
5. **§11 *Remote host: what remains*:** remove the `search_transcripts` bullet. Keep the HNSW trigger (D44/D70): revisit when host p50 exceeds 250 ms or one scope exceeds 250k rows, which becomes likely after (e).

- [ ] **Step 2: Run the full gate** (as (d1) Task 10 Step 2), plus `docker build -f docker/host/Dockerfile .` where Docker is available.
- [ ] **Step 3: Commit** `docs(spec): host embedder, history:search, federated search (remote d2)` with the trailer.

## Questions for Troy

1. **Host image size and memory (D65).** The embed stage adds transformers, onnxruntime-node and the q8 weights, roughly 150–250 MB on disk, and about 300 MB RSS while indexing. OK for the review-bot pod, or should host search wait until (e) gives it people's transcripts to search?

## Self-review notes

- **Coverage:**
  - Search merge by score with the model check (D64, Task 6).
  - The metric is verified by a test, not assumed.
  - The host embedder (D65, Tasks 2–3).
  - `search_transcripts` on the host (Task 4).
  - `history:search` with scope enforcement (Task 5).
  - Search-backed UI with badges and unavailable sources (Task 7).
  - Live-only: no hit is persisted.
  - Performance: the worker thread, enter-to-search, the 3 s bound.
- **Types:**
  - `SearchHitItem` and `FederatedSearchResult` live in `preload/federation.ts`.
  - `parseSearchReq`/`SearchReq` are on the host; `parseSearchReply` is on the desktop.
  - The `UnavailableReason` `'model'` was already declared in (d1) Task 1.
