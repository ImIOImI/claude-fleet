# Remote workspaces (d2): `search_transcripts` on the host and federated search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Revisions (2026-11-10): owner decisions

- **D82: the host images are amd64 only.** No node group runs arm64 (Troy, 2026-11-10). This supersedes the arm64 half of D76 and Questions 1:
  - `publish-runner.yml` and `test-runner-images.yml` build `runner-host` and `runner-devops-host` for `linux/amd64` only; other runner variants keep their platforms.
  - The `embedder-build` stage and `ci-build.sh` still read `uname -m`, but `install-zigbuild.sh` supports only `x86_64` and exits non-zero with `unsupported arch` otherwise. Drop the aarch64 pins and tests from Task 2.
  - D78's reference check runs on amd64 only.
- **D83: the size and memory budget is approved** (Troy, 2026-11-10): about +61 MB per host image, and +256 Mi on the host pod's memory request. This settles Questions 2.

## Revisions (2026-11-09)

The plan was written before #531 (Rust `fleet-embedder` sidecar) and #537 ((d1), `c3d6ebe`) merged, and before D71–D73 were settled. Changes:

- **D65 rewritten for the sidecar.** The host runs `fleet-embedder` as a child of `fleet-host` through `src/main/embedderClient.ts`. The transformers.js install in the image, the `worker_thread` (`embedWorker.ts`), the externalized `@huggingface/transformers` and `embed-selftest` are gone. The sidecar is already a separate process.
- **New decisions D75–D81:** the host wrapper with no in-process fallback (D75); a multi-stage image build that reuses `ci-build.sh` on amd64 and arm64 (D76); weights pinned to a revision and a committed sha256 manifest, read-only in the image (D77, D72 safeguard 1); a build-time embed check against committed reference vectors instead of `embed-selftest` (D78); the `search.embedder` off-switch (D79, D72 safeguard 2); the sidecar's environment and file modes (D80); and placement under the two-pod split (D81, D73).
- **D71 recorded:** nothing in (d2) creates roles. The app role stays `NOCREATEROLE`.
- **(d1) APIs used as merged:** `historyRpcChannels(reader)`, `RpcUnavailableError` → 503, `FederatedReader.call`, `parseSessionsPage`'s validation style, the `UnavailableReason` union (which already has `'model'`), and `onIngested(sessionId)`. A new reason, `'disabled'`, maps from 503 `search unavailable`.
- **Tasks:**
  - Task 1 (indexing core) is kept.
  - Old Task 2 (worker and image) is replaced by Tasks 2–5: the build script, the pins and reference, the host embedder, and the image.
  - Task 6 (config) is new.
  - Old Tasks 3–8 become Tasks 7–12, rewritten for the new APIs.
- **Memory:** measured on the sidecar, not on transformers.js. Peak RSS is 102 MiB embedding the 40-text parity corpus (dev build, x64). The pod request goes up by 256 Mi, not 512 Mi.

---

**Goal:** A remote host embeds its own sessions' turns and serves `search_transcripts` to its sessions. The desktop's Sessions pane gets a transcript search that merges local hits with hits from remote hosts by score, with origin badges and unavailable sources.

**Architecture:**
- **Host embedder.** The host image ships the `fleet-embedder` binary and the pinned q8 weights. Both are built and checked at image build. The holder spawns the sidecar through `EmbedderClient`; model load and inference never run in `fleet-host`'s process. There is no fallback: a missing or crash-looping sidecar means search is unavailable.
- **Indexer.** The holder embeds new turns after each ingest commit, plus a backfill at start. It uses a perf-free copy of the desktop's indexing loop. Every insert is a fenced write.
- **Host MCP.** It serves `search_transcripts` with that embedder.
- **RPC.** A `read`-tier `history:search` takes a query **vector** and its model id, never text. The host runs only the exact pgvector scan.
- **Off-switch.** `search: { embedder: false }` in the ConfigMap turns off all of the above.
- **Desktop.** The desktop embeds the query once. `FederatedReader.search` runs the local search and the remote calls in parallel (liveness-gated, 3 s). It drops sources whose model id differs and merges by score.

**Tech Stack:** as (d1), plus the `fleet-embedder` crate (`embedder/`, Rust 1.91, `ort` 2.0.0-rc.10 = onnxruntime 1.22, `tokenizers` 0.21), zig 0.14.1 + cargo-zigbuild 0.24.1 at image build, and Docker BuildKit.

**Spec:**
- Remote-workspaces design §7 (*Semantic search results merge by score…*, *Vector search is per backend*) and §11 (d).
- `docs/SPEC.md`:
  - §4 *Host images*, *Embedder sidecar binary*;
  - §7 *Local embeddings*;
  - §7 *JSONL→SQLite cache* (*Search*);
  - §7 *Remote host* (*Ingest*, *Host MCP*).
- Sidecar: `docs/superpowers/specs/2026-11-06-rust-embedder-sidecar-design.md`, `embedder/README.md`.
- Split: `docs/superpowers/specs/2026-11-05-host-container-split-design.md` (D71, D73).
- (d1): `2026-11-06-remote-d1-federated-history.md` (D53–D63, D69–D70).
- Part 4a: D43/D44.

