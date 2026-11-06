# fleet-embedder

Text embedding sidecar for claude-fleet. The Electron main process spawns it (`src/main/embedderClient.ts`) so the model's load and inference never run on the main thread. Design: `docs/superpowers/specs/2026-11-06-rust-embedder-sidecar-design.md`.

## Model

`bge-small-en-v1.5`, q8 ONNX, read from the transformers.js cache: `<userData>/models/Xenova/bge-small-en-v1.5/{tokenizer.json,onnx/model_quantized.onnx}`. The sidecar never downloads; main fetches missing files first (`embedderModelFiles.ts`). Output matches transformers.js `feature-extraction` with `pooling: 'mean', normalize: true` on one text at a time (cosine 1.000000 on the parity corpus, `embedderParity.test.ts`), so stored vectors stay valid. Each text runs unpadded: the q8 model's dynamic activation quantization makes padded-batch vectors depend on their batch neighbours.

onnxruntime is pinned to 1.22 (`ort` 2.0.0-rc.10) because it matches transformers.js's onnxruntime-node 1.21 exactly; 1.24 drifted to cosine 0.996. Re-run the parity test before bumping `ort`.

## Protocol (stdio)

Each frame is a u32 little-endian length, then that many bytes of UTF-8 JSON (max 64 MiB).

| Direction | Frame |
|---|---|
| out, once | `{"type":"ready","model":"Xenova/bge-small-en-v1.5","dim":384}`, or `{"type":"fatal","error":"…"}` then exit 1 |
| in | `{"id":1,"texts":["…"]}` |
| out | `{"id":1,"n":1,"dim":384,"vectors":"<base64 of n×384 f32 LE>"}`, or `{"id":1,"error":"…"}` |

Requests are answered in order. EOF on stdin → exit 0. stderr is free-form logging.

## Build

```bash
cargo build --release      # target/release/fleet-embedder[.exe]
cargo test
```

`ort` statically links a prebuilt onnxruntime downloaded at build time, so the binary has no runtime library dependencies. On Linux that download needs OpenSSL headers (`libssl-dev`). Without them, download the `none x86_64-unknown-linux-gnu` tarball listed in ort-sys's `dist.txt`, drop `download-binaries` from the `ort` features, and build with `ORT_LIB_LOCATION=<dir containing libonnxruntime.a>`. `glibc_compat.c` lets the Linux build link and run on glibc < 2.38. The toolchain is pinned in `rust-toolchain.toml`.

Packaging: CI copies the binary to `embedder/bin/`, and electron-builder ships that as `resources/embedder/`. Local Windows `make dist` fetches the CI-built binary with `make embedder-win`.
