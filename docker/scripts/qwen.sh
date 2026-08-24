#!/usr/bin/env bash
# qwen-code — Qwen Code CLI (npm global). Installed into the qwen variant
# runner image so the broker can exec `qwen` in place of `claude`.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${QWEN_VERSION:-0.22.0}"
npm install -g "@qwen-code/qwen-code@${V}"
qwen --version | sed -n '1p'  # sed, not head — head SIGPIPEs the producer under QEMU (see apt-tools.sh)
