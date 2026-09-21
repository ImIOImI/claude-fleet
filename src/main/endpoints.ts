// Model-endpoint registry (#250): app-level list of Anthropic-format
// (/v1/messages) endpoints that workspaces with authMode 'endpoint' point
// claude-code at. Non-secret fields persist to <userData>/endpoints.json;
// the optional API key lives in the vault under scope `endpoint:<id>`.
// Fleet CONSUMES endpoints — it never manages inference (spec non-goal).

import { app } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getSecret, setSecret, deleteAllForWorkspace, deleteSecret } from './vault.js';
import type { Harness } from './workspaces.js';

export interface ModelEndpoint {
  id: string;
  name: string;
  /** Anthropic-format base URL — claude-code appends /v1/messages itself. No trailing slash. */
  baseUrl: string;
  modelId: string;
  /** Backend for claude's haiku-class calls; defaults to modelId. */
  smallFastModelId?: string;
  /** Display metadata only — the SERVER owns the real allocation (spec §A). */
  contextLength?: number;
  /** True iff a key is stored in the vault (the key itself never lives here). */
  hasApiKey: boolean;
  notes?: string;
}

export const ENDPOINT_VAULT_KEY = 'ANTHROPIC_AUTH_TOKEN';
export function endpointVaultScope(id: string): string {
  return `endpoint:${id}`;
}

export function parseEndpoints(raw: unknown): ModelEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelEndpoint[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.name !== 'string' || !o.name) continue;
    if (typeof o.baseUrl !== 'string' || !o.baseUrl) continue;
    if (typeof o.modelId !== 'string' || !o.modelId) continue;
    out.push({
      id: o.id,
      name: o.name,
      baseUrl: o.baseUrl,
      modelId: o.modelId,
      smallFastModelId: typeof o.smallFastModelId === 'string' && o.smallFastModelId ? o.smallFastModelId : undefined,
      contextLength:
        typeof o.contextLength === 'number' && Number.isFinite(o.contextLength) && o.contextLength > 0
          ? Math.round(o.contextLength)
          : undefined,
      hasApiKey: o.hasApiKey === true,
      notes: typeof o.notes === 'string' && o.notes ? o.notes : undefined
    });
  }
  return out;
}

/** Compile an endpoint into the env contract the active harness consumes (spec §B). */
export function compileEndpointEnv(
  ep: ModelEndpoint,
  apiKey: string | null,
  harness: Harness = 'claude-code'
): Record<string, string> {
  if (harness === 'qwen-code') {
    const base = ep.baseUrl.replace(/\/+$/, '') + '/v1';
    return {
      OPENAI_BASE_URL: base,
      OPENAI_API_KEY: apiKey ?? 'sk-none',
      OPENAI_MODEL: ep.modelId
    };
  }
  // existing claude-code / Anthropic dialect — unchanged
  const baseUrl = ep.baseUrl.replace(/\/+$/, '');
  const model = ep.modelId;
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey ?? 'claude-fleet',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: ep.smallFastModelId ?? model,
    CF_SUMMARY_MODEL: model
  };
}

function endpointsPath(): string {
  return join(app.getPath('userData'), 'endpoints.json');
}

let cached: ModelEndpoint[] | null = null;

async function read(): Promise<ModelEndpoint[]> {
  if (cached) return cached;
  try {
    cached = parseEndpoints(JSON.parse(await readFile(endpointsPath(), 'utf8')));
  } catch {
    cached = [];
  }
  return cached;
}

async function write(next: ModelEndpoint[]): Promise<void> {
  cached = next;
  await writeFile(endpointsPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export async function listEndpoints(): Promise<ModelEndpoint[]> {
  return [...(await read())];
}

export async function getEndpoint(id: string): Promise<ModelEndpoint | null> {
  return (await read()).find((e) => e.id === id) ?? null;
}

export async function saveEndpoint(
  input: Omit<ModelEndpoint, 'id' | 'hasApiKey'> & { id?: string }
): Promise<ModelEndpoint> {
  const name = input.name?.trim();
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '');
  const modelId = input.modelId?.trim();
  if (!name) throw new Error('Endpoint name is required');
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
  if (!modelId) throw new Error('Model id is required');
  const all = await read();
  const existing = input.id ? all.find((e) => e.id === input.id) : undefined;
  const ep: ModelEndpoint = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name,
    baseUrl,
    modelId,
    smallFastModelId: input.smallFastModelId?.trim() || undefined,
    contextLength: input.contextLength,
    hasApiKey: existing?.hasApiKey ?? false,
    notes: input.notes?.trim() || undefined
  };
  await write(existing ? all.map((e) => (e.id === ep.id ? ep : e)) : [...all, ep]);
  return ep;
}

export async function deleteEndpoint(id: string): Promise<void> {
  await write((await read()).filter((e) => e.id !== id));
  await deleteAllForWorkspace(endpointVaultScope(id));
}

export async function setEndpointApiKey(id: string, value: string | null): Promise<void> {
  const all = await read();
  const ep = all.find((e) => e.id === id);
  if (!ep) throw new Error(`Unknown endpoint: ${id}`);
  if (value) await setSecret(endpointVaultScope(id), ENDPOINT_VAULT_KEY, value);
  else await deleteSecret(endpointVaultScope(id), ENDPOINT_VAULT_KEY);
  await write(all.map((e) => (e.id === id ? { ...e, hasApiKey: !!value } : e)));
}

/**
 * The compiled backend env for a workspace, `{}` unless it references a
 * known endpoint. Resolved LIVE at container create / local spawn so key
 * rotation and URL edits apply on next start (spec §B).
 */
export async function endpointEnv(
  endpointId: string | undefined,
  harness: Harness = 'claude-code'
): Promise<Record<string, string>> {
  if (!endpointId) return {};
  const ep = await getEndpoint(endpointId);
  if (!ep) {
    console.warn(`[endpoints] workspace references unknown endpoint '${endpointId}' — starting without backend env`);
    return {};
  }
  const key = ep.hasApiKey ? await getSecret(endpointVaultScope(endpointId), ENDPOINT_VAULT_KEY) : null;
  return compileEndpointEnv(ep, key, harness);
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetEndpointsCacheForTests(): void {
  cached = null;
}

/**
 * One cheap POST {baseUrl}/v1/messages with max_tokens:1 (spec §A). Success
 * ⇒ the endpoint speaks the Anthropic Messages API. Deliberately does NOT
 * touch /v1/messages/count_tokens — Ollama 404s it and claude-code copes.
 * 10s timeout: LAN endpoints answer fast; a cold local model may need to
 * load, but the probe is a format check, not a health check.
 */
export async function probeEndpoint(
  baseUrl: string,
  modelId: string,
  apiKey: string | null
): Promise<{ ok: boolean; status?: number; message: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey ?? 'claude-fleet',
        authorization: `Bearer ${apiKey ?? 'claude-fleet'}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10_000)
    });
    if (res.ok) return { ok: true, status: res.status, message: 'Endpoint speaks the Anthropic Messages API.' };
    const body = (await res.text()).slice(0, 300);
    return {
      ok: false,
      status: res.status,
      message:
        `HTTP ${res.status} from ${url} — this endpoint does not appear to speak the Anthropic Messages API. ` +
        `If it is OpenAI-format only, front it with a gateway (e.g. LiteLLM) and register the gateway URL. ` +
        `See docs/local-models.md. Response: ${body}`
    };
  } catch (err) {
    return { ok: false, message: `Endpoint unreachable: ${(err as Error).message}` };
  }
}
