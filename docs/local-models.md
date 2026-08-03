# Using local and non-Claude models with claude-fleet

Fleet workspaces can run against any model endpoint that implements the Anthropic Messages API (`POST {baseUrl}/v1/messages`). This guide covers the setup, integration, and operational considerations.

## What fleet needs from an endpoint

A model endpoint must:

- Expose `POST {baseUrl}/v1/messages` — the Anthropic Messages API shape.
- Accept HTTP requests from fleet's runner container (typically `http://host.docker.internal:11434` for local endpoints, or a reachable IP/hostname for organization-hosted).
- Include a (possibly dummy) `Authorization: Bearer` header in requests — fleet always sends one, even if your endpoint ignores it.

**`count_tokens` is not required.** Fleet does not probe it at registration time or at runtime. The save-time endpoint check uses a minimal `max_tokens: 1` probe.

**API key / auth:** if your endpoint requires authentication, register the key in Settings → Model Endpoints (it lives in the OS vault, never on disk in plaintext). If your endpoint has no auth, leave the key field empty and fleet sends a placeholder token.

**Per-workspace selection:** each workspace picks one endpoint at creation time (Settings → Model Endpoints → dropdown in the workspace form). One endpoint = one registry entry; switching an endpoint requires creating a new workspace or editing the workspace manifest offline.

## Ollama (local, CPU or GPU)

**Requirements:**
- Ollama v0.14 or later (earlier versions do not support the Anthropic Messages API).
- A model with tool-calling support — `qwen3` family works well; Llama models vary by version.

### The context-window floor

**CRITICAL: `OLLAMA_CONTEXT_LENGTH=40960` is the minimum.**

- claude-code's first request to an LLM is approximately **35,000 tokens** (context + system message + tools + first user prompt).
- Ollama's default `OLLAMA_CONTEXT_LENGTH` is 4,096. This silently truncates incoming requests into garbage — claude-code's prompt becomes incoherent, tool calls fail, and debugging appears random.
- Setting it to 32K is **not enough**; the request will still truncate.
- The empirically validated floor is 40,960. Do not lower this.

### Test fixture

`docker/inference/compose.yaml` (in the repo root) spins up a local Ollama suitable for integration testing:

```bash
docker compose -f docker/inference/compose.yaml up -d
docker compose -f docker/inference/compose.yaml exec ollama ollama pull qwen3:4b
```

Register `http://host.docker.internal:11434` in Settings → Model Endpoints.

**GPU support:** add the `--profile gpu` flag to the compose command to use NVIDIA GPUs (requires the Docker NVIDIA runtime):

```bash
docker compose -f docker/inference/compose.yaml --profile gpu up -d
```

The GPU profile also sets `OLLAMA_CONTEXT_LENGTH=40960`.

### Performance expectations

CPU-only Ollama is functionally correct but slow — expect 1–2 minutes per round-trip on a modest CPU. Fine for integration testing and proof-of-concept; use organization endpoints or cloud instances for real work.

## vLLM

vLLM natively serves the Anthropic Messages API when started with the correct flags:

```bash
vllm serve \
  --model qwen/Qwen2.5-7B-Instruct \
  --enable-auto-tool-choice \
  --tool-call-parser mistral \
  --port 8000
```

Register `http://host:8000` in Settings → Model Endpoints.

**Tool-calling support:** vLLM requires both `--enable-auto-tool-choice` and `--tool-call-parser <parser>` (e.g. `mistral`, `hermes`) to handle function calls correctly. Consult vLLM's documentation for which parser suits your model.

## OpenAI-only endpoints

If your organization runs OpenAI-compatible endpoints (OpenAI SDK shape, not Anthropic), fleet does not translate protocols. Instead, **front the endpoint with a gateway** that converts to the Anthropic Messages API.

**LiteLLM gateway:**

LiteLLM can proxy OpenAI endpoints and translate them:

```bash
litellm --model openai/gpt-4o --base_url http://org-openai-endpoint:8000
```

Register the LiteLLM gateway URL (e.g. `http://localhost:8000`) in Settings → Model Endpoints.

**Version pinning:** LiteLLM pulls from PyPI; pin the version in your deployment to avoid supply-chain incidents:

```bash
pip install 'litellm==1.50.5'  # use a pinned version, not latest
```

## Cost and observability

**Cost display:** endpoints without a registered price show "—" (em-dash) instead of a dollar amount. Token counts remain accurate.

**Transcripts, sessions, summaries:** work identically to Claude-backed workspaces. Session summaries (`CF_SUMMARY_MODEL`) automatically use the endpoint model, so your privacy tier is consistent end-to-end.

**Committee:** expert workspaces with non-Claude backends mix and match with Claude experts. No special handling.

**Backend introspection:** use the `get_config` MCP tool (available inside your workspace) to query the current backend model and endpoint URL.

## Optional: auto-populate the model picker

If your endpoint gateway exposes a `/v1/models` endpoint (e.g. LiteLLM, vLLM with `--api-key-provider fake`), set the workspace env var:

```
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

This populates claude-code's `--model` picker from the gateway's model list at startup, so you can switch models without restarting the workspace.

## Not managed by fleet

Fleet **consumes** endpoints; it does not manage them. The scope out:

- No model downloads or weight management.
- No GPU scheduling or resource allocation.
- No inference container lifecycle (create, restart, stop).

Endpoints are external services that you provision and operate separately. The compose fixture is a dev/test convenience, not a production feature.