**Gate:** (d1) is merged (#537, `c3d6ebe`); the sidecar is merged (#531).

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
- **The host never fetches model files.** The weights come only from the image (D77). The host import graph must not reach `src/main/embeddings.ts` (Electron, transformers.js fallback) or `src/main/embedderModelFiles.ts` (Hub download). `importGraph.test.ts` enforces this through its allowlist.
- **`fleet-host`'s event loop never runs the model.** Inference runs in the sidecar process (D75).
- **No `CREATEROLE` (D71).**
  - Indexing writes as the app role, fenced.
  - `history:search` reads through `readTransaction` on the holder's state handle.
  - `search_transcripts` reads through the read source's state handle, not the `query` login.
  - Nothing in (d2) creates or alters a role.
- **Both layouts.** (d2) works in today's single-container host image (`fleet-host-entry` as built) and needs no change under the two-pod split (D81).
- The `.dockerignore` opt-ins, the `publish-runner.yml`/`test-runner-images.yml` path filters and `importGraph.test.ts` move together. A file in the host graph or the embedder build that misses one of them fails `importGraph.test.ts`.

## Decisions (D64–D68, D75–D81; recorded in SPEC.md by Task 12)

(d1) recorded D69 (`onIngested`) and D70 (HNSW deferred). D71–D74 are taken elsewhere: D71 is the `query` login, D72 the host embedder amendment, D73 the two-pod split.

- **D64: Scores are comparable; checked, not assumed.**
  - Both dialects store the same L2-normalized float32 vectors (`EMBED_DIM` 384).
  - SQLite scores a dot product. For unit vectors, that is cosine similarity.
  - Postgres scores `1 − (vec <=> q)`. `<=>` is cosine distance, so that is cosine similarity too.
  - The two differ only by float rounding (≤ 1e-6). Task 10 pins this with a fixture: the same vectors scored both ways agree to 1e-5.
  - Across machines, the sidecar's output is checked against committed reference vectors on every image build and arch (D78). A different CPU's q8 kernels can't silently shift scores.
  - **Every source reports `modelId`** (`EMBED_MODEL_ID`). A remote source with a different `modelId` is dropped and listed `unavailable` with reason `model`.
  - **Merge:** by score descending, then origin, `sessionId` and `ts`. Hits are not deduplicated: two turns are two hits.
- **D65: The host gets its own embedder: the `fleet-embedder` sidecar, in the image (D72).**
  - The holder spawns `/usr/local/lib/fleet-host/embed/fleet-embedder --model-dir /usr/local/lib/fleet-host/embed/model` (`FLEET_HOST_EMBED_DIR`) through `EmbedderClient`, with the same protocol, timeouts, backoff and crash-loop rule as the desktop.
  - The image builds the binary (D76) and bakes in the pinned weights (D77). It runs a real embed at build (D78).
  - **Memory:** the sidecar peaked at 102 MiB RSS (VmHWM) embedding the 40-text parity corpus at ≤ 1000 characters and batch 8 (dev build, x64, 2026-11-09). `fleet-host embed-check` prints the figure on every image build. The reference deployment's memory request goes up by 256 Mi (Task 12 records it).
  - **Rejected:**
    - The desktop indexing the host's sessions: it breaks one-writer-per-workspace (spec §2).
    - A separate embedding Deployment: another workload and Service for one model, plus a network hop per batch.
    - transformers.js in the image: about 150–250 MB on disk, plus the in-process stall #531 removed from the desktop.
- **D66: `history:search` takes a vector, not text.**
  - Args: `[{ vector: number[384], modelId, limit ≤ 50, kind? }]`.
  - The host checks:
    - `modelId === EMBED_MODEL_ID` (otherwise 400 `model mismatch: host uses <id>`);
    - length 384, every element finite, a norm within 1e-3 of 1;
    - `limit` 1–50.
  - A `read` viewer therefore can't make the host spend model CPU. The scan is part 4a's exact pgvector query over `{hosted}` (D43).
  - The reply is `{ modelId, hits: EmbeddingHit[] }`, with `text` capped at 1000 characters on both sides.
  - The host's own `search_transcripts` MCP tool embeds text in the sidecar, as on the desktop.
  - D72's "`search:*` RPC" is this channel. There is no other search channel.
- **D67: A query vector goes only to hosts the user is searching.**
  - Search follows the Sessions pane's scope:
    - **This workspace:** the selected workspace's origin only (local or that host).
    - **All:** local plus every reachable remote bookmark.
  - The search box says which hosts receive it ("Searching this desktop + review-bot").
  - An embedding approximately reveals the query, so the user decides by scope. No local transcript text or hit is ever sent.
- **D68: Indexing on the host covers turns only, serially, fenced.**
  - The host has no summarizer (§7 *Ingest*), so only turns are indexed.
  - At holder start: `deleteEmbeddingsForOtherModels` (chunked, yielding, as merged in #531) → `listSessionIds` → `indexSessionTurns` per session. After that, one queued `indexSessionTurns(sessionId)` per `onIngested` (D69), coalesced per session, one at a time.
  - The indexer runs only while the embedder is `ready`. After a crash loop it stops taking work until the next holder.
  - Writes go through the fenced state store, so a superseded holder's insert fails and ends the process like any other write.
  - Stop order: MCP → automations → **indexer (waits ≤ 2 s for the in-flight batch)** → embedder (stdin closed) → ingest → stores.
  - HNSW stays deferred (D44/D70). The corpus is one workspace until (e). Task 12 restates the trigger.
- **D75: The host uses `EmbedderClient` directly, with no fallback.**
  - `src/host/embedder.ts` wraps `EmbedderClient` (pure Node: `child_process` and `vectors.ts`).
  - It does not use `embeddings.ts`'s selector. The selector imports Electron's `app`, `errorLog` and `perf`, downloads missing files from the Hub, and falls back to transformers.js. None of that belongs on the host.
  - **No in-process fallback on the host.** The desktop keeps transformers.js for one more release; the host never had it, and an image without the sidecar is a broken build that D78 already fails. A missing binary or weight file at start is state `missing`. A crash loop (3 failures in 5 min) is state `failed`. Either way:
    - `search_transcripts` answers `embedder sidecar unavailable: <reason>`;
    - the indexer doesn't run;
    - `history:search` keeps serving the vectors already stored, because they are still valid for the pinned model;
    - the next holder (lease takeover or pod restart) tries again.
  - Spawned lazily on the first `embed()`, like the desktop. The backfill makes that happen at holder start.
- **D76: The host image builds the binary in a multi-stage step, for amd64 and arm64.**
  - Why build instead of copying a CI artifact: `publish-runner.yml` builds each arch natively on its own runner, and `build-app.yml` doesn't run on pushes to `main`. No per-commit artifact exists to copy, and a build stage keeps the image reproducible from the repo alone and BuildKit-cached.
  - Stage `embedder-build` is `FROM` the same digest-pinned `rust:1.91-bookworm` as `ci-build-linux.sh` (a multi-arch index; amd64 and arm64 both resolve). It runs the same two scripts the Linux CI build runs:
    - `embedder/scripts/install-zigbuild.sh` (new, split out of `ci-build-linux.sh`; zig 0.14.1 and cargo-zigbuild 0.24.1 per arch with pinned sha256s);
    - `embedder/scripts/ci-build.sh` (glibc 2.28 floor via zig, static libstdc++, `check-glibc.sh`, the fatal-frame smoke).
  - `ci-build.sh` takes the target triple from `uname -m` instead of hard-coding x86_64. ort-sys rc.10's `dist.txt` lists a prebuilt static onnxruntime for `aarch64-unknown-linux-gnu`.
  - **arm64 has never been built or parity-checked.** It is built and gated by D78 on the native arm64 runner. If either fails there, the arm64 host image doesn't publish (Questions for Troy, 1).
  - The glibc floor isn't needed inside the image (the runner base is Debian 12, glibc 2.36). It is kept so the host and desktop Linux binaries come from one build recipe.
- **D77: Weights pinned to a revision and a committed sha256 manifest (D72 safeguard 1).**
  - Stage `embed-weights` fetches only the two files the sidecar reads, `tokenizer.json` and `onnx/model_quantized.onnx`, from `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/<rev>/…`. `<rev>` is the Dockerfile `ARG EMBED_HF_REVISION=ea104dacec62c0de699686887e3f920caeb4f3e3` (HF `main` on 2026-11-09; a commit SHA, not a branch).
  - It runs `sha256sum -c` against the committed `docker/host/embed-weights.sha256`. A mismatch fails the build. Those bytes equal what the desktop caches today from `resolve/main` (checked 2026-11-09).
  - The files land read-only and root-owned at `/usr/local/lib/fleet-host/embed/model/`, which is exactly where `--model-dir` points. The manifest is copied beside them as `SHA256SUMS`, so `sha256sum -c` can be re-run in a pod.
  - The host has no runtime egress for the model, which matters on EKS.
  - Bumping the model or revision means changing `EMBED_HF_REVISION`, the manifest, `EMBED_HF_REVISION` in `embedCheck.ts` and the reference vectors (D78) together. `embedCheck.test.ts` fails if they diverge.
- **D78: A real embed at image build, checked against committed reference vectors.** This replaces `embed-selftest` printing 384.
  - `embedder/reference/bge-small-q8.json` holds the 40 parity-corpus texts and their vectors from the parity oracle (transformers.js, one text at a time). It is written by the opt-in parity suite on a machine with the model cache, after checking that the cached files match the manifest.
  - `fleet-host embed-check` starts the host embedder exactly as the holder does, embeds those texts in batches of 8, and requires per-text cosine ≥ 0.995, a mean cosine ≥ 0.9995 against the reference and every norm within 1e-4 of 1. It prints `{ ok, n, minCosine, minIndex, meanCosine, peakRssKiB }`. The bound sits above the int8-kernel spread across runner CPUs (up to about 2e-3; CI measured a minimum of 0.99932) and far below real failures (≤ 0.967).
  - The final image stage runs it as `fleet` (uid 1000), so the build fails on a broken binary, wrong weights, an unreadable file, or arm64 kernel drift that `modelId` can't detect.
  - The image keeps the reference (82 KB) as `embed/reference.json`, so the check can be re-run in a pod.
- **D79: The `search.embedder` off-switch (D72 safeguard 2).**
  - The ConfigMap gains `search: { embedder: true|false }`, with strict keys and a default of `true`.
  - It is fixed for the process lifetime: a reload that changes it is refused with "search cannot change on reload; restart to apply", the same as `db`. The holder's embedder, indexer and MCP tool set are built once at holder start.
  - With `false`:
    - the holder creates no `HostEmbedder`, so no sidecar process exists, and no indexer or backfill runs;
    - the host MCP omits `search_transcripts` from `tools/list`, and `tools/call` answers `Unknown tool`;
    - `history:search` answers 503 `search unavailable` before parsing its arguments;
    - the desktop maps that reply to `RemoteErrorKind` and `UnavailableReason` `'disabled'` and lists the host as unavailable (shown as "search off").
  - An older host has no `history:search` and answers 404 `no such channel`. That stays `protocol`.
- **D80: The sidecar's process hygiene on the host.**
  - It is spawned with an empty environment. `fleet-host`'s environment carries store settings (`db.password` kind `env`) and AWS Pod Identity variables, and the sidecar needs none of them (it ran clean with `env: {}` in the 2026-11-09 measurement). `EmbedderClient` gains an `env` option (undefined keeps inheriting, as on the desktop) and a `pid` getter for `embed-check`'s RSS figure.
  - The files are root-owned, `0644` with the binary `0755`, so any uid can read and run them: uid 1000 today, uid 1001 in the split's host pod. The sidecar writes nothing, so it works under the host pod's `readOnlyRootFilesystem: true`.
  - The sidecar parses session-written transcript text as the holder's uid. Its input is token ids into a fixed ONNX graph, and the residual risk is the same class as the ingest parser's. Task 12 notes it in SPEC §9.
- **D81: Placement under the two-pod split (D73).**
  - The embedder runs only where the holder runs: a child of `fleet-host`, in the host pod. The workspace pod runs the same image but never starts `fleet-host`, so its copy of the binary is inert.
  - In the split, `search_transcripts` reaches the host pod over the MCP's TCP :8082 (mTLS, only `fleet-agent-workspace`). The handler, scope (`host_meta` workspace id, never from the wire) and embedder are the same as over today's Unix socket, so (d2) adds nothing to the split. The query text crosses the mesh, inside the boundary D73 already accepts for MCP calls.
  - The 256 Mi memory request goes on the host pod.
  - Single-container mode (`fleet-host-entry single`, today's image) runs the sidecar in the shared container. It shares that mode's §9 risks; a session could kill it, which makes search unavailable until the next holder.

## File structure

| File | Responsibility |
|---|---|
| `src/main/transcriptIndexCore.ts` (new) | `indexSessionTurnsWith(span, sessionId, embed, batch)`, the indexing loop with injected spans. Pure apart from db.ts. |
| `src/main/transcriptIndex.ts` | Wraps the core with `perfSpanAsync`; behaviour unchanged. |
| `src/main/embedderClient.ts` | `env?` option passed to `spawn`; `pid` getter. Desktop behaviour unchanged. |
| `embedder/scripts/install-zigbuild.sh` (new) | Arch-aware, sha256-pinned zig + cargo-zigbuild install. |
| `embedder/scripts/ci-build.sh`, `embedder/scripts/ci-build-linux.sh` | Triple from `uname -m`; the container script calls `install-zigbuild.sh`. |
| `embedder/scripts/install-zigbuild.test.sh` (new) | Per-arch URL and hash selection (`--print`). |
| `embedder/reference/bge-small-q8.json` (new) | Reference texts + vectors for D78. |
| `docker/host/embed-weights.sha256` (new) | The weight manifest (D77). |
| `src/main/embedderParity.test.ts` | Opt-in writer for the reference file. |
| `src/host/embedder.ts` (new) | `startHostEmbedder`: the sidecar for the holder, states `ready`/`missing`/`failed`. |
| `src/host/embedCheck.ts` (new) | `parseReference`, `runEmbedCheck`, `embedCheckCli` (D78), `EMBED_HF_REVISION`. |
| `src/host/cli.ts` | `embed-check` subcommand. |
| `src/host/config.ts` | `search: { embedder }`, `HostEnv.embedDir`, `DEFAULT_EMBED_DIR`. |
| `src/host/configReload.ts` | Refuses a `search` change on reload. |
| `src/host/hostIndexer.ts` (new) | Backfill plus per-ingest indexing on the holder. |
| `src/host/holder.ts`, `src/host/main.ts` | Wire the embedder, indexer, MCP embedder and the off-switch; stop order. |
| `src/host/hostMcp.ts` | `hostMcpTools(search)`; `embed?` option. |
| `src/main/mcpCore.ts` | `setQueryEmbedder(fn \| null)`. |
| `src/host/historyRead.ts`, `src/host/historyRpc.ts` | `parseSearchReq`, `HistoryReader.search`, `history:search`, the 503. |
| `docker/host/Dockerfile`, `docker/host/smoke.test.sh` | `embedder-build` and `embed-weights` stages, the embed dir, the build-time check, smoke assertions. |
| `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`, `src/host/importGraph.test.ts` | Build context, path filters and their test. |
| `src/preload/federation.ts` | `SearchHitItem`, `FederatedSearchResult`, `SEARCH_UNAVAILABLE`, reason `'disabled'`. |
| `src/main/remoteClient.ts` | 503 `search unavailable` → `RemoteError('disabled')`. |
| `src/main/federation/remoteRows.ts` | `parseSearchReply`. |
| `src/main/federation/federatedReader.ts` | `search(...)`, `sources()`. |
| `src/main/federation/searchMerge.ts` (new) | `mergeHits` (pure). |
| `src/main/federation/federationIpc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts` | `history:search` IPC. |
| `src/renderer/src/components/TranscriptSearch.tsx` (new), `SessionsPane.tsx`, `sessionsView.ts` | The search UI. |
| `docs/SPEC.md` | Task 12. |

`vite.host.config.ts` doesn't change: there is no worker entry and no external package.

All commands run from the worktree root `$W`.

---

### Task 1: Perf-free indexing core

**Files:**
- Create: `src/main/transcriptIndexCore.ts`
- Modify: `src/main/transcriptIndex.ts`
- Test: `src/main/transcriptIndex.test.ts` (unchanged, must pass), `src/main/transcriptIndexCore.test.ts`

**Interfaces:**
- Produces:
  - `type SpanAsync = <T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string | number>) => Promise<T>`.
  - `indexSessionTurnsWith(span: SpanAsync, sessionId: string, embed: EmbedFn, batch?: number): Promise<number>`.
  - `extractText`, `MAX_CHARS` and `EMBED_BATCH` move here; `transcriptIndex.ts` re-exports `extractText`.

- [ ] **Step 1: Write the failing test** — `src/main/transcriptIndexCore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractText, indexSessionTurnsWith } from './transcriptIndexCore';

describe('transcriptIndexCore', () => {
  it('exports the loop without perf and keeps extractText', () => {
    expect(typeof indexSessionTurnsWith).toBe('function');
    expect(extractText({ content: [{ type: 'text', text: ' a ' }] })).toBe('a');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/transcriptIndexCore.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**
  - Move `MAX_CHARS`, `EMBED_BATCH` (with their memory comment), `extractText` and the body of `indexSessionTurns` from `transcriptIndex.ts` into `transcriptIndexCore.ts`. Export `MAX_CHARS` and `EMBED_BATCH`; `indexSessionSummaries` keeps using them through an import.
  - Rename the function `indexSessionTurnsWith(span, sessionId, embed, batch = EMBED_BATCH)`. Its one `perfSpanAsync(...)` call becomes `span(...)` with the same name and attributes.
  - The core imports only `./db.js` (`insertEmbeddings`, `unembeddedTurnEvents`) and `./vectors.js` (`encodeVector`, `EMBED_MODEL_ID`, `EMBED_DIM`, `EMPTY_VECTOR`, `type EmbedFn`).
  - `transcriptIndex.ts` keeps its exports:

```ts
import { EMBED_BATCH, MAX_CHARS, extractText, indexSessionTurnsWith } from './transcriptIndexCore.js';
export { extractText };
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch?: number): Promise<number> {
  return indexSessionTurnsWith(perfSpanAsync, sessionId, embed, batch);
}
```

  `perfSpanAsync` must be assignable to `SpanAsync`. If its attrs type is wider, widen `SpanAsync`'s `attrs` to `Record<string, unknown>`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/transcriptIndexCore.test.ts src/main/transcriptIndex.test.ts src/main/transcriptSearch.test.ts src/main/embedBackfill.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass, with existing tests unchanged; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/transcriptIndexCore.ts src/main/transcriptIndexCore.test.ts src/main/transcriptIndex.ts
git -C "$W" commit -m "refactor(index): perf-free indexing core for the host (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Arch-aware Linux embedder build

**Files:**
- Create: `embedder/scripts/install-zigbuild.sh`, `embedder/scripts/install-zigbuild.test.sh`
- Modify: `embedder/scripts/ci-build.sh`, `embedder/scripts/ci-build-linux.sh`, `embedder/README.md` (*glibc floor*), `.github/workflows/build-app.yml` (run the new test in `unit-run`)

**Interfaces:**
- Produces:
  - `install-zigbuild.sh <dest>` installs `<dest>/bin/{zig,cargo-zigbuild}` for `uname -m` (`x86_64` or `aarch64`).
  - `install-zigbuild.sh --print` prints `<zig-url> <sha256>` and `<czb-url> <sha256>`.
  - `FLEET_ZB_ARCH` overrides the arch (tests).
  - `ci-build.sh` on Linux builds `$(uname -m)-unknown-linux-gnu.2.28`.

- [ ] **Step 1: Write the failing test** — `embedder/scripts/install-zigbuild.test.sh`:

```bash
#!/usr/bin/env bash
# Per-arch selection in install-zigbuild.sh (no downloads).
set -euo pipefail
s="$(dirname "$0")/install-zigbuild.sh"
x=$(FLEET_ZB_ARCH=x86_64 "$s" --print)
a=$(FLEET_ZB_ARCH=aarch64 "$s" --print)
grep -q 'zig-x86_64-linux-0.14.1.tar.xz 24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c' <<<"$x"
grep -q 'cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2' <<<"$x"
grep -q 'zig-aarch64-linux-0.14.1.tar.xz f7a654acc967864f7a050ddacfaa778c7504a0eca8d2b678839c21eea47c992b' <<<"$a"
grep -q 'cargo-zigbuild-aarch64-unknown-linux-gnu.tar.xz 70bb4c9cc71a6d16211b9079996e3cd588671053312adeff4d043499ed887601' <<<"$a"
if FLEET_ZB_ARCH=riscv64 "$s" --print 2>/dev/null; then echo "riscv64 accepted"; exit 1; fi
echo "install-zigbuild: OK"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash embedder/scripts/install-zigbuild.test.sh`
Expected: FAIL — `install-zigbuild.sh: No such file or directory`.

- [ ] **Step 3: Implement.**

`embedder/scripts/install-zigbuild.sh` (mode 0755). The hashes are ziglang.org's `index.json` shasums and the GitHub release asset digests (v0.24.1 publishes no aarch64 musl build, so arm64 uses the gnu one):

```bash
#!/usr/bin/env bash
# zig and cargo-zigbuild for the release Linux build (ci-build.sh), sha256-pinned per arch.
# Usage: install-zigbuild.sh <dest> | --print
set -euo pipefail
arch=${FLEET_ZB_ARCH:-$(uname -m)}
case "$arch" in
  x86_64)
    zig_sha=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
    czb=cargo-zigbuild-x86_64-unknown-linux-musl
    czb_sha=f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2 ;;
  aarch64)
    zig_sha=f7a654acc967864f7a050ddacfaa778c7504a0eca8d2b678839c21eea47c992b
    czb=cargo-zigbuild-aarch64-unknown-linux-gnu
    czb_sha=70bb4c9cc71a6d16211b9079996e3cd588671053312adeff4d043499ed887601 ;;
  *) echo "install-zigbuild: unsupported arch $arch" >&2; exit 1 ;;
