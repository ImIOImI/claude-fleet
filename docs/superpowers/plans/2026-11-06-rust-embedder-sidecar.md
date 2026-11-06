# Rust embedder sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed text in a Rust sidecar (`fleet-embedder`) instead of in the Electron main process, with the `EmbedFn` contract and stored vectors unchanged.

**Architecture:** A Rust binary in `embedder/` loads the cached bge-small q8 ONNX model with `ort` and `tokenizers`, and answers length-prefixed JSON requests on stdio. `src/main/embedderClient.ts` spawns it lazily, matches responses, restarts on failure, and reports a crash loop. `makeEmbedder` picks the sidecar and falls back to the old transformers.js code, now in `embeddingsInProcess.ts`.

**Tech Stack:** Rust stable (edition 2021), `ort` 2.0.0-rc.12 (`download-binaries`, `tls-rustls`), `tokenizers` 0.21 (`fancy-regex`), Node 22 / Electron main, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-06-rust-embedder-sidecar-design.md` · **Issue:** #525

## Global Constraints

- `EmbedFn` = `(texts: string[]) => Promise<Float32Array[]>`; 384-d, L2-normalized. Not changed.
- `EMBED_MODEL_ID` stays `Xenova/bge-small-en-v1.5@q8`. No re-index.
- Model files: `<cacheDir>/Xenova/bge-small-en-v1.5/tokenizer.json` and `.../onnx/model_quantized.onnx`.
- Parity: per-text cosine ≥ 0.999 vs transformers.js; norm within 1e-4 of 1.
- Tokenization must match transformers.js: add special tokens, then truncate ids to 512 (the trailing `[SEP]` is dropped when truncated), then pad to the batch's longest with pad id and mask 0. `token_type_ids` are all 0.
- Frame = u32 LE length + UTF-8 JSON; max 64 MiB.
- Crash loop = 3 failures within 5 min → in-process fallback for the rest of the run. Backoff 1, 2, 4, 8 … ≤30 s. Request timeout 120 s. One resend per request.
- Binary lookup order: `FLEET_EMBEDDER_BIN`, packaged `process.resourcesPath/embedder/fleet-embedder[.exe]`, dev `<appPath>/embedder/target/release/fleet-embedder[.exe]`.
- `CLAUDE_FLEET_EMBEDDER=inprocess` forces the fallback.
- Code comments terse and necessary (`.claude/rules/review-conventions.md`).

---

### Task 1: Rust crate — protocol and inference

**Files:**
- Create: `embedder/Cargo.toml`, `embedder/Cargo.lock`, `embedder/build.rs`, `embedder/glibc_compat.c`, `embedder/src/main.rs`, `embedder/src/protocol.rs`, `embedder/src/embed.rs`, `embedder/README.md`, `embedder/bin/.gitkeep`, `embedder/.gitignore`

**Interfaces:**
- Produces: CLI `fleet-embedder --model-dir <dir>` (`<dir>` = the HF repo dir, i.e. `<cacheDir>/Xenova/bge-small-en-v1.5`). Frames as in the spec. `ready` → `{"type":"ready","model":…,"dim":384}`; `fatal` → `{"type":"fatal","error":…}` + exit 1; response `{"id","n","dim","vectors":<base64 f32le>}` or `{"id","error"}`.

- [ ] Step 1: `protocol.rs` with `read_frame<R: Read>(r) -> io::Result<Option<Vec<u8>>>` (None on clean EOF at a frame boundary; error on a length > `MAX_FRAME`) and `write_frame<W: Write>(w, &[u8])`. Unit tests: round-trip, EOF → None, oversized → Err, truncated body → Err.
- [ ] Step 2: `embed.rs`: `pub fn pool_and_normalize(hidden: &[f32], mask: &[i64], batch, seq, dim) -> Vec<Vec<f32>>` (masked mean, then L2). Unit tests on a 2×3×2 hand tensor; a zero-mask row yields zeros, not NaN.
- [ ] Step 3: `Embedder::load(model_dir)`: the tokenizer with `with_truncation(None)` and `with_padding(None)`; an `ort` session with intra-op threads `min(4, available_parallelism)`; input names read from the session (feed `token_type_ids` only if declared). `embed(&[String]) -> Result<Vec<Vec<f32>>>`: `encode_batch(texts, true)`, truncate to 512, pad to the batch max with the `[PAD]` id (fallback 0), run, take output 0 (`last_hidden_state`), `pool_and_normalize`.
- [ ] Step 4: `main.rs`: parse `--model-dir`, load (on error → `fatal` frame, exit 1), send `ready`, loop `read_frame` → JSON `{id, texts}` → embed → response. Bad JSON → error frame with `id: null`. EOF → exit 0.
- [ ] Step 5: `cargo test` passes; `cargo build --release`; manual smoke test with the cached model (Task 3 has the parity test).
- [ ] Step 6: Commit `feat(embedder): Rust fleet-embedder sidecar crate (#525)`.

### Task 2: TS client, selector and fallback

**Files:**
- Create: `src/main/embedderClient.ts`, `src/main/embedderClient.test.ts`, `src/main/embeddingsInProcess.ts`, `src/main/embedderModelFiles.ts`, `src/main/embedderModelFiles.test.ts`, `src/main/__fixtures__/fake-embedder.mjs`
- Modify: `src/main/embeddings.ts` (selector), `src/main/embeddings.test.ts` (the CJS-require regression now targets `embeddingsInProcess.ts`)

**Interfaces:**
- Produces:
  - `encodeFrame(obj: unknown): Buffer`, `FrameDecoder` (`push(chunk): unknown[]`)
  - `class EmbedderClient { constructor(opts: { bin: string; args: string[]; timeoutMs?: number; now?: () => number; onFatal: (reason: string) => void; log: (msg: string) => void }); embed(texts: string[]): Promise<Float32Array[]>; dispose(): void }`. `onFatal` fires once, when the crash loop is detected; pending/future calls then reject with `EmbedderUnavailable`.
  - `export class EmbedderUnavailable extends Error`
  - `resolveEmbedderBin(env, platform, { packaged, resourcesPath, appPath }): string | null` (returns the first existing path)
  - `ensureModelFiles(cacheDir: string, fetchImpl?: typeof fetch): Promise<string>` → model dir
  - `makeInProcessEmbedder(cacheDir: string): EmbedFn` (the old body, verbatim)
  - `makeEmbedder(cacheDir: string, opts?: { bin?: string | null; forceInProcess?: boolean }): EmbedFn`

- [ ] Step 1: Fake child `fake-embedder.mjs` speaking the protocol; behaviour selected by env `FAKE_MODE` = `ok` | `crash-on-first` | `never-ready` | `hang` | `fatal`. It returns deterministic unit vectors (e.g. one-hot on `text.length % 384`).
- [ ] Step 2: Failing tests in `embedderClient.test.ts`: round-trip vectors are `Float32Array(384)`; two concurrent calls resolve to their own ids; `crash-on-first` → the request is resent and succeeds; `fatal`/`never-ready` 3× → `onFatal` called once, the call rejects `EmbedderUnavailable`; `hang` with `timeoutMs: 200` → the child is killed and counts as a failure; `dispose()` closes stdin and the child exits.
- [ ] Step 3: Implement `embedderClient.ts`: lazy `spawn` (stdio pipe; `windowsHide: true`), a `ready` gate, an in-order queue (one request in flight; the sidecar is sequential anyway), restart with backoff, a failure window of 3 in 5 min. stderr → `log`, rate-limited to 20 lines/min.
- [ ] Step 4: `embedderModelFiles.ts` + test: an existing file is not re-fetched; a missing one is fetched to `.tmp` and renamed; a non-OK response throws.
- [ ] Step 5: Move the transformers.js body into `embeddingsInProcess.ts`. `embeddings.ts`'s `makeEmbedder` resolves the bin (`app` imported lazily so tests can pass `opts.bin`), creates the client with `--model-dir` from `ensureModelFiles`, and on `EmbedderUnavailable` or a missing bin switches to `makeInProcessEmbedder` permanently (one `logError` `embedder-fallback`). It wraps spawn-to-ready in a `claude_fleet.embed.spawn` span.
- [ ] Step 6: `npx vitest run src/main/embedderClient.test.ts src/main/embedderModelFiles.test.ts src/main/embeddings.test.ts`; `npm run typecheck:node` and `npm run typecheck:web` separately.
- [ ] Step 7: Commit `feat(embeddings): spawn fleet-embedder sidecar with in-process fallback (#525)`.

### Task 3: Parity test

**Files:**
- Create: `src/main/__fixtures__/embed-parity-corpus.json` (40 texts), `src/main/embedderParity.test.ts`

- [ ] Step 1: Corpus: short phrases, a 1000-char turn, a >512-token text (exercises truncation), code, unicode/emoji/CJK, whitespace runs, near-duplicates, a single word.
- [ ] Step 2: Test (skips unless `CF_EMBED_PARITY=1` and `FLEET_EMBEDDER_BIN` exists): embed the corpus in batches of 8 with `makeInProcessEmbedder(HF_CACHE)` and with an `EmbedderClient` on the same cache; assert per-text cosine ≥ 0.999 and norms within 1e-4 of 1; log min/mean cosine.
- [ ] Step 3: Run it locally and record the numbers for the PR.
- [ ] Step 4: Commit `test(embedder): transformers.js parity on a fixed corpus (#525)`.

### Task 4: Backfill and stale-model cleanup off the main loop

**Files:**
- Modify: `src/main/db.ts` (`deleteEmbeddingsForOtherModels` chunked), `src/main/index.ts` (`startEmbedBackfill`), `src/main/dbEmbeddings.test.ts`
- Create: `src/main/embedBackfill.ts`, `src/main/embedBackfill.test.ts`

**Interfaces:**
- Produces: `deleteEmbeddingsForOtherModels(modelId, chunk = 500, yieldFn = yieldMacrotask): Promise<number>` (same result); `runEmbedBackfill(deps: { markerPath: string; modelId: string; deleteStale: () => Promise<number>; listSessionIds: () => Promise<string[]>; indexTurns: (id: string) => Promise<unknown>; indexSummaries: () => Promise<unknown>; yieldFn?: () => Promise<void> }): Promise<void>`; `EMBED_BACKFILL_DELAY_MS = 30_000`.

- [ ] Step 1: Failing tests: the marker equals the model → `deleteStale` not called; marker absent/different → called, then the marker is written; `yieldFn` is called between sessions; chunked delete removes 1,200 rows across 3 chunks with 3 yields (SQLite).
- [ ] Step 2: Implement. The chunked delete is `DELETE FROM embeddings WHERE id IN (SELECT id FROM embeddings WHERE model_id != ? LIMIT ?)` in a loop until 0 rows, yielding via `setImmediate` between chunks. `index.ts` calls `runEmbedBackfill` after `setTimeout(EMBED_BACKFILL_DELAY_MS)` (unref'd), keeping the existing spans.
- [ ] Step 3: Run `npx vitest run src/main/embedBackfill.test.ts src/main/dbEmbeddings.test.ts`, and the PG variant if `PG_TEST_URL` is available.
- [ ] Step 4: Commit `perf(index): defer + yield the embed backfill; skip stale-model scan via marker (#464, #525)`.

### Task 5: Packaging, CI, Makefile, SPEC

**Files:**
- Modify: `electron-builder.yml` (`extraResources` embedder/bin → embedder), `.github/workflows/build-app.yml` (changes filter `embedder/`; build job: Rust toolchain + `cargo build --release --locked` + copy into `embedder/bin/`; Windows uploads `fleet-embedder-windows`; unit-run: `cargo test --locked`, build, a model cache, and the parity test), `.github/workflows/release.yml` (same build steps), `Makefile` (`embedder-win` target; `windows`/`portable` depend on it), `docs/SPEC.md` (§2 stack row, §4 native modules note, §7 Local embeddings process model + fallback + backfill; §6 spans list adds `embed.spawn`), `.gitignore`

- [ ] Step 1: Edit the files. Pin the Rust toolchain with `embedder/rust-toolchain.toml` (`channel = "1.91"`) so CI and local builds match.
- [ ] Step 2: `python3 -c 'import yaml…'` (or `npx js-yaml`) to parse every edited YAML; run `make -n embedder-win windows`.
- [ ] Step 3: Commit `build(embedder): CI native builds, electron-builder packaging, make embedder-win; SPEC (#525)`.

### Task 6: Whole-branch review, PR, notify

- [ ] Step 1: Review the full diff against the spec (correctness, Windows paths/`.exe`, child-process lifecycle on app quit, no sync work added on the main loop).
- [ ] Step 2: Fix findings; re-run the scoped tests, both typechecks, and `cargo test`.
- [ ] Step 3: Push, open the PR (factual body; parity numbers; host verification: the #464 attribution query + `mem` rows), `gh pr merge --auto --squash`.
- [ ] Step 4: Send a fleet-state `notify` (key `fleet-dev-milestones`) with the PR URL.
