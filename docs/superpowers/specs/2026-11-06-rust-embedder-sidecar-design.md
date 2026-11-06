# Rust embedder sidecar — design

**Date:** 2026-11-06
**Related:** #464 (startup stall storm: the 18.7 s `embed.load` stall, ~250 MB native RSS in main), #465 (runtime decision gate: carve hot subsystems out of process; Rust first), knowledge-claims spec `2026-11-04-knowledge-claims-design.md` (claims embed through the same `EmbedFn`), state.db retention spec (parallel; may change the vector *storage* format, never the `EmbedFn` contract).

## Goal

Move text embedding out of the Electron main process into a small Rust binary, `fleet-embedder`, spawned by main and spoken to over stdio. The `EmbedFn` interface (`embed(texts) → Promise<Float32Array[]>`, L2-normalized, 384-d) is unchanged, so transcript indexing, `search_transcripts`, and claims don't change.

Success, measured on the host after install:
- Re-running the #464 attribution query shows no `claude_fleet.embed.*` stall on the main thread.
- Main RSS in the `mem` perf rows drops by roughly the embedder's ~250 MB.

## Decisions (already made, restated)

- Rust crate `claude-fleet/embedder/` (sibling of `broker/`). `ort` (onnxruntime, statically linked via `download-binaries`, single binary) and HF `tokenizers`.
- Main spawns it lazily on the first `embed()` call. Messages are length-prefixed over stdio. Main restarts it with backoff. It exits when stdin closes.
- Same model and files: `Xenova/bge-small-en-v1.5`, `onnx/model_quantized.onnx` (q8) plus `tokenizer.json`, read from the existing `<userData>/models` transformers.js cache. Nothing is re-downloaded when the cache is warm.
- Parity: cosine ≥ 0.999 against the current transformers.js output on a fixed corpus, so existing embeddings stay valid and `EMBED_MODEL_ID` does not change (no re-index).
- The transformers.js in-process embedder stays for one release, as the automatic fallback and as the parity oracle.
- The startup backfill must never block the main thread, and `index.delete_stale_models` becomes async in fact (it is async in signature but ran a 991 ms synchronous full-table scan on SQLite).

## Open questions — resolved

### 1. Local WSL `make dist` for Windows: CI-built binary (chosen) vs cargo-xwin

**Chosen: download the CI-built Windows binary.** A new `make embedder-win` target fetches the `fleet-embedder-windows` artifact from the latest successful `build-app` run on `main` with `gh run download`. `EMBEDDER_WIN=<path>` overrides it with a local file. `make windows` / `make portable` depend on it. If the download fails (no `gh` auth, no run yet), the target warns and continues: the installer ships without the binary and the app falls back to transformers.js. A local build never fails over the sidecar.

Rejected: **cargo-xwin.** It downloads the MSVC CRT/SDK (license acceptance on every fresh machine), needs `clang`/`lld-link` in WSL, and `ort`'s prebuilt static onnxruntime for `x86_64-pc-windows-msvc` must match the CRT linkage xwin provides (`/MD` vs `/MT`). That is a new toolchain to keep working for a path Troy rarely uses, when CI already builds the same binary natively on `windows-latest`.

### 2. Fallback trigger and crash-loop threshold

The sidecar client (`embedderClient.ts`) picks a backend per process lifetime:

| Condition | Action |
|---|---|
| Binary not found (packaged `resources/embedder/`, dev `embedder/target/release/`, or `FLEET_EMBEDDER_BIN`) | Fallback immediately; log `embedder-fallback` (warn) once with the reason. |
| `CLAUDE_FLEET_EMBEDDER=inprocess` | Fallback (escape hatch for host debugging). |
| Model files missing from the cache | Main downloads them first (see *Model files*); if that fails, fallback. |
| Child exits/crashes, or fails its `ready` handshake, or a request exceeds the 120 s timeout (child killed) | Count a failure; restart with backoff 1 s, 2 s, 4 s, 8 s … capped at 30 s. In-flight requests are re-sent once to the next child. |
| **3 failures within 5 minutes** | Crash loop: stop restarting, switch to the in-process fallback for the rest of the app run, log `embedder-fallback` (error) once. The next app start tries the sidecar again. |

A request that fails twice (original plus one resend) rejects. Callers already treat a rejected embed as "degrade search, log, retry on next ingest".