esac
zig=zig-$arch-linux-0.14.1
zig_url=https://ziglang.org/download/0.14.1/$zig.tar.xz
czb_url=https://github.com/rust-cross/cargo-zigbuild/releases/download/v0.24.1/$czb.tar.xz
if [ "${1:-}" = --print ]; then
  printf '%s %s\n%s %s\n' "$zig_url" "$zig_sha" "$czb_url" "$czb_sha"
  exit 0
fi
dest=${1:?usage: install-zigbuild.sh <dest> | --print}
mkdir -p "$dest/bin"
cd "$dest"
curl -fsSL --retry 3 -o zig.tar.xz "$zig_url"
echo "$zig_sha  zig.tar.xz" | sha256sum -c -
curl -fsSL --retry 3 -o czb.tar.xz "$czb_url"
echo "$czb_sha  czb.tar.xz" | sha256sum -c -
tar -xJf zig.tar.xz && tar -xJf czb.tar.xz && rm zig.tar.xz czb.tar.xz
ln -sf "$dest/$zig/zig" bin/zig
ln -sf "$dest/$czb/cargo-zigbuild" bin/cargo-zigbuild
```

`embedder/scripts/ci-build-linux.sh`: replace the inline zig/cargo-zigbuild download (the `cd /tmp` … `export PATH=…` lines) so the container command is:

```bash
docker run --rm -v "$root":/w -w /w \
  -e UID_GID="$(id -u):$(id -g)" -e GITHUB_ACTIONS \
  rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 bash -euo pipefail -c '
    trap "chown -R \$UID_GID embedder/target embedder/bin 2>/dev/null || true" EXIT
    embedder/scripts/install-zigbuild.sh /tmp/zb
    PATH=/tmp/zb/bin:$PATH embedder/scripts/ci-build.sh'
```

Add one comment line above the `docker run`: `# The same image digest is the host image's embedder-build stage (docker/host/Dockerfile); bump both together.`

`embedder/scripts/ci-build.sh`, Linux branch:
- Add `triple=$(uname -m)-unknown-linux-gnu` as the branch's first line.
- Change the `dist.txt` lookup to `awk -F'\t' -v t="$triple" '$1 == "none" && $2 == t {print $3, $4}' "$dist"`, and add `[ -n "$url" ] || { echo "::error::no prebuilt onnxruntime for $triple"; exit 1; }` after the `read`.
- Change the build to `cargo zigbuild --release --locked --no-default-features --target "$triple.2.28"`.
- Change the copy to `cp "target/$triple/release/fleet-embedder" bin/`.

`embedder/README.md` *glibc floor*: replace `--target x86_64-unknown-linux-gnu.2.28` with `--target <arch>-unknown-linux-gnu.2.28` (x86_64 or aarch64, from `uname -m`). Add that `scripts/install-zigbuild.sh` installs the pinned zig and cargo-zigbuild, and that the host image's `embedder-build` stage runs the same two scripts (D76).

`.github/workflows/build-app.yml`, `unit-run` job: add a step `run: bash embedder/scripts/install-zigbuild.test.sh` beside the existing `cargo test` step.

- [ ] **Step 4: Run the test and a local Linux build**

Run:
```bash
bash embedder/scripts/install-zigbuild.test.sh
bash embedder/scripts/ci-build-linux.sh 2>&1 | tail -5   # needs Docker; skip and note in the PR when absent
```
Expected: `install-zigbuild: OK`. With Docker: `max GLIBC symbol version: 2.28 (floor 2.28)`, `NEEDED:` without libstdc++, and `smoke: exit=1 …"type":"fatal"…`.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add embedder/scripts/install-zigbuild.sh embedder/scripts/install-zigbuild.test.sh embedder/scripts/ci-build.sh embedder/scripts/ci-build-linux.sh embedder/README.md .github/workflows/build-app.yml
git -C "$W" commit -m "build(embedder): arch-aware Linux build, shared zigbuild install (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Weight manifest and reference vectors

**Files:**
- Create: `docker/host/embed-weights.sha256`, `embedder/reference/bge-small-q8.json` (generated), `src/host/embedCheck.ts` (the parser and constants only; Task 4 adds the check), `src/host/embedCheck.test.ts`
- Modify: `src/main/embedderParity.test.ts` (the opt-in writer)

**Interfaces:**
- Produces:
  - `EMBED_HF_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'`.
  - `interface EmbedReference { model: string; dtype: string; revision: string; dim: number; texts: string[]; vectors: string }`, where `vectors` is base64 of n×384 float32 LE, the sidecar's wire format.
  - `parseReference(v: unknown): { revision: string; texts: string[]; vectors: Float32Array[] }`, which throws on any mismatch.

- [ ] **Step 1: Write the manifest** — `docker/host/embed-weights.sha256` (paths relative to the model dir):

```
d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66  tokenizer.json
6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4  onnx/model_quantized.onnx
```

- [ ] **Step 2: Write the failing test** — `src/host/embedCheck.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dot } from '../main/vectors.js';
import { EMBED_HF_REVISION, parseReference } from './embedCheck.js';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('embed reference (D78)', () => {
  const ref = parseReference(JSON.parse(read('embedder/reference/bge-small-q8.json')));

  it('covers the parity corpus with unit vectors', () => {
    expect(ref.texts).toEqual(JSON.parse(read('src/main/__fixtures__/embed-parity-corpus.json')));
    for (const v of ref.vectors) expect(Math.abs(Math.sqrt(dot(v, v)) - 1)).toBeLessThan(1e-4);
  });

  it('pins the same revision as the Dockerfile and the manifest names both sidecar files', () => {
    expect(ref.revision).toBe(EMBED_HF_REVISION);
    expect(read('docker/host/Dockerfile')).toContain(`ARG EMBED_HF_REVISION=${EMBED_HF_REVISION}`);
    expect(read('docker/host/embed-weights.sha256').trim().split('\n').map((l) => l.split(/\s+/)[1])).toEqual(['tokenizer.json', 'onnx/model_quantized.onnx']);
  });

  it('refuses a reference for another model or with a short vector blob', () => {
    const raw = JSON.parse(read('embedder/reference/bge-small-q8.json'));
    expect(() => parseReference({ ...raw, model: 'other' })).toThrow(/model/);
    expect(() => parseReference({ ...raw, vectors: raw.vectors.slice(0, 100) })).toThrow();
  });
});
```

The Dockerfile assertion passes once Task 5 adds the ARG. Until then, mark that one `it` with `.todo` and turn it back on in Task 5 Step 3.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/host/embedCheck.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement** `src/host/embedCheck.ts` (first part):

```ts
// fleet-host embed-check (D78): the image's sidecar must reproduce the
// committed reference vectors before the image ships.
import { decodeVectors } from '../main/embedderClient.js';
import { EMBED_DIM, EMBED_HF_ID } from '../main/vectors.js';

/** HF commit of the baked weights; docker/host/Dockerfile's EMBED_HF_REVISION. */
export const EMBED_HF_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';

export interface EmbedReference { model: string; dtype: string; revision: string; dim: number; texts: string[]; vectors: string }

export function parseReference(v: unknown): { revision: string; texts: string[]; vectors: Float32Array[] } {
  const r = v as Partial<EmbedReference> | null;
  if (!r || typeof r !== 'object') throw new Error('reference: not an object');
  if (r.model !== EMBED_HF_ID || r.dtype !== 'q8') throw new Error(`reference: model ${String(r.model)}/${String(r.dtype)} is not ${EMBED_HF_ID}/q8`);
  if (r.dim !== EMBED_DIM) throw new Error(`reference: dim ${String(r.dim)}`);
  if (typeof r.revision !== 'string' || !Array.isArray(r.texts) || r.texts.length === 0 || r.texts.some((t) => typeof t !== 'string') || typeof r.vectors !== 'string') {
    throw new Error('reference: needs revision, texts and vectors');
  }
  return { revision: r.revision, texts: r.texts, vectors: decodeVectors(r.vectors, r.texts.length, EMBED_DIM) };
}
```

`src/main/embedderParity.test.ts`: add the writer. Add to the imports `createHash` (`node:crypto`), `writeFileSync` (`node:fs`), `fileURLToPath` (`node:url`), `EMBED_DIM`, `EMBED_DTYPE`, `EMBED_HF_ID` (`./vectors.js`) and `EMBED_HF_REVISION` (`../host/embedCheck.js`). Then add inside the `describe`:

```ts
  it.skipIf(process.env.CF_EMBED_REFERENCE_WRITE !== '1')('writes the host image reference vectors (D78)', async () => {
    const dir = await ensureModelFiles(HF_CACHE);
    const manifest = readFileSync(fileURLToPath(new URL('../../docker/host/embed-weights.sha256', import.meta.url)), 'utf8');
    for (const line of manifest.trim().split('\n')) {
      const [sha, file] = line.split(/\s+/);
      expect(createHash('sha256').update(readFileSync(join(dir, ...file.split('/')))).digest('hex'), file).toBe(sha);
    }
    const vecs = await embedAll(makeInProcessEmbedder(HF_CACHE), BATCH);
    const buf = Buffer.alloc(vecs.length * EMBED_DIM * 4);
    vecs.forEach((v, i) => v.forEach((x, k) => buf.writeFloatLE(x, (i * EMBED_DIM + k) * 4)));
    const out = { model: EMBED_HF_ID, dtype: EMBED_DTYPE, revision: EMBED_HF_REVISION, dim: EMBED_DIM, texts: corpus, vectors: buf.toString('base64') };
    writeFileSync(fileURLToPath(new URL('../../embedder/reference/bge-small-q8.json', import.meta.url)), JSON.stringify(out, null, 1) + '\n');
  }, 600_000);
```

