# Model-endpoint workspaces — run non-Claude models (local or org-hosted) behind claude-code

**Date:** 2026-07-23
**Status:** approved (design review with Troy, this session)
**Builds on:** workspace env + vault (`resolveEnv`), local-backend workspaces (#106), Phase 2 session hooks (#208)

## Problem

Every fleet workspace today talks to the Anthropic API. Troy needs workspaces that run **other models**:

- **Privacy (driver B):** use a locally-run model (e.g. Qwen) to anonymize data before it reaches Claude, then rehydrate — the mapping never leaves the machine.
- **Org models (driver C):** SumerSports runs many models behind OpenAI-compatible HTTP endpoints on LAN/VPN that Troy wants to drive from fleet — including racing them side-by-side as committee experts.

## Decisions already made (this brainstorm)

1. **Fleet consumes endpoints; it does not manage inference.** No model downloads, no GPU scheduling, no inference containers as a product feature. An "endpoint" is a URL someone else keeps alive.
2. **The agent runtime stays claude-code.** The pinned `claude` binary pointed at a different backend via env. A custom-CLI escape hatch (arbitrary command per workspace) is tolerated later with dark observability, not designed for now.
3. **Zero protocol translation in fleet.** claude-code speaks the Anthropic Messages API only; the registry accepts **Anthropic-format** (`/v1/messages`) endpoints. vLLM (PR #22627) and Ollama (≥0.14) serve it natively; OpenAI-only endpoints get fronted by a LiteLLM gateway URL, which is just another endpoint entry from fleet's point of view.
4. **Parked — sub-project 3:** a `cloud` workspace kind on Anthropic Managed Agents (self-hosted-sandbox hybrid noted). Negates drivers B and C; revisit on demand.

## Empirically validated (2026-07-22, inside the manager workspace)

The pinned `claude` 2.1.177 was run against a local Ollama 0.32.1 serving `qwen3:4b` (CPU, 24 cores) with **only env vars** changed:

- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL` fully redirect claude-code — **even with OAuth `~/.claude/.credentials.json` mounted**, the env wins. No image or config-file changes.
- The agentic loop works end to end: qwen3:4b emitted a valid `Write` tool_use, the file was created, the run exited 0.
- **Observability survives untouched:** claude-code wrote a normal transcript JSONL with `message.model: "qwen3:4b"`, real `usage` token counts, and the tool call — the JSONL→SQLite pipeline ingests it with zero changes and attributes tokens to the real model name.
- **Context-window trap:** claude-code's *first* request was **35,099 tokens**; Ollama's default allocation is 4,096 and silently truncates. `OLLAMA_CONTEXT_LENGTH=40960` is the working floor (32K is *not* enough).
- Ollama 404s `/v1/messages/count_tokens`; claude-code tolerates it. The save-time probe must not require it.
- CPU-only is functionally correct but slow (~67 min for the smoke run) — fine for integration tests with short prompts, not a daily driver.

## Design

### A. Endpoint registry (app-level)

New Settings section **Model Endpoints**. Each entry:

```
{ id, name, baseUrl, modelId, smallFastModelId?, contextLength?, notes? }
```

- Non-secret fields persist in app-level config on disk; the optional **API key** goes in the existing `safeStorage` vault under an endpoint-scoped key (not tied to a workspace id). Endpoints without auth (typical LAN Ollama/vLLM) leave it empty and fleet sends a placeholder token (`ollama`-style servers require *a* value, not a valid one).
- **Save-time probe:** one `POST {baseUrl}/v1/messages` with `max_tokens: 1`. Success ⇒ green. Failure ⇒ actionable message: "endpoint does not speak the Anthropic Messages API — front it with a LiteLLM/other gateway and register the gateway URL" (docs link). `count_tokens` is explicitly **not** probed or required.
- `contextLength` is display metadata (the *server* owns the real allocation — fleet cannot enforce it); used by any context-meter math, else omitted.

### B. Workspace backend selection

`AuthMode` gains a third value: `'oauth' | 'apikey' | 'endpoint'`. The create modal's auth section becomes a **backend picker**: Claude (OAuth) / Claude (API key) / Model endpoint → registry dropdown. The manifest stores `authMode: 'endpoint'` + `endpointId` (a reference — the registry row stays the source of truth so key rotation and URL edits apply on next container create / local spawn).

At env-assembly time (both runtimes — `docker.ts` container `Env` and `local.ts` `buildEnv`), an endpoint workspace compiles its backend to ordinary workspace env:

```
ANTHROPIC_BASE_URL=<baseUrl>
ANTHROPIC_AUTH_TOKEN=<vault key, resolved like any secretKey>
ANTHROPIC_MODEL=<modelId>
ANTHROPIC_SMALL_FAST_MODEL=<smallFastModelId ?? modelId>
CF_SUMMARY_MODEL=<modelId>          # summaries generate on the same backend — privacy-consistent by construction
```

No new injection machinery: this rides the existing `resolveEnv` path. Explicit user-set workspace env still wins over compiled backend env (user overrides are overrides).

**Endpoint workspaces do not bind the shared OAuth credentials file** (the `authMode === 'oauth'` bind is simply not taken, same as `apikey` today). No Anthropic credential exists inside a Qwen workspace — deliberate groundwork for the quarantined tier (sub-project 2).

### C. Observability fallbacks

The pipeline is backend-blind (validated above). Two graceful degradations:

- **Pricing:** `pricing.ts` returns **$0 for unknown `(model, tier)`**; UI renders "—"/"local" rather than a fabricated dollar figure. Token counts stay real.
- **`get_config`** additionally reports the caller workspace's backend (`{ backend: 'endpoint', name, baseUrl, modelId }` — never the token), so agents can introspect what they're running on.

### D. Test fixture (dev/test only — not a product feature)

`docker/inference/compose.yaml`: official `ollama/ollama`, `OLLAMA_CONTEXT_LENGTH=40960`, named model volume, port `11434` published on the host, optional `gpu` profile (`--gpus=all`). Workspaces reach it at `http://host.docker.internal:11434` (works out of the box on Docker Desktop/WSL2; Linux needs `host-gateway`). Troy's machine is CPU-only — the fixture's default profile is CPU with a small model (`qwen3:4b`), positioned strictly for integration testing; org endpoints are the real workhorses.

`docs/local-models.md` recipe covers: Ollama (version floor 0.14+, the 40960 context trap in bold), vLLM (`--enable-auto-tool-choice --tool-call-parser`, native `/v1/messages`), LiteLLM-as-gateway for OpenAI-only endpoints (with the PyPI supply-chain caution: pin versions), and optional `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` to populate the `/model` picker from a gateway's `/v1/models`.

E2E: one Playwright spec creating an endpoint workspace against a stub Anthropic-format server (in-process HTTP, no model — the claude-stub pattern from `tests/fixtures/`). Pulling real model weights in CI is out; the compose fixture is for manual/local validation.

### E. Committee — free

Experts are workspaces; a committee mixing Claude and org-model experts is just workspaces with different backends. No committee changes.

## Non-goals

- Fleet-managed inference (downloads, GPU scheduling, serving).
- Protocol translation of any kind.
- Per-message/per-turn model switching inside a workspace — one backend per workspace (want two models ⇒ two workspaces; the quarantine tier requires this 1:1 anyway).
- Anonymize→rehydrate pipeline — user-space loadout config after this ships, not app code.

## Open questions (resolve during planning/implementation)

- Vault API shape for non-workspace-scoped secrets (endpoint keys) — likely a reserved id namespace, pin during planning.
- Whether `ANTHROPIC_DEFAULT_HAIKU_MODEL`-style per-tier overrides (newer claude-code) should also be compiled; validate against the pinned claude version.
- Summarizer output quality on small local models (strict-JSON compliance) — watch after activation; `CF_SUMMARY_MODEL` is already workspace-env overridable if a given backend needs a different summarist.