Why 3 in 5 min: a broken binary or model fails on every start, so 3 tries (~7 s of backoff) is enough to detect it without stalling indexing. A one-off crash (e.g. OOM under load) resets once the 5-minute window passes and stays on the sidecar.

## Architecture

```
main (Node)                                         fleet-embedder (Rust)
──────────────────────────────────────              ─────────────────────────────
embeddings.ts: makeEmbedder(cacheDir)  ── EmbedFn ──▶
  └─ embedderClient.ts                                 main.rs  read frame → dispatch
       spawn(bin, ['--model-dir', dir])  stdin  ───▶    protocol.rs  framing + JSON
       request queue, timeout, restart   stdout ◀───    embed.rs  tokenize → ort run
       backoff, crash-loop → fallback    stderr ───▶         → mean-pool(mask) → L2
  └─ embeddingsInProcess.ts (today's transformers.js code, moved verbatim)
```

### Protocol (stdio)

Every frame is a 4-byte little-endian unsigned length followed by that many bytes of UTF-8 JSON. Max frame 64 MiB; a larger declared length is a protocol error and the child exits 2.

- Child → main, once after the model loads: `{"type":"ready","model":"Xenova/bge-small-en-v1.5","dim":384}`. If the load fails, it sends `{"type":"fatal","error":"…"}` and exits 1.
- Main → child: `{"id":<u64>,"texts":["…", …]}`.
- Child → main: `{"id":<u64>,"vectors":"<base64 of n×384 float32 LE>","n":<n>,"dim":384}`, or `{"id":<u64>,"error":"…"}`. The child processes requests in order; ids let main match responses and detect a desync.
- EOF on stdin → exit 0. stderr is free-form logs; main forwards them to `logError` (warn, `embedder-stderr`), rate-limited.

Base64 float32 keeps the payload exact (no float→decimal→float round trip) and small (8 texts × 384 × 4 B ≈ 16 KB).

### Inference (must match transformers.js)

transformers.js `pipeline('feature-extraction', …)(texts, { pooling: 'mean', normalize: true })` does:
1. Tokenize with `tokenizer.json`, add special tokens, then truncate the ids to 512 (`model_max_length`). It truncates *after* adding specials, so a long text loses its trailing `[SEP]`. Then pad to the batch's longest.
2. Run the model with `input_ids`, `attention_mask`, and `token_type_ids` (zeros).
3. Mean-pool `last_hidden_state` over tokens weighted by `attention_mask`.
4. L2-normalize.

The sidecar does the same, with two deliberate differences, both measured on the parity corpus:

- **Each text runs alone, unpadded.** The q8 model quantizes activations with one dynamic scale per tensor, padded positions included, so in transformers.js a text's vector depends on its batch neighbours: the same text embedded alone vs in a padded batch of 8 scores cosine as low as 0.967 (mean 0.995). Stored vectors already carry that noise. Per-text inference makes a vector a function of its text only, and it is the only batch-independent oracle for parity.
- **onnxruntime 1.22 (`ort` 2.0.0-rc.10), not the newest.** transformers.js ships onnxruntime-node 1.21. Against it, per text: ORT 1.22 gives cosine 1.000000 on all 40 texts; ORT 1.24 (`ort` rc.12) gives min 0.9963 (4 texts below 0.999). Token ids were identical in both cases, so the drift is in the newer q8 kernels. Bump ORT only with a passing parity run.

`tokenizers` runs with its own truncation and padding disabled; the sidecar truncates and pads by hand as above. Graph optimization level 3 and intra-op threads = min(4, cores). Dedupe and search rely on `dot == cosine`, so normalization is asserted in tests.

### Model files

transformers.js caches at `<cacheDir>/Xenova/bge-small-en-v1.5/{tokenizer.json,config.json,tokenizer_config.json,onnx/model_quantized.onnx}`. The sidecar reads `tokenizer.json` and `onnx/model_quantized.onnx` from there; it never downloads. On a fresh install (cold cache) main runs `ensureModelFiles(cacheDir)` first: an async `fetch` of the missing files from `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/<file>`, written to a temp file and renamed into place, so transformers.js still finds the same files if fallback is used later.

### Binary location and packaging

- Packaged: `process.resourcesPath/embedder/fleet-embedder[.exe]` via electron-builder `extraResources` (`from: embedder/bin`, `to: embedder`). `embedder/bin/` is committed with a `.gitkeep`; the binary is git-ignored.
- Dev: `embedder/target/release/fleet-embedder[.exe]`.
- `FLEET_EMBEDDER_BIN` overrides both (tests, debugging).