The in-process fallback embeds one text at a time (#531 review revisions), so batching here doesn't change its vectors.

- [ ] **Step 5: Generate the reference, then run the tests**

Run:
```bash
mkdir -p embedder/reference
CF_EMBED_REFERENCE_WRITE=1 npx vitest run src/main/embedderParity.test.ts -t 'reference vectors'
npx vitest run src/host/embedCheck.test.ts
```
Expected: the writer passes (the cached files match the manifest) and writes about 82 KB; the shape tests pass (the Dockerfile case is `.todo`).

- [ ] **Step 6: Commit**

```bash
git -C "$W" add docker/host/embed-weights.sha256 embedder/reference/bge-small-q8.json src/host/embedCheck.ts src/host/embedCheck.test.ts src/main/embedderParity.test.ts
git -C "$W" commit -m "test(embedder): pinned weight manifest and reference vectors for the host image (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Host embedder and `fleet-host embed-check`

**Files:**
- Create: `src/host/embedder.ts`, `src/host/embedder.test.ts`
- Modify: `src/main/embedderClient.ts`, `src/main/embedderClient.test.ts`, `src/host/embedCheck.ts`, `src/host/embedCheck.test.ts`, `src/host/cli.ts`, `src/host/config.ts` (`DEFAULT_EMBED_DIR`), `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`

**Interfaces:**
- Produces:
  - `EmbedderClientOptions.env?: NodeJS.ProcessEnv` and `EmbedderClient#pid: number | undefined`.
  - `DEFAULT_EMBED_DIR = '/usr/local/lib/fleet-host/embed'` (in `config.ts`).
  - `type HostEmbedderState = 'ready' | 'missing' | 'failed'`.
  - `HostEmbedder { embed: EmbedFn; state(): HostEmbedderState; pid(): number | undefined; close(): void }`.
  - `startHostEmbedder(o: { dir: string; log: Logger; launch?: { bin: string; args: string[] }; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): HostEmbedder`.
  - `runEmbedCheck(embed: EmbedFn, ref): Promise<{ ok: boolean; n: number; minCosine: number; meanCosine: number }>`.
  - `embedCheckCli(args: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number>`.

- [ ] **Step 1: Write the failing tests.**

`src/main/embedderClient.test.ts`, inside `describe('EmbedderClient')`:

```ts
  it('spawns with the given env instead of inheriting, and exposes the pid', async () => {
    // process.env says ok; the child sees only FAKE_MODE=old-protocol and refuses at once.
    const { c, onFatal } = client('ok', { env: { FAKE_MODE: 'old-protocol' } });
    await expect(c.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(onFatal).toHaveBeenCalledOnce();
    const ok = client('ok').c;
    await ok.embed(['a']);
    expect(ok.pid).toBeGreaterThan(0);
  });
```

`src/host/embedder.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EmbedderUnavailable } from '../main/embedderClient.js';
import { startHostEmbedder } from './embedder.js';
import { createLogger } from './log.js';

const FAKE = fileURLToPath(new URL('../main/__fixtures__/fake-embedder.mjs', import.meta.url));

function embedDir(withModel = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'he-'));
  if (withModel) {
    mkdirSync(join(dir, 'model', 'onnx'), { recursive: true });
    writeFileSync(join(dir, 'model', 'tokenizer.json'), '{}');
    writeFileSync(join(dir, 'model', 'onnx', 'model_quantized.onnx'), '');
  }
  return dir;
}
const fakeEnv = (mode: string) => ({ FAKE_MODE: mode, FAKE_STATE: join(mkdtempSync(join(tmpdir(), 'he-s-')), 'crashed') });

describe('host embedder (D75)', () => {
  it('embeds through the sidecar with only the env it is given', async () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('ok') });
    const [v] = await e.embed(['abc']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
    expect(e.state()).toBe('ready');
    expect(e.pid()).toBeGreaterThan(0);
    e.close();
  });

  it('is missing, logs once and never spawns when a weight file is absent', async () => {
    const lines: string[] = [];
    const e = startHostEmbedder({ dir: embedDir(false), log: createLogger((l) => lines.push(l)), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('ok') });
    expect(e.state()).toBe('missing');
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(e.pid()).toBeUndefined();
    expect(lines.filter((l) => l.includes('transcript search is off'))).toHaveLength(1);
  });

  it('requires <dir>/fleet-embedder when no launch override is given', () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined) });
    expect(e.state()).toBe('missing');
  });

  it('turns failed after the crash loop, with no fallback', async () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('old-protocol') });
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(e.state()).toBe('failed');
  });
});
```

`src/host/embedCheck.test.ts`, add:

```ts
describe('runEmbedCheck', () => {
  const ref = parseReference(JSON.parse(read('embedder/reference/bge-small-q8.json')));
  it('passes the reference itself and fails a perturbed embedder', async () => {
    const same = async (t: string[]) => t.map((x) => ref.vectors[ref.texts.indexOf(x)]);
    expect(await runEmbedCheck(same, ref)).toMatchObject({ ok: true, n: 40, minCosine: expect.closeTo(1, 6) });
    const flipped = async (t: string[]) => (await same(t)).map((v, i) => (i === 0 ? v.map((x) => -x) : v));
    expect((await runEmbedCheck(flipped, ref)).ok).toBe(false);
  });
});
```

Add `runEmbedCheck` to the `./embedCheck.js` import.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/embedderClient.test.ts src/host/embedder.test.ts src/host/embedCheck.test.ts`
Expected: FAIL — the `env` option is ignored, and `embedder.js` and `runEmbedCheck` are missing.

- [ ] **Step 3: Implement.**

`src/main/embedderClient.ts`:
- Add to `EmbedderClientOptions`: `/** Replaces the inherited environment when set. */ env?: NodeJS.ProcessEnv;`.
- In `start()`, pass it to `spawn`: `spawn(this.opts.bin, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.opts.env })`. `undefined` inherits, as today.
- Add `get pid(): number | undefined { return this.child?.pid; }`.

`src/host/config.ts`: add `export const DEFAULT_EMBED_DIR = '/usr/local/lib/fleet-host/embed';`.

`src/host/embedder.ts`:

```ts
// The fleet-embedder sidecar for the holder (D75): no in-process fallback and
// no model download; missing files or a crash loop turn search off.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EmbedderClient, EmbedderUnavailable } from '../main/embedderClient.js';
import type { EmbedFn } from '../main/vectors.js';
import type { Logger } from './log.js';

export const EMBED_MODEL_FILES = ['tokenizer.json', 'onnx/model_quantized.onnx'] as const;

export type HostEmbedderState = 'ready' | 'missing' | 'failed';

export interface HostEmbedder {
  embed: EmbedFn;
  state(): HostEmbedderState;
  pid(): number | undefined;
  /** Closes the sidecar's stdin; it exits on EOF. */
  close(): void;
}

export interface HostEmbedderOptions {
  dir: string;
  log: Logger;
  /** Tests: run this instead of `<dir>/fleet-embedder`; `--model-dir` is appended. */
  launch?: { bin: string; args: string[] };
  /** The sidecar's whole environment (D80). */
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

export function startHostEmbedder(o: HostEmbedderOptions): HostEmbedder {
  const exists = o.exists ?? existsSync;
  const modelDir = join(o.dir, 'model');
  const bin = o.launch?.bin ?? join(o.dir, 'fleet-embedder');
  const need = [...(o.launch ? [] : [bin]), ...EMBED_MODEL_FILES.map((f) => join(modelDir, ...f.split('/')))];
  const missing = need.filter((p) => !exists(p));
  if (missing.length) {
    const why = `not installed: ${missing.join(', ')}`;
    o.log.log('error', 'embedder unavailable; transcript search is off', { error: why });
    return {
      embed: async () => { throw new EmbedderUnavailable(why); },
      state: () => 'missing',
      pid: () => undefined,
      close: () => undefined
    };
  }
  let state: HostEmbedderState = 'ready';
  const client = new EmbedderClient({
    bin,
    args: [...(o.launch?.args ?? []), '--model-dir', modelDir],
    env: o.env ?? {},
    onFatal: (why) => {
      state = 'failed';
      o.log.log('error', 'embedder crash loop; transcript search is off until the next holder', { error: why });
    },
    log: (message) => o.log.log('warn', 'embedder', { message })
  });
  return { embed: (texts) => client.embed(texts), state: () => state, pid: () => client.pid, close: () => client.dispose() };
}
```

`src/host/embedCheck.ts`, append. Add `readFile` (`node:fs/promises`) and `join` (`node:path`) to its imports, `dot` and `type EmbedFn` to the `vectors.js` import, and `DEFAULT_EMBED_DIR` (`./config.js`), `startHostEmbedder` (`./embedder.js`) and `createLogger` (`./log.js`):

```ts
export const EMBED_CHECK_MIN_COSINE = 0.999;
const CHECK_BATCH = 8;

export async function runEmbedCheck(embed: EmbedFn, ref: { texts: string[]; vectors: Float32Array[] }): Promise<{ ok: boolean; n: number; minCosine: number; meanCosine: number }> {
  const cos: number[] = [];
  let unit = true;
  for (let i = 0; i < ref.texts.length; i += CHECK_BATCH) {
    const got = await embed(ref.texts.slice(i, i + CHECK_BATCH));
    got.forEach((v, k) => {
      cos.push(dot(v, ref.vectors[i + k]));
      if (Math.abs(Math.sqrt(dot(v, v)) - 1) > 1e-4) unit = false;
    });
  }
  const minCosine = Math.min(...cos);
  return { ok: unit && cos.length === ref.texts.length && minCosine >= EMBED_CHECK_MIN_COSINE, n: cos.length, minCosine, meanCosine: cos.reduce((a, b) => a + b, 0) / cos.length };
}

async function peakRssKiB(pid: number | undefined): Promise<number | null> {
  if (!pid) return null;
  const m = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''));
  return m ? Number(m[1]) : null;
}

/** `fleet-host embed-check [reference.json]`: 0 when the sidecar reproduces the reference. */
export async function embedCheckCli(args: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const dir = env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR;
  const e = startHostEmbedder({ dir, log: createLogger((l) => process.stderr.write(l + '\n')) });
  try {
    const ref = parseReference(JSON.parse(await readFile(args[0] ?? join(dir, 'reference.json'), 'utf8')));
    const r = await runEmbedCheck(e.embed, ref);
    out(JSON.stringify({ ...r, revision: ref.revision, peakRssKiB: await peakRssKiB(e.pid()) }));
    return r.ok ? 0 : 1;
  } catch (err) {
    out(JSON.stringify({ ok: false, error: (err as Error).message }));
    return 1;
  } finally {
    e.close();
  }
}
```

`src/host/cli.ts`: before the `if (argv.length > 0)` fallthrough to `runDbCommand`, add the following, and extend the header comment's list with `embed-check [reference]` (image build):

```ts
  if (argv[0] === 'embed-check') {
    const { embedCheckCli } = await import('./embedCheck.js');
    const code = await embedCheckCli(argv.slice(1), process.env, (l) => process.stdout.write(l + '\n'));
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    process.exit(code);
  }
```

`src/host/importGraph.test.ts`: in `MAIN_ALLOWED`, extend the `main/(db|…)` alternation with `embedderClient`. `embedderModelFiles` and `embeddings` stay off the list, so the host can't download weights or reach Electron.

The graph now reaches `src/main/embedderClient.ts`, so the build-inputs cases need it too:
- `.dockerignore`: add `!src/main/embedderClient.ts` after `!src/preload/federation.ts`.
- `publish-runner.yml` (`on.push.paths`) and `test-runner-images.yml` (`on.pull_request.paths`): add `'src/main/embedderClient.ts'` before `'package-lock.json'`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/embedderClient.test.ts src/main/embeddings.test.ts src/host/embedder.test.ts src/host/embedCheck.test.ts src/host/importGraph.test.ts && npx tsc -p tsconfig.host.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass; clean.

Optional real-binary check, where a built binary and the model cache exist:
```bash
mkdir -p /tmp/emb/model/onnx && cp ~/.cache/claude-fleet-hf/Xenova/bge-small-en-v1.5/tokenizer.json /tmp/emb/model/ \
 && cp ~/.cache/claude-fleet-hf/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx /tmp/emb/model/onnx/ \
 && cp embedder/target/release/fleet-embedder /tmp/emb/ \
 && npx vite build --config vite.host.config.ts >/dev/null && FLEET_HOST_EMBED_DIR=/tmp/emb node out/host/fleet-host.mjs embed-check embedder/reference/bge-small-q8.json
