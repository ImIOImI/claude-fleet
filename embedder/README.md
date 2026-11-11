# fleet-embedder

Text embedding sidecar for claude-fleet. The Electron main process spawns it (`src/main/embedderClient.ts`) so the model's load and inference never run on the main thread. Design: `docs/superpowers/specs/2026-11-06-rust-embedder-sidecar-design.md`.

## Model

`bge-small-en-v1.5`, q8 ONNX, read from the transformers.js cache: `<userData>/models/Xenova/bge-small-en-v1.5/{tokenizer.json,onnx/model_quantized.onnx}`. The sidecar never downloads; main fetches missing files first (`embedderModelFiles.ts`).

Output equals transformers.js `feature-extraction` (`pooling: 'mean', normalize: true`) run on one text at a time: cosine 1.000000 on the parity corpus (`embedderParity.test.ts`), and the in-process fallback also embeds one text at a time. Each text runs unpadded because the q8 model's dynamic activation quantization makes a padded-batch vector depend on its batch neighbours. Rows written by earlier builds came from padded batches of 8 and differ from the unbatched vector by up to ~0.03 cosine; they are kept (no re-index).

onnxruntime is pinned to 1.22 (`ort` 2.0.0-rc.10): it matches the in-process onnxruntime-node 1.21 exactly, while 1.24 drifted to cosine 0.996. Re-run the parity test before bumping `ort`.

## Protocol (stdio)

Each frame is a u32 little-endian length, then that many bytes of UTF-8 JSON (max 64 MiB).

| Direction | Frame |
|---|---|
| out, once | `{"type":"ready","protocol":1,"model":"Xenova/bge-small-en-v1.5","dim":384}`, or `{"type":"fatal","error":"…"}` then exit 1 |
| in | `{"id":1,"texts":["…"]}` |
| out | `{"id":1,"n":1,"dim":384,"vectors":"<base64 of n×384 f32 LE>"}`, or `{"id":1,"error":"…"}` |

Requests are answered in order. `protocol` is bumped on any incompatible change; the host refuses a mismatch and embeds in process. EOF on stdin → exit 0. stderr is free-form logging.

## Build

```bash
cargo build --release      # target/release/fleet-embedder[.exe]
cargo test
```

`ort` links a prebuilt static onnxruntime. With the default `download-binaries` feature, ort-sys downloads it at build time (on Linux this needs OpenSSL headers, `libssl-dev`). Otherwise build with `--no-default-features` and `ORT_LIB_LOCATION=<dir containing libonnxruntime.a>`, from the tarball ort-sys's `dist.txt` lists for the target; `scripts/ci-build.sh` does this on Linux. The toolchain is pinned in `rust-toolchain.toml`.

Runtime dependencies (onnxruntime itself is linked in):

| OS | Needs |
|---|---|
| Linux | glibc ≥ 2.28 (`libc`, `libm`, `libpthread`, `libdl`); libstdc++ is linked statically |
| Windows | `msvcp140{,_1}.dll`, `vcruntime140{,_1}.dll` (shipped beside the exe); system `DirectML.dll`, `d3d12.dll`, `dxgi.dll`, `dxcore.dll` (Windows 10 2004 / build 19041+) |
| macOS | system libraries only; must keep its ad-hoc signature |

### glibc floor

Release builds use `scripts/ci-build.sh`; on Linux CI runs it through `scripts/ci-build-linux.sh` in a digest-pinned `rust:1.91-bookworm` container (GCC 12, glibc 2.36), since a newer distro's `libstdc++.a` references glibc symbols 2.28 lacks. On Linux the script fetches and sha256-checks onnxruntime, then runs `cargo zigbuild --release --no-default-features --target <arch>-unknown-linux-gnu.2.28` (`<arch>` from `uname -m`; needs [zig](https://ziglang.org) 0.14 and cargo-zigbuild; zig can't compile ort-sys's download path, which links OpenSSL). `scripts/install-zigbuild.sh <dest>` installs the pinned, sha256-checked zig 0.14.1 and cargo-zigbuild 0.24.1 into `<dest>/bin` (x86_64 only, D82). The host image's `embedder-build` stage runs the same two scripts (D76). zig links against glibc 2.28 symbol versions; `build.rs` links the host GCC's `libstdc++.a` statically (the script sets `ORT_CXX_STDLIB=` so ort-sys doesn't also link it dynamically); `glibc_compat.c` defines the newer-glibc symbols the prebuilt onnxruntime and libstdc++ reference (C23 `__isoc23_*` entry points, `__libc_single_threaded`, `gettid`); it is compiled only when `FLEET_GLIBC_COMPAT=1` (set by the script), together with the static libstdc++ link, because against glibc ≥ 2.38 headers its `strtol` calls would redirect back to the shims (an `#error` guards this). A plain `cargo build` links against the host glibc as usual. `scripts/check-glibc.sh <bin> 2.28` fails if any symbol needs a newer glibc or the C++ runtime is linked dynamically. A plain `cargo build` binds to the build host's glibc and is only for local use.

### Packaging

`scripts/ci-build.sh` copies the binary (and on Windows the VC++ DLLs) to `embedder/bin/`, and electron-builder ships that as `resources/embedder/`. It also runs `codesign -v` on macOS and a smoke start on every OS; CI then runs `scripts/smoke-embed.mjs` (a real embed with the cached model). Windows CI publishes `fleet-embedder-windows-x64.zip` on each release; local WSL builds fetch it with `make embedder-win` (default release `v<package.json version>`, else the newest, drafts included; `EMBEDDER_TAG`, `EMBEDDER_WIN_ZIP`, `ALLOW_NO_EMBEDDER=1`; needs `gh` and `unzip`).