CI (`build-app.yml` build job + `release.yml`, all three OSes): the toolchain pinned in `embedder/rust-toolchain.toml`, `libssl-dev` on Linux (ort rc.10's build-time ORT download uses native-tls), `cargo build --release --locked` in `embedder/`, copy the binary into `embedder/bin/`, then `npm run dist`. The Windows job also uploads `fleet-embedder-windows` (the binary alone) for `make embedder-win`. `embedder/` joins the `changes` path filter. The `unit-run` job runs `cargo test` and the parity test (below), with the model cached under `actions/cache`.

macOS builds for the runner's arch (arm64), the same as the rest of the app. onnxruntime is statically linked, so no `.dylib`/`.dll`/`.so` ships beside it.

### transformers.js fallback

The current `makeEmbedder` body moves verbatim to `embeddingsInProcess.ts`. `makeEmbedder(cacheDir)` becomes the selector: it returns an `EmbedFn` that delegates to the sidecar client and swaps to the in-process embedder (built lazily, so `require('@huggingface/transformers')` never runs unless fallback triggers) when the client reports permanent failure. `@huggingface/transformers`, `onnxruntime-node`, `sharp` and their `asarUnpack` entries stay for this release. Removing them is a follow-up issue for the next release.

### Startup backfill and `delete_stale_models`

- **`delete_stale_models`:** the full-scan `DELETE … WHERE model_id != ?` runs only when the model id changed. Main records the last-cleaned model id in `<userData>/models/.embed-model-id` (no schema change, so no conflict with the retention work). If it matches `EMBED_MODEL_ID`, the step is skipped. Otherwise it deletes in chunks (`DELETE … WHERE id IN (SELECT id … LIMIT 500)`) and yields a macrotask between chunks, then writes the marker.
- **Backfill scheduling:** the `embed-backfill` service step starts the backfill after a 30 s delay (boot work and the initial JSONL ingest backlog run first, #464). The loop yields a macrotask (`setImmediate`) between sessions and between batches. Every remaining synchronous step is one bounded query (≤ 8 rows) or one small insert. Embedding itself is out of process, so its CPU no longer lands on the main loop.
- Spans stay as they are (`boot.embed_backfill`, `index.*`, `embed.run`). `embed.require` and `embed.load` fire only on the fallback path, so their absence on the host confirms the sidecar ran. A new `claude_fleet.embed.spawn` span covers spawn to `ready`.

## Testing

- **Rust (`cargo test`):** framing round-trip; oversized-length rejection; EOF exits cleanly; masked mean pooling and L2 norm on a tiny hand-made tensor; padding does not change a text's vector (batch vs single).
- **TS unit (`embedderClient.test.ts`):** against a fake child (a Node script speaking the protocol): request/response matching, timeout kill and restart, resend once, backoff timing (fake timers), 3-in-5-min crash loop → fallback, missing binary → fallback, stdin close on dispose.
- **Parity (`embedderParity.test.ts`, gated on `CF_EMBED_PARITY=1` + a built binary):** a fixed 40-text corpus in `src/main/__fixtures__/embed-parity-corpus.json` (short, long >512 tokens, code, unicode, whitespace-heavy, near-duplicates). Embeds each text alone with transformers.js (in-process) and in batches of 8 with the sidecar; asserts per-text cosine ≥ 0.999 and every norm within 1e-4 of 1. Result: min cosine 1.000000, mean 1.000000.
- Existing `transcriptIndex`, claims, and search tests stay unchanged: `EmbedFn` is stubbed there.

## SPEC.md changes

- §2 stack table: add the `fleet-embedder` row (Rust, `ort` + `tokenizers`), and mark transformers.js/onnxruntime-node as fallback-only.
- §4 *Native modules*: the sidecar ships as an `extraResources` binary, not an asar-unpacked module.
- §7 *Local embeddings*: the process model, protocol, fallback rules, model-file handling, and backfill scheduling.

## Out of scope

- Changing the model, dtype, or `EMBED_MODEL_ID` (parity keeps them).
- Vector storage format (owned by the state.db retention spec).
- An embedder on the remote fleet-host (`search_transcripts` there stays `Unknown tool`).
- Removing transformers.js (next release, follow-up issue).
- Code-signing the binary (the app is unsigned today).