```
Expected: `{"ok":true,"n":40,"minCosine":0.99…,…,"peakRssKiB":~105000}`.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/embedderClient.ts src/main/embedderClient.test.ts src/host/embedder.ts src/host/embedder.test.ts src/host/embedCheck.ts src/host/embedCheck.test.ts src/host/cli.ts src/host/config.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml
git -C "$W" commit -m "feat(host): fleet-embedder sidecar for the holder and fleet-host embed-check (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The host image: build stages, weights, build-time check, allowlists

**Files:**
- Modify: `docker/host/Dockerfile`, `docker/host/smoke.test.sh`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml`, `src/host/importGraph.test.ts`, `src/host/embedCheck.test.ts` (re-enable the Dockerfile case)

- [ ] **Step 1: Write the failing test.** In `src/host/importGraph.test.ts`, add a helper and a case to `describe('fleet-host build inputs')`:

```ts
  const pathGlobs = (file: string, pick: (y: any) => string[]): RegExp[] =>
    pick(parse(read(file))).map((g) => new RegExp('^' + g.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*') + '$'));

  it('the embedder crate, reference and weight manifest are in the build context and trigger the image workflows', () => {
    const rules = read('.dockerignore');
    const inputs = [
      'embedder/Cargo.toml', 'embedder/Cargo.lock', 'embedder/build.rs', 'embedder/glibc_compat.c', 'embedder/rust-toolchain.toml',
      'embedder/src/main.rs', 'embedder/scripts/ci-build.sh', 'embedder/scripts/install-zigbuild.sh', 'embedder/scripts/check-glibc.sh',
      'embedder/reference/bge-small-q8.json', 'docker/host/embed-weights.sha256'
    ];
    expect(inputs.filter((f) => !dockerIncluded(rules, f))).toEqual([]);
    expect(dockerIncluded(rules, 'embedder/target/release/fleet-embedder')).toBe(false);
    expect(dockerIncluded(rules, 'embedder/bin/fleet-embedder')).toBe(false);
    const push = pathGlobs('.github/workflows/publish-runner.yml', (y) => y.on.push.paths);
    const pr = pathGlobs('.github/workflows/test-runner-images.yml', (y) => y.on.pull_request.paths);
    expect(inputs.filter((f) => !push.some((re) => re.test(f)) || !pr.some((re) => re.test(f)))).toEqual([]);
  });
```

In `src/host/embedCheck.test.ts`, turn the `.todo` Dockerfile case from Task 3 back into `it`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/importGraph.test.ts src/host/embedCheck.test.ts`
Expected: FAIL. The embedder files aren't in the context or the path filters, and the Dockerfile has no `EMBED_HF_REVISION`.

- [ ] **Step 3: Implement.**

`.dockerignore`, after the `!src/preload/federation.ts` line:

```
!src/main/transcriptIndexCore.ts
# fleet-embedder for the host image (docker/host/Dockerfile embedder-build stage).
!embedder/**
```

and in the trailing exclusions block:

```
embedder/target/**
embedder/bin/**
```

`src/main/transcriptIndexCore.ts` joins now so Task 7 needs no context change.

`.github/workflows/publish-runner.yml` (`on.push.paths`) and `.github/workflows/test-runner-images.yml` (`on.pull_request.paths`): add `'embedder/**'` and `'src/main/transcriptIndexCore.ts'` before `'package-lock.json'`. `build-app.yml`'s filter already matches `src/` and `embedder/`.

`docker/host/Dockerfile`, between the `host-build` stage and `FROM ${BASE_IMAGE}`:

```dockerfile
# fleet-embedder (remote-workspaces d2, D76). Same digest as embedder/scripts/ci-build-linux.sh; bump both together.
FROM rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS embedder-build
WORKDIR /w
COPY embedder ./embedder
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    embedder/scripts/install-zigbuild.sh /opt/zb \
 && PATH=/opt/zb/bin:$PATH embedder/scripts/ci-build.sh

# The sidecar's two model files at a pinned HF commit, checked against the committed manifest (D77).
FROM rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS embed-weights
ARG EMBED_HF_REVISION=ea104dacec62c0de699686887e3f920caeb4f3e3
WORKDIR /model
COPY docker/host/embed-weights.sha256 ./SHA256SUMS
RUN for f in tokenizer.json onnx/model_quantized.onnx; do \
      mkdir -p "$(dirname "$f")" \
      && curl -fsSL --retry 3 -o "$f" "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${EMBED_HF_REVISION}/$f" || exit 1; \
    done \
 && sha256sum -c SHA256SUMS
```

In the runtime stage, after `COPY --from=host-build /src/out/host/ /usr/local/lib/fleet-host/`:

```dockerfile
COPY --from=embedder-build /w/embedder/bin/fleet-embedder /usr/local/lib/fleet-host/embed/fleet-embedder
COPY --from=embed-weights /model/ /usr/local/lib/fleet-host/embed/model/
COPY embedder/reference/bge-small-q8.json /usr/local/lib/fleet-host/embed/reference.json
```

In the `RUN find /usr/local/lib/fleet-host -type f -exec chmod 0644 {} +` chain, append right after the `find`: `&& chmod 0755 /usr/local/lib/fleet-host/embed/fleet-embedder \`. The `find` would otherwise strip its execute bit.

Add `FLEET_HOST_EMBED_DIR=/usr/local/lib/fleet-host/embed` to the `ENV` block. After the `ENV` block, as `fleet`:

```dockerfile
# A real embed against the committed reference, as the runtime uid (D78).
RUN fleet-host embed-check
```

`docker/host/smoke.test.sh`, before `docker stop`:

```bash
test "$(docker exec "$cid" stat -c '%a %U' /usr/local/lib/fleet-host/embed/fleet-embedder)" = '755 root'
docker exec "$cid" sh -c 'cd /usr/local/lib/fleet-host/embed/model && sha256sum -c --quiet SHA256SUMS'
docker exec "$cid" fleet-host embed-check | grep -q '"ok":true'
# No db: no holder, so no sidecar process.
test -z "$(docker exec "$cid" sh -c 'pgrep -x fleet-embedder || true')"
```

Extend the script's header comment list with `the embedder files and embed-check`.

- [ ] **Step 4: Run the tests and, where Docker is available, build the image**

Run:
```bash
npx vitest run src/host/importGraph.test.ts src/host/embedCheck.test.ts
docker build -f docker/host/Dockerfile -t fleet-host-d2 . 2>&1 | tail -8 && bash docker/host/smoke.test.sh fleet-host-d2
```
Expected: the tests pass. With Docker, the build log shows `tokenizer.json: OK`, `onnx/model_quantized.onnx: OK`, `max GLIBC symbol version: 2.28` and the `embed-check` line `"ok":true`, and the smoke ends `runner-host smoke: OK`. Without Docker in this container, say so in the PR. `test-runner-images.yml` builds and smokes amd64 pre-merge. arm64 first builds in `publish-runner.yml` after merge; watch that run (D76).

- [ ] **Step 5: Commit**

```bash
git -C "$W" add docker/host/Dockerfile docker/host/smoke.test.sh .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml src/host/importGraph.test.ts src/host/embedCheck.test.ts
git -C "$W" commit -m "build(host): fleet-embedder and pinned weights in the host image, checked at build (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `search.embedder` config and the reload rule

**Files:**
- Modify: `src/host/config.ts`, `src/host/configReload.ts`
- Test: `src/host/config.test.ts`, `src/host/configReload.test.ts`

**Interfaces:**
- Produces:
  - `HostConfig.search: { embedder: boolean }`.
  - `HostEnv.embedDir: string` (`FLEET_HOST_EMBED_DIR`, default `DEFAULT_EMBED_DIR`).

- [ ] **Step 1: Write the failing tests.**

`src/host/config.test.ts`. Use the file's existing minimal-config helper; it is called `base` here:

```ts
describe('search', () => {
  it('defaults to the embedder on and accepts false', () => {
    expect(parseHostConfig(base).search).toEqual({ embedder: true });
    expect(parseHostConfig({ ...base, search: {} }).search).toEqual({ embedder: true });
    expect(parseHostConfig({ ...base, search: { embedder: false } }).search).toEqual({ embedder: false });
  });
  it('refuses unknown keys and non-booleans', () => {
    expect(() => parseHostConfig({ ...base, search: { embeder: false } })).toThrow('search has unknown key embeder');
    expect(() => parseHostConfig({ ...base, search: { embedder: 'no' } })).toThrow('search.embedder must be true or false');
    expect(() => parseHostConfig({ ...base, search: true })).toThrow('search must be an object');
  });
});

it('readHostEnv: embedDir defaults and is overridable', () => {
  expect(readHostEnv({}).embedDir).toBe('/usr/local/lib/fleet-host/embed');
  expect(readHostEnv({ FLEET_HOST_EMBED_DIR: '/x' }).embedDir).toBe('/x');
});
```

`src/host/configReload.test.ts`. Follow the existing "db cannot change" case:

```ts
it('refuses a search change on reload', async () => {
  // Start with { search: { embedder: true } }, then load { search: { embedder: false } }.
  expect(await r.reload('file change')).toBe(false);
  expect(logs.some((l) => l.includes('search cannot change on reload; restart to apply'))).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/host/config.test.ts src/host/configReload.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`src/host/config.ts`:
- Add to `HostConfig`: `/** D79: fixed for the process lifetime (configReload.ts). */ search: { embedder: boolean };`.
- Add the parser:

```ts
function parseSearch(v: unknown): { embedder: boolean } {
  if (v === undefined) return { embedder: true };
  const s = record(v, 'search');
  onlyKeys(s, 'search', ['embedder']);
  if (s.embedder !== undefined && typeof s.embedder !== 'boolean') throw new HostConfigError('search.embedder must be true or false');
  return { embedder: s.embedder !== false };
}
```

- Add `'search'` to `parseHostConfig`'s `onlyKeys` list, and `search: parseSearch(o.search)` to its return.
- Add to `HostEnv`: `/** The sidecar and its weights (D65). */ embedDir: string;`.
- In `readHostEnv`, add `embedDir: env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR`.

`src/host/configReload.ts`, after the `db` check:

```ts
      if (!isDeepStrictEqual(cfg.search, current.search)) return reject('search cannot change on reload; restart to apply');
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ && npx tsc -p tsconfig.host.json`
Expected: all pass; clean. Fix any test fixture that builds a `HostConfig` literal by adding `search: { embedder: true }`.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/config.ts src/host/configReload.ts src/host/config.test.ts src/host/configReload.test.ts
git -C "$W" commit -m "feat(host): search.embedder config off-switch, fixed per process (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Stage any fixture files you touched too.

---

### Task 7: Host indexer on the holder

**Files:**
- Create: `src/host/hostIndexer.ts`
- Modify: `src/host/holder.ts`, `src/host/main.ts`, `src/host/importGraph.test.ts` (allow `main/transcriptIndexCore.ts`)
- Test: `src/host/hostIndexer.test.ts`, `src/host/hostIndexer.pg.test.ts` (add to `vitest.pg.config.ts`), `src/host/main.pg.test.ts`

**Interfaces:**
- Consumes:
  - `indexSessionTurnsWith` (Task 1);
  - `listSessionIds`, `deleteEmbeddingsForOtherModels` (db.ts);
  - `startHostEmbedder` (Task 4);
  - `HostIngestOptions.onIngested(sessionId)` ((d1)).
- Produces:
  - `startHostIndexer(o: { embed: EmbedFn; log: Logger; paused?: () => boolean; index?: (id: string) => Promise<number> }): HostIndexer`.
  - `HostIndexer { backfill(): Promise<void>; bump(sessionId: string): void; stop(graceMs?: number): Promise<void> }`.
  - `HolderOptions.search: { embedder: boolean }`, `HolderOptions.embedDir: string`, `HolderOptions.embedder?: { launch?; env? }` (tests).
  - `RunHostOptions.embedder?: { launch?: { bin: string; args: string[] }; env?: NodeJS.ProcessEnv }` (tests).

- [ ] **Step 1: Write the failing tests.**

`src/host/hostIndexer.test.ts`:

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

  it('takes no work while paused (embedder failed)', async () => {
    const calls: string[] = [];
    let paused = false;
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined), paused: () => paused,
      index: async (id) => { calls.push(id); paused = true; return 0; } });
    ix.bump('a'); ix.bump('b');
    await ix.stop(1000);
    ix.bump('c');
    expect(calls).toEqual(['a']);
  });
});
```

`src/host/hostIndexer.pg.test.ts`:
- On an `openTestState()` Postgres store, ingest two turns for one session with `db.ingestBatch`.
- Run `startHostIndexer({ embed: async (t) => t.map(() => unit()), log })`, where `unit()` returns a 384-dim unit vector.
- Call `backfill()`, then `stop(5000)`, and expect 2 rows in `embeddings` for `EMBED_MODEL_ID`.
- Call `backfill()` again and expect no new rows.

`src/host/main.pg.test.ts` (D79, both settings). Add `import { fileURLToPath } from 'node:url';` and `const FAKE = fileURLToPath(new URL('../main/__fixtures__/fake-embedder.mjs', import.meta.url));`. Then add two cases using the existing `start(opts, prepare, extraConfig)`:
- **embedder on:**
  - `prepare` writes `model/tokenizer.json` and `model/onnx/model_quantized.onnx` under `join(dir, 'embed')`;
  - `opts.env` adds `FLEET_HOST_EMBED_DIR: join(dir, 'embed')`;
  - `opts.embedder = { launch: { bin: process.execPath, args: [FAKE] }, env: { FAKE_MODE: 'ok' } }`.
  - After the leader is up and the stores open, write a transcript with one user turn under `projects/<p>/<session>.jsonl`, as the ingest case does.
  - `vi.waitFor` until `SELECT count(*) FROM <schema>.embeddings WHERE text <> ''` is 1.
  - The holder's log has no `embedder unavailable`.
- **embedder off:**
  - `extraConfig` is `search: { embedder: false }\n`, with the same files and `opts`;
  - after the same transcript, the embeddings count stays 0 (wait 2 s);
  - the logs never mention `embedder`.

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

export function startHostIndexer(o: { embed: EmbedFn; log: Logger; paused?: () => boolean; index?: (id: string) => Promise<number> }): HostIndexer {
  const index = o.index ?? ((id: string) => indexSessionTurnsWith(noSpan, id, o.embed));
  const paused = o.paused ?? (() => false);
  const queued = new Set<string>();
  let running: Promise<void> | null = null;
  let stopped = false;
  const drain = async (): Promise<void> => {
    while (!stopped && !paused() && queued.size) {
      const [id] = queued;
      queued.delete(id);
      try {
        await index(id);
      } catch (err) {
        o.log.log('warn', 'transcript index failed', { sessionId: id, error: (err as Error).message });
      }
    }
    if (paused()) queued.clear();
    running = null;
  };
  const bump = (id: string): void => {
    if (stopped || paused()) return;
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

`stop` drains before it sets `stopped`, so queued work finishes inside the grace window. That gives the first test's expected calls.

`src/host/holder.ts`:
- Import `startHostEmbedder, type HostEmbedder, type HostEmbedderOptions` from `./embedder.js` and `startHostIndexer` from `./hostIndexer.js`.
- Add to `HolderOptions`:

```ts
  /** D79: false = no sidecar, indexer or search_transcripts. */
  search: { embedder: boolean };
  embedDir: string;
  /** Tests: a stand-in sidecar. */
  embedder?: Pick<HostEmbedderOptions, 'launch' | 'env'>;
```

- After `offsetsRead`, add:

```ts
  const embedder: HostEmbedder | null = o.search.embedder ? startHostEmbedder({ dir: o.embedDir, log: o.log, ...o.embedder }) : null;
  const indexer = embedder?.state() === 'ready' ? startHostIndexer({ embed: embedder.embed, log: o.log, paused: () => embedder.state() !== 'ready' }) : null;
```

- `HostIngest`'s `onIngested` becomes `(id) => { hint.bump(); indexer?.bump(id); }`.
- After `await ingest.start();`, call `if (indexer) void indexer.backfill().catch((err: Error) => o.log.log('warn', 'index backfill failed', { error: err.message }));`.
- In `stopAll`, after `await automations?.stop();` and before `await ingest.stop();`, add `await indexer?.stop(); embedder?.close();`.
- Thread `embed: embedder?.embed` into `mcpServer` (used by Task 8).

`src/host/main.ts`:
- Add `embedder?: { launch?: { bin: string; args: string[] }; env?: NodeJS.ProcessEnv }` to `RunHostOptions`, with the comment `/** Tests: a stand-in fleet-embedder. */`.
- In `startHolder({...})`, pass `search: config.search, embedDir: env.embedDir, embedder: opts.embedder`.

`src/host/importGraph.test.ts`: extend the `main/(db|…|embedderClient)` alternation with `transcriptIndexCore`.

`vitest.pg.config.ts`: add `'src/host/hostIndexer.pg.test.ts'` to `include`, in sorted position.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/hostIndexer.pg.test.ts src/host/main.pg.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass. The other `main.pg.test.ts` holders run with no embed dir. Their embedder is `missing`, which logs once and starts no indexer; the holder is unaffected.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/hostIndexer.ts src/host/hostIndexer.test.ts src/host/hostIndexer.pg.test.ts src/host/holder.ts src/host/main.ts src/host/main.pg.test.ts src/host/importGraph.test.ts vitest.pg.config.ts
git -C "$W" commit -m "feat(host): index hosted turns on the holder through the sidecar (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `search_transcripts` on the host MCP

**Files:**
- Modify: `src/main/mcpCore.ts`, `src/host/hostMcp.ts`, `src/host/holder.ts`
- Test: `src/host/hostMcp.test.ts`, `src/host/main.pg.test.ts`

**Interfaces:**
- Produces:
  - `setQueryEmbedder(fn: EmbedFn | null)`.
  - `HOST_SEARCH_TOOL = 'search_transcripts'`.
  - `hostMcpTools(search: boolean): ReadonlySet<string>` (14 or 15). `HOST_MCP_TOOLS` stays the 14 base tools.
  - `startHostMcp({ …, embed?: EmbedFn })`.

- [ ] **Step 1: Write the failing tests.** In `src/host/hostMcp.test.ts`:
- Rename the `HOST_MCP_TOOLS` case to `'serves query; search_transcripts only with an embedder'`. Keep `HOST_MCP_TOOLS.has('search_transcripts') === false` and size 14, and add `hostMcpTools(true).size === 15` with `.has('search_transcripts')`, and `hostMcpTools(false) === HOST_MCP_TOOLS`.
- Add a case:
  - Start the host MCP with a read source whose `searchEmbeddings` returns one hit and records its scope, and `embed: async (t) => t.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)))`.
  - `tools/list` includes `search_transcripts`.
  - `search_transcripts` `{ query: 'x' }` returns one hit, with a scope of exactly `{hosted}`.
  - `search_transcripts` `{ query: 'x', workspace_id: 'other' }` returns `[]`.
- Add a case: an MCP started without `embed` lists 14 tools, and `tools/call search_transcripts` answers `Unknown tool`.
- Add a case: an MCP started with an `embed` that rejects `new EmbedderUnavailable('not installed: /x')` answers the tool call with an error whose text contains `embedder sidecar unavailable`.

In `src/host/main.pg.test.ts`, extend Task 7's two cases. Over the MCP socket (the existing `mcpSock(dir)` helper), `tools/list` contains `search_transcripts` with the embedder on and lacks it with the embedder off.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/hostMcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `mcpCore.ts`: `export function setQueryEmbedder(fn: EmbedFn | null): void { queryEmbedder = fn; }`. The desktop's `index.ts` call is unchanged.
  - `hostMcp.ts`:

```ts
export const HOST_SEARCH_TOOL = 'search_transcripts';
const HOST_TOOLS_WITH_SEARCH: ReadonlySet<string> = new Set([...HOST_MCP_TOOLS, HOST_SEARCH_TOOL]);
/** D79: search_transcripts exists only where the holder runs an embedder. */
export function hostMcpTools(search: boolean): ReadonlySet<string> {
  return search ? HOST_TOOLS_WITH_SEARCH : HOST_MCP_TOOLS;
}
```

  - Add `embed?: EmbedFn` to `startHostMcp`'s options (import `type EmbedFn` from `../main/vectors.js` and `setQueryEmbedder` from `../main/mcpCore.js`).
  - Replace `setExposedTools(HOST_MCP_TOOLS)` with `setExposedTools(hostMcpTools(!!o.embed))`, and after `initReadSource(o.readSource);` call `setQueryEmbedder(o.embed ?? null);`.
  - In `reset()`, call `setQueryEmbedder(null);`.
  - `holder.ts`: `mcpServer(o, readSource, embedder?.embed)` passes `embed` into `startHostMcp({ …, embed })`.
  - `noteSearchResults` records `search-impression` usage rows. On the host these are fenced writes under the hosted workspace, which is correct (spec §7 *Usefulness signals*: own sessions' marks don't count, which is (e)'s rule). `setSearchHitHook` is unset on the host, so no capture is triggered.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ src/main/mcpCore*.test.ts src/main/mcpServer*.test.ts && npx vitest run -c vitest.pg.config.ts src/host/main.pg.test.ts && npx tsc -p tsconfig.host.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: all pass; clean. The desktop's `tools/list` snapshot is unchanged. Update `tests/mcp-*.spec.ts` only if one pins the host tool count (memory: MCP contract tests).

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/mcpCore.ts src/host/hostMcp.ts src/host/hostMcp.test.ts src/host/holder.ts src/host/main.pg.test.ts
git -C "$W" commit -m "feat(host): search_transcripts on the host MCP when the embedder is on (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `history:search` RPC

**Files:**
- Modify: `src/host/historyRead.ts`, `src/host/historyRpc.ts`, `src/host/main.ts`, `src/preload/federation.ts` (`SEARCH_UNAVAILABLE` only)
- Test: `src/host/historyRpc.test.ts`, `src/host/historyRead.pg.test.ts`, `src/host/main.pg.test.ts`

**Interfaces:**
- Produces:
  - `SEARCH_LIMIT_MAX = 50`, `SEARCH_TEXT_MAX = 1000`.
  - `parseSearchReq(v): SearchReq` (`{ vector: Float32Array; limit: number; kind?: 'turn' | 'summary' }`), which throws `HistoryArgError`, including on `model mismatch: host uses <EMBED_MODEL_ID>`.
  - `HistoryReader.search(req): Promise<{ modelId: string; hits: EmbeddingHit[] }>`.
  - `historyRpcChannels(reader, o?: { search: () => boolean })`. The default is `search: () => true`.
  - `SEARCH_UNAVAILABLE = 'search unavailable'` in `src/preload/federation.ts`, shared by the host and the desktop.

- [ ] **Step 1: Write the failing tests.**

In `src/host/historyRpc.test.ts`:
- Add `search: vi.fn(async () => ({ modelId: EMBED_MODEL_ID, hits: [] }))` to the `reader()` fixture.
- Import `EMBED_MODEL_ID` from `../main/vectors.js`.
- Add the two cases below.
- Add `'history:search'` to the "every channel needs read" case's channel list.

```ts
it('history:search validates the vector and model', async () => {
  const r = reader();
  const reg = historyRpcChannels(() => r);
  const unit = Array(384).fill(1 / Math.sqrt(384));
  expect((await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: EMBED_MODEL_ID, limit: 10 }] }, caller)).status).toBe(200);
  expect(vi.mocked(r.search).mock.calls[0][0].vector).toBeInstanceOf(Float32Array);
  for (const bad of [
    { vector: unit, modelId: 'other@fp32', limit: 10 },
    { vector: unit.slice(1), modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: Array(384).fill(1), modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: [...unit.slice(1), NaN], modelId: EMBED_MODEL_ID, limit: 10 },
    { vector: unit, modelId: EMBED_MODEL_ID, limit: 51 },
  ]) expect((await dispatchRpc(reg, 'history:search', { args: [bad] }, caller)).status).toBe(400);
});

it('history:search answers 503 search unavailable when the embedder is off (D79)', async () => {
  const r = reader();
  const reg = historyRpcChannels(() => r, { search: () => false });
  expect(await dispatchRpc(reg, 'history:search', { args: [{ nonsense: true }] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'search unavailable' } });
  expect(r.search).not.toHaveBeenCalled();
  expect((await dispatchRpc(reg, 'history:sessions', { args: [] }, caller)).status).toBe(200);
});
```

In `src/host/historyRead.pg.test.ts`, add:
- Insert two embeddings for the hosted workspace and one for `OTHER` (unit vectors, `EMBED_MODEL_ID`).
- `historyReader(() => k, HOSTED).search({ vector, limit: 10 })` returns only hosted hits, `modelId === EMBED_MODEL_ID`, and every `text.length ≤ 1000`.

In `src/host/main.pg.test.ts`, extend the Task 7 off case: `POST /rpc/history:search` answers 503 `{ ok: false, error: 'search unavailable' }`.

- [ ] **Step 2: Run them to verify they fail.**

Run: `npx vitest run src/host/historyRpc.test.ts && npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`src/preload/federation.ts`, append:

```ts
/** history:search's 503 body when the host's embedder is off (D79). */
export const SEARCH_UNAVAILABLE = 'search unavailable';
```

`src/host/historyRead.ts`, add:

```ts
import { EMBED_DIM, EMBED_MODEL_ID } from '../main/vectors.js';
import { pgSearchEmbeddings } from '../main/store/pgVectorSearch.js';
import type { EmbeddingHit } from '../main/db.js';

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_TEXT_MAX = 1000;
export interface SearchReq { vector: Float32Array; limit: number; kind?: 'turn' | 'summary' }

export function parseSearchReq(v: unknown): SearchReq {
  if (!isObject(v)) throw new HistoryArgError('expected {vector, modelId, limit}');
  if (v.modelId !== EMBED_MODEL_ID) throw new HistoryArgError(`model mismatch: host uses ${EMBED_MODEL_ID}`);
  if (!Array.isArray(v.vector) || v.vector.length !== EMBED_DIM) throw new HistoryArgError(`vector must have ${EMBED_DIM} numbers`);
  const vec = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const x: unknown = v.vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new HistoryArgError('vector must be finite numbers');
    vec[i] = x;
    norm += x * x;
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) throw new HistoryArgError('vector must be unit length');
  const limit = v.limit === undefined ? 10 : v.limit;
  if (!int(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new HistoryArgError(`limit must be 1-${SEARCH_LIMIT_MAX}`);
  if (v.kind !== undefined && v.kind !== 'turn' && v.kind !== 'summary') throw new HistoryArgError('kind must be turn or summary');
  return { vector: vec, limit, kind: v.kind as SearchReq['kind'] };
}
```

- Add `search(req: SearchReq): Promise<{ modelId: string; hits: EmbeddingHit[] }>` to `HistoryReader`.
- In `historyReader`:

```ts
    async search(req) {
      const hits = await readTransaction(k(), (q) => pgSearchEmbeddings(q, req.vector, [workspaceId], { limit: req.limit, kind: req.kind }));
      return {
        modelId: EMBED_MODEL_ID,
        hits: hits.map((h) => ({ ...h, text: h.text.slice(0, SEARCH_TEXT_MAX), score: Number(h.score), ts: h.ts === null ? null : Number(h.ts) }))
      };
    },
```

`src/host/historyRpc.ts`:
- Import `parseSearchReq` from `./historyRead.js` and `SEARCH_UNAVAILABLE` from `../preload/federation.js`.
- Change the signature to `historyRpcChannels(reader: () => HistoryReader | null, o: { search: () => boolean } = { search: () => true })`.
- Add the channel:

```ts
    ['history:search', {
      tier: 'read',
      handle: ([req]) => guarded(async () => {
        if (!o.search()) throw new RpcUnavailableError(SEARCH_UNAVAILABLE);
        return need().search(parseSearchReq(req));
      })
    }]
```

`src/host/main.ts`: `historyRpcChannels(() => holderNow?.history ?? null, { search: () => config.search.embedder })`. A reload can't change `config.search` (Task 6).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/host/ && npx vitest run -c vitest.pg.config.ts src/host/historyRead.pg.test.ts src/host/main.pg.test.ts && npx tsc -p tsconfig.host.json`
Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/host/historyRead.ts src/host/historyRpc.ts src/host/historyRpc.test.ts src/host/historyRead.pg.test.ts src/host/main.ts src/host/main.pg.test.ts src/preload/federation.ts
git -C "$W" commit -m "feat(host): history:search over a caller-supplied query vector, 503 when search is off (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Desktop federated search

**Files:**
- Create: `src/main/federation/searchMerge.ts`
- Modify: `src/preload/federation.ts`, `src/main/remoteClient.ts`, `src/main/federation/remoteRows.ts`, `src/main/federation/federatedReader.ts`, `src/main/federation/federationIpc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`
- Test: `src/main/federation/searchMerge.test.ts`, `src/main/federation/remoteRows.test.ts`, `src/main/federation/federatedReader.test.ts`, `src/main/federation/federationIpc.test.ts`, `src/main/remoteClient.test.ts`, `src/main/store/pgVectorSearch.test.ts` (score parity; add to `vitest.pg.config.ts`)

**Interfaces:**
- Produces (in `preload/federation.ts`):
  - `SearchHitItem { origin; sessionId; workspaceId; workspaceName; kind; ts; text; score }`.
  - `FederatedSearchResult { hits: SearchHitItem[]; unavailable: UnavailableSource[] }`.
  - `UnavailableReason` gains `'disabled'`.
- Produces (elsewhere):
  - `RemoteErrorKind` gains `'disabled'`.
  - `mergeHits(sources: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[], limit: number): SearchHitItem[]`.
  - `parseSearchReply(v, workspaceId): { modelId: string; hits }`.
  - `FederatedReader.search(o: { vector: Float32Array; limit: number; origins: string[] }): Promise<{ remote: { origin; hits }[]; unavailable }>` and `FederatedReader.sources()`.
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

`remoteRows.test.ts`: `parseSearchReply({ modelId: 'm', hits: [{ sessionId: 's', workspaceId: W, kind: 'turn', ts: 1, text: 'x'.repeat(5000), score: 0.4 }, { sessionId: 't', workspaceId: W, kind: 'turn', ts: 1, text: 'y', score: NaN }] }, W)` keeps one hit with text length 1000. It throws `RemoteShapeError` on a missing `modelId` or more than 50 hits.

`remoteClient.test.ts`: an RPC answered `503 {"ok":false,"error":"search unavailable"}` rejects with `RemoteError` kind `'disabled'`; `503 {"error":"history unavailable"}` stays `'unreachable'`. Use the file's existing fake-server helper.

`federatedReader.test.ts`, add:
- `search` only calls the origins it is given;
- a host whose reply `modelId` differs is listed `unavailable` with reason `model`, and its hits are absent;
- a host whose `rpc` throws `new RemoteError('disabled', 'x', 503)` is listed with reason `disabled`;
- the RPC args are `[{ vector: number[], modelId: EMBED_MODEL_ID, limit }]`;
- a source in state `'unreachable'` is listed `unreachable` without an RPC (the (d1) liveness gate).

`federationIpc.test.ts`, add: `history:search` rejects an empty query and a bad scope, and with `embed` returning null it throws `transcript search index is unavailable`.

`src/main/store/pgVectorSearch.test.ts` (PG). Score parity, D64:
- Insert 20 random unit vectors.
- For a random unit query, `pgSearchEmbeddings` scores equal `dot(q, v)` from `vectors.ts` within 1e-5.
- The order matches `topK`, except within ties under 1e-6.

- [ ] **Step 2: Run them to verify they fail.**

Run: `npx vitest run src/main/federation/ src/main/remoteClient.test.ts && npx vitest run -c vitest.pg.config.ts src/main/store/pgVectorSearch.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement.**

`src/preload/federation.ts`:
- Add `| 'disabled'` to `UnavailableReason`.
- Append:

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

`src/main/remoteClient.ts`:
- Add `| 'disabled'` to `RemoteErrorKind`.
- Import `SEARCH_UNAVAILABLE` from `../preload/federation.js`.
- In `statusError`, after the `standby` line:

```ts
  if (status === 503 && text === SEARCH_UNAVAILABLE) return new RemoteError('disabled', `${url} has transcript search turned off`, 503);
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
export const MAX_SEARCH_HITS = 50;
const MAX_HIT_TEXT = 1000;

export type RemoteSearchHit = { sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; score: number };

export function parseSearchReply(v: unknown, workspaceId: string): { modelId: string; hits: RemoteSearchHit[] } {
  const o = v as { modelId?: unknown; hits?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.modelId !== 'string' || !Array.isArray(o.hits) || o.hits.length > MAX_SEARCH_HITS) return fail('search reply');
  const hits: RemoteSearchHit[] = [];
  for (const raw of o.hits) {
    const h = raw as Record<string, unknown> | null;
    if (!h || typeof h !== 'object' || typeof h.sessionId !== 'string' || !ID_RE.test(h.sessionId) || h.workspaceId !== workspaceId) continue;
    const ts = natOrNull(h.ts);
    if ((h.kind !== 'turn' && h.kind !== 'summary') || ts === undefined || typeof h.text !== 'string') continue;
    if (typeof h.score !== 'number' || !Number.isFinite(h.score) || h.score < -1.0001 || h.score > 1.0001) continue;
    hits.push({ sessionId: h.sessionId, workspaceId, kind: h.kind, ts, text: h.text.replace(/[\x00-\x08\x0b-\x1f\x7f\p{Cf}]/gu, ' ').slice(0, MAX_HIT_TEXT), score: h.score });
  }
  return { modelId: oneLine(o.modelId, 128), hits };
}
```

Search text keeps newlines; React renders it as text with `white-space: pre-wrap`.

`federatedReader.ts`:
- Import `EMBED_MODEL_ID` from `../vectors.js`, `parseSearchReply` from `./remoteRows.js`, and `type SearchHitItem` from `../../preload/federation.js`.
- Add `'disabled'` handling: none needed in `reasonOf`, because `RemoteError.kind` is already the reason.
- Add to the interface `sources(): RemoteSourceInfo[]` and `search(o: { vector: Float32Array; limit: number; origins: string[] }): Promise<{ remote: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[]; unavailable: UnavailableSource[] }>`.
- Add to the implementation:

```ts
    sources: () => d.sources(),
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
      return { remote: byOrigin(remote), unavailable: byOrigin(unavailable) };
    },
```

A host refusing the model with 400 surfaces as `protocol`. The `modelId` check covers a host that answers with its own id.

`federationIpc.ts`:
- Import `mergeHits` from `./searchMerge.js`.
- Import `LOCAL_ORIGIN`, `type FederatedSearchResult` and `type SearchHitItem` from `../../preload/federation.js`.
- Add the dependency and the handler:

```ts
export interface LocalSearch {
  /** null: the local embedder isn't ready. */
  embed(query: string): Promise<Float32Array | null>;
  hits(vector: Float32Array, scope: string, limit: number): Promise<Omit<SearchHitItem, 'origin'>[]>;
  localIds(): Promise<Set<string>>;
}

export function registerFederationIpc(ipc: Pick<IpcMain, 'handle'>, reader: FederatedReader, search: LocalSearch): void {
  ipc.handle('sessions:listRemote', async (_e, req: unknown) => reader.listSessions(parseReq(req)));
  ipc.handle('history:search', async (_e, query: unknown, opts: unknown): Promise<FederatedSearchResult> => {
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
}
```

`ipc.ts` (`registerFederationIpc(ipcMain, federated, localSearch)`):
- `localSearch.embed(q)`: `fedEmbed ? (await fedEmbed([q]))[0] : null`, where `let fedEmbed: EmbedFn | null = null` and `export function setFederatedEmbedder(fn: EmbedFn): void { fedEmbed = fn; }`. `index.ts` calls `setFederatedEmbedder(embedFn)` next to `setQueryEmbedder(embedFn)`. It is the same `makeEmbedder` selector (sidecar, then the in-process fallback), so the query vector comes from the same model as every stored row.
- `hits(vector, scope, limit)`: `db.searchEmbeddings(vector, scope === 'all' ? [...await localSearch.localIds()] : [scope], { limit })`, mapped to add `workspaceName` from the manifest list.
- `localIds()`: the ids of manifests whose `kind !== 'remote'` (`listWorkspaceManifests()`).

`preload/index.ts`: add `history: { search: (query: string, opts: { scope: 'all' | string; limit?: number }): Promise<FederatedSearchResult> => ipcRenderer.invoke('history:search', query, opts) }`.

`vitest.pg.config.ts`: add `'src/main/store/pgVectorSearch.test.ts'`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/ src/preload/ && npx vitest run -c vitest.pg.config.ts src/main/store/pgVectorSearch.test.ts && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all pass; clean. Run the two typechecks separately; `npm run typecheck` stops at the first failure.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/main/federation/ src/main/remoteClient.ts src/main/remoteClient.test.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts src/preload/federation.ts src/main/store/pgVectorSearch.test.ts vitest.pg.config.ts
git -C "$W" commit -m "feat(federation): federated transcript search merged by score with model and disabled checks (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Transcript search UI in the Sessions pane

**Files:**
- Create: `src/renderer/src/components/TranscriptSearch.tsx`
- Modify: `src/renderer/src/components/SessionsPane.tsx`, the Sessions stylesheet, `src/renderer/src/sessionsView.ts`, `src/renderer/src/App.tsx` (pass `remoteNames`)
- Test: `src/renderer/src/sessionsView.test.ts`

**Interfaces:**
- Consumes: `window.api.history.search`, `SearchHitItem`, `UnavailableSource`, `CloudGlyph` ((d1)).
- Produces:
  - `searchTargets(scope, selectedWorkspaceId, remoteNames: Record<string, string>, isLocal: (id) => boolean): { scope: 'all' | string; label: string } | null`.
  - `searchUnavailableText(u: UnavailableSource[]): string | null`.
  - `<TranscriptSearch target=… onPick={(hit) => …} />`.

- [ ] **Step 1: Write the failing tests.** In `sessionsView.test.ts`:

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

describe('searchUnavailableText', () => {
  it('says why a host left the search', () => {
    expect(searchUnavailableText([])).toBeNull();
    expect(searchUnavailableText([{ origin: 'R', name: 'review-bot', reason: 'disabled' }, { origin: 'S', name: 'triage', reason: 'model' }, { origin: 'T', name: 'x', reason: 'timeout' }]))
      .toBe('3 sources unavailable: review-bot (search off), triage (different model), x');
  });
});
```

If `filterSessions` doesn't already match a session id exactly, add a case: `filterSessions(items, items[0].id, [])` returns `[items[0]]`.

- [ ] **Step 2: Run them to verify they fail.**

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

const SEARCH_REASON: Partial<Record<UnavailableReason, string>> = { disabled: 'search off', model: 'different model' };

export function searchUnavailableText(u: UnavailableSource[]): string | null {
  if (u.length === 0) return null;
  const names = u.map((x) => (SEARCH_REASON[x.reason] ? `${x.name} (${SEARCH_REASON[x.reason]})` : x.name));
  return `${u.length} source${u.length === 1 ? '' : 's'} unavailable: ${names.join(', ')}`;
}
```

Import `type UnavailableReason` beside the existing `UnavailableSource` import. If `filterSessions` lacks the id match, add `s.id === query.trim() ||` as the first term of its match expression.

`TranscriptSearch.tsx` is a form with an input (`aria-label="Search transcripts"`, placeholder `Search transcript content…`) and a `Search` button. It submits on Enter, never per keystroke, because each search embeds and fans out.
- It shows the target label.
- While running, it shows `Searching…`.
- It lists hits as buttons. Each shows:
  - the cloud glyph for remote origins;
  - the workspace name and a relative time;
  - the score as `(0.83)`;
  - `text` in a `<span className="hit-text">` with `white-space: pre-wrap` and a 4-line clamp.
- Below the list it shows `searchUnavailableText(result.unavailable)`.
- A thrown error such as `transcript search index is unavailable` shows as the message text.
- `onPick(hit)` is called on click.

`SessionsPane.tsx`:
- Add a `Transcripts` toggle button next to the search box (`aria-pressed`). When on, it renders `<TranscriptSearch …/>` above the list.
- `onPick` sets the existing text query to `hit.sessionId` and scrolls the matching `li[data-sid]` into view.
- Remote names and the local check come from the existing `remoteTiers` prop ((d1)) plus a new `remoteNames?: Record<string, string>`. `App` passes it the same way it passes `remoteTiers`.

- [ ] **Step 4: Run the renderer tests, typecheck and build.**

Run: `npx vitest run src/renderer/ && npx tsc --noEmit -p tsconfig.web.json && npm run build`
Expected: all pass; clean; the build succeeds, or the environment block is recorded in the PR.

- [ ] **Step 5: Commit**

```bash
git -C "$W" add src/renderer/src/components/TranscriptSearch.tsx src/renderer/src/components/SessionsPane.tsx src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts src/renderer/src/App.tsx
git -C "$W" commit -m "feat(sessions): transcript search across local and remote with origin badges (remote d2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Also stage the stylesheet you edited.

---

### Task 12: SPEC.md and the full gate

- [ ] **Step 1: Update SPEC.md.**
1. **§4 *Host images*:**
   - Describe the `embedder-build` stage (the digest-pinned `rust:1.91-bookworm`, `install-zigbuild.sh` + `ci-build.sh`, amd64 and arm64 natively) and the `embed-weights` stage (`EMBED_HF_REVISION`, `docker/host/embed-weights.sha256`, `sha256sum -c`).
   - List the `/usr/local/lib/fleet-host/embed/` layout: `fleet-embedder` 0755 root, `model/` 0644 root with `SHA256SUMS`, `reference.json`.
   - Note that the build runs `fleet-host embed-check` as `fleet`.
   - Add the smoke assertions to the smoke list.
   - Note that `.dockerignore` opts in `embedder/**` without `target/` and `bin/`, and that both image workflows trigger on `embedder/**`.
2. **§4 *Embedder sidecar binary*:**
   - The Linux build is arch-aware (`uname -m` triple, `install-zigbuild.sh` with per-arch hashes).
   - The host image reuses it.
3. **§6:** add a `### History search` entry (or a bullet under *Sessions*) describing `history:search(query, { scope, limit })` → `{ hits, unavailable }`:
   - The desktop embeds once (`makeEmbedder`).
   - Local is `searchEmbeddings`.
   - A remote is `history:search` with the vector, only to the hosts in scope (D67).
   - Merge by score, then origin, session and ts (D64).
   - A source with another `modelId` is listed `unavailable` with reason `model`; a host with search off is listed with reason `disabled`.
4. **§7 *JSONL→SQLite cache* → *Search*:** add the parity note (D64): SQLite dot and pgvector `1 − <=>` both equal cosine on unit float32 vectors, pinned within 1e-5 by `pgVectorSearch.test.ts`.
5. **§7 *Local embeddings*:** one line saying that fleet-host uses the same sidecar without the fallback or the download (*Remote host*, *Embedder*).
6. **§7 *Remote host*:**
   - **Config:** `search: { embedder }` (strict, default true, fixed per process; reload refuses a change).
   - **RPC channels:** add `history:search` (`read`; `[{ vector[384], modelId, limit ≤ 50, kind? }]` → `{ modelId, hits }`; `model mismatch` 400; text ≤ 1000; 503 `search unavailable` when `search.embedder` is false).
   - ***Ingest*:** replace "no embeddings or summaries on the host" with "turns are embedded by the holder's indexer (`hostIndexer.ts`): backfill at start, then per ingested session, serially, fenced, only while the embedder is ready; no summaries".
   - ***Host MCP* *Tools*:** 14, plus `search_transcripts` (15) when `search.embedder` is true. It embeds in the sidecar; an unavailable sidecar answers `embedder sidecar unavailable: <reason>`.
   - **A new *Embedder* paragraph:**
     - the holder spawns `fleet-embedder` (`embedder.ts`, `EmbedderClient`) from `FLEET_HOST_EMBED_DIR` with an empty environment;
     - the states are `ready`/`missing`/`failed`, with no fallback and no download;
     - a crash loop turns search off until the next holder;
     - stored vectors keep serving `history:search`;
     - `fleet-host embed-check`;
     - memory: a 102 MiB measured peak, so the pod memory request goes up by 256 Mi;
     - under the split it is in the host pod, and `search_transcripts` over :8082 is unchanged (D81).
   - **Env contract table:** add `FLEET_HOST_EMBED_DIR`.
7. **§9:** under the fleet-host risks, add one bullet: the sidecar tokenizes and runs session-written transcript text as the holder's uid. The input is token ids into a fixed ONNX graph, and the risk is in the same class as ingest's parser. In single-container mode a session can kill the sidecar, which turns search off until the next holder.
8. **§11 *Remote host: what remains*:**
   - Remove the `search_transcripts` bullet.
   - Keep the HNSW trigger (D44/D70): revisit when host p50 exceeds 250 ms or one scope exceeds 250k rows, which becomes likely after (e).
   - Add the host checklist line: after the image rolls out, run `fleet-host embed-check` in the pod, then check that `search_transcripts` returns hits from a session, and that a host with `search: { embedder: false }` shows "search off" in the desktop.
9. **Decisions:** record D64–D68 and D75–D81 in SPEC's decision log, where (d1)'s D53–D63 sit.

- [ ] **Step 2: Run the full gate** (as (d1) Task 10 Step 2), plus `bash embedder/scripts/install-zigbuild.test.sh`, plus `docker build -f docker/host/Dockerfile .` and `docker/host/smoke.test.sh` where Docker is available.
- [ ] **Step 3: Commit** `docs(spec): host embedder sidecar, history:search, federated search (remote d2)` with the trailer.

## Questions for Troy

None open. Both were answered on 2026-11-10 (D82, D83).

## Self-review notes

- **Coverage:**
  - Search merge by score with the model check (D64, Task 10). The metric is verified by tests: the PG parity fixture and the build-time reference check across arches.
  - The host embedder as the sidecar (D65, D75–D78, Tasks 2–5).
  - The off-switch in config, holder, MCP and RPC, plus the desktop reason (D79; Tasks 6–10). Both settings are tested in `main.pg.test.ts`.
  - The indexer (D68, Task 7).
  - `search_transcripts` on the host (Task 8).
  - `history:search` with scope enforcement (Task 9).
  - Search-backed UI with badges and unavailable sources (Task 11).
  - Live-only: no hit is persisted.
  - Performance: inference out of process, enter-to-search, the 3 s bound.
- **D71:** no task creates a role or touches bootstrap.
- **D72:** safeguard 1 is D77 (Task 3 manifest, Task 5 stage); safeguard 2 is D79 (Tasks 6–10).
- **D73:** no split code. D81 explains why none is needed, and the files' modes and read-only use suit uid 1001 under `readOnlyRootFilesystem`.
- **Types:**
  - `SearchHitItem`, `FederatedSearchResult` and `SEARCH_UNAVAILABLE` live in `preload/federation.ts`, which the host and the desktop both import.
  - `parseSearchReq`/`SearchReq` are on the host; `parseSearchReply` is on the desktop.
  - The `UnavailableReason` `'model'` came from (d1); `'disabled'` is new here (Task 10), mirrored in `RemoteErrorKind`.
- **Allowlists:**
  - `src/main/embedderClient.ts` (Task 4) and `src/main/transcriptIndexCore.ts` (Tasks 5 and 7) are in `MAIN_ALLOWED`, `.dockerignore` and both workflow path lists.
  - `embedder/**` is in the context and both lists (Task 5).
  - `embeddings.ts` and `embedderModelFiles.ts` stay out of the host graph.
