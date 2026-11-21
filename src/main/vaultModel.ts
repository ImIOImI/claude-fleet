// Pure model of the decrypted secrets.enc object. Electron-free so it unit-tests
// in isolation; vault.ts owns the envelope and lock.
import { createHash } from 'node:crypto';
import { APP_ENV_SCOPE, APP_INDEX_SCOPE, assertNotReservedVaultScope } from './vaultScopes.js';

export type Store = Record<string, Record<string, string>>;
export interface KeyMeta { secret: boolean; inherit: string[]; tags: string[] }
export type LineMode = 'inherit' | 'override';
export interface ModelLine { workspaceId: string; mode: LineMode }
export interface ModelEntry { key: string; meta: KeyMeta; rootSet: boolean; lines: ModelLine[] }
export type WorkspaceEdit =
  | { key: string; op: 'inherit' }
  | { key: string; op: 'override'; value: string }
  | { key: string; op: 'remove' }
  | { key: string; op: 'create'; secret: boolean; tags: string[]; value: string; asRoot: boolean };

export const MIGRATED_MARKER = '__migrated__';
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG_RE = /^[a-z0-9-]{1,32}$/;
const MAX_TAGS = 16;

export function isValidKey(k: unknown): k is string {
  return typeof k === 'string' && KEY_RE.test(k) && k !== MIGRATED_MARKER;
}
export function isValidTag(t: unknown): t is string {
  return typeof t === 'string' && TAG_RE.test(t);
}

function assertKey(k: unknown): asserts k is string {
  if (!isValidKey(k)) throw new Error(`invalid key: ${String(k)}`);
}
function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new Error('tags must be an array');
  const out = [...new Set(tags)];
  if (out.length > MAX_TAGS || !out.every(isValidTag)) throw new Error('invalid tag list');
  return out as string[];
}
function assertWorkspace(ws: string): void {
  assertNotReservedVaultScope(ws);
  if (!ws || ws.includes(':')) throw new Error('refusing to resolve a reserved vault scope');
}

function parseMeta(raw: string | undefined): KeyMeta | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as Partial<KeyMeta>;
    return {
      secret: v.secret !== false,
      inherit: Array.isArray(v.inherit) ? v.inherit.filter((x): x is string => typeof x === 'string') : [],
      tags: Array.isArray(v.tags) ? v.tags.filter(isValidTag) : []
    };
  } catch {
    return { secret: true, inherit: [], tags: [] };
  }
}

export function getMeta(s: Store, key: string): KeyMeta | null {
  return parseMeta(s[APP_INDEX_SCOPE]?.[key]);
}

/** Returns a new store with one scope replaced; an empty scope is dropped. */
function withScope(s: Store, scope: string, bag: Record<string, string>): Store {
  const next = { ...s };
  if (Object.keys(bag).length === 0) delete next[scope];
  else next[scope] = bag;
  return next;
}
function setMeta(s: Store, key: string, meta: KeyMeta | null): Store {
  const idx = { ...(s[APP_INDEX_SCOPE] ?? {}) };
  if (meta) idx[key] = JSON.stringify(meta);
  else delete idx[key];
  return withScope(s, APP_INDEX_SCOPE, idx);
}
function setBagValue(s: Store, scope: string, key: string, value: string | null): Store {
  const bag = { ...(s[scope] ?? {}) };
  if (value === null) delete bag[key];
  else bag[key] = value;
  return withScope(s, scope, bag);
}

/** Workspace bags: every scope that is not reserved. */
function workspaceScopes(s: Store): string[] {
  return Object.keys(s).filter((k) => !k.includes(':'));
}

function allKeys(s: Store): string[] {
  const keys = new Set(Object.keys(s[APP_INDEX_SCOPE] ?? {}));
  for (const k of Object.keys(s[APP_ENV_SCOPE] ?? {})) keys.add(k);
  for (const ws of workspaceScopes(s)) for (const k of Object.keys(s[ws] ?? {})) keys.add(k);
  keys.delete(MIGRATED_MARKER);
  return [...keys].sort();
}

function metaOrDefault(s: Store, key: string): KeyMeta {
  return getMeta(s, key) ?? { secret: true, inherit: [], tags: [] };
}

export function lineMode(s: Store, key: string, ws: string): LineMode | null {
  if (s[ws] && key in s[ws]) return 'override';
  return getMeta(s, key)?.inherit.includes(ws) ? 'inherit' : null;
}

export function listEntries(s: Store): ModelEntry[] {
  return allKeys(s).map((key) => {
    const meta = metaOrDefault(s, key);
    const overrides = workspaceScopes(s).filter((ws) => key in (s[ws] ?? {}));
    const inherits = meta.inherit.filter((ws) => !overrides.includes(ws));
    const lines: ModelLine[] = [
      ...inherits.map((workspaceId) => ({ workspaceId, mode: 'inherit' as const })),
      ...overrides.map((workspaceId) => ({ workspaceId, mode: 'override' as const }))
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    return { key, meta, rootSet: key in (s[APP_ENV_SCOPE] ?? {}), lines };
  });
}

export function resolveWorkspaceEnv(s: Store, ws: string): Record<string, string> {
  assertWorkspace(ws);
  const out: Record<string, string> = {};
  const root = s[APP_ENV_SCOPE] ?? {};
  for (const key of Object.keys(s[APP_INDEX_SCOPE] ?? {})) {
    if (key === MIGRATED_MARKER) continue;
    if (getMeta(s, key)?.inherit.includes(ws)) out[key] = root[key] ?? '';
  }
  return { ...out, ...(s[ws] ?? {}) };
}

export function workspaceKeys(s: Store, ws: string): { key: string; secret: boolean }[] {
  return Object.keys(resolveWorkspaceEnv(s, ws)).sort().map((key) => ({ key, secret: metaOrDefault(s, key).secret }));
}

export function workspaceSecretValues(s: Store, ws: string): { key: string; value: string }[] {
  const env = resolveWorkspaceEnv(s, ws);
  return workspaceKeys(s, ws).filter((k) => k.secret && env[k.key]).map((k) => ({ key: k.key, value: env[k.key] }));
}

export function putKey(s: Store, a: { key: string; secret: boolean; tags: string[]; rootValue?: string | null }): Store {
  assertKey(a.key);
  const tags = cleanTags(a.tags);
  const prev = getMeta(s, a.key);
  let next = s;
  let inherit = prev?.inherit ?? [];
  if (a.rootValue === null) {
    next = setBagValue(next, APP_ENV_SCOPE, a.key, null);
    inherit = [];
  } else if (typeof a.rootValue === 'string') {
    next = setBagValue(next, APP_ENV_SCOPE, a.key, a.rootValue);
  }
  return setMeta(next, a.key, { secret: a.secret === true, inherit, tags });
}

export function renameKey(s: Store, key: string, nextKey: string): Store {
  assertKey(key);
  assertKey(nextKey);
  if (key === nextKey) return s;
  if (allKeys(s).includes(nextKey)) throw new Error(`key exists: ${nextKey}`);
  let next = s;
  for (const scope of [APP_ENV_SCOPE, APP_INDEX_SCOPE, ...workspaceScopes(s)]) {
    const bag = s[scope];
    if (!bag || !(key in bag)) continue;
    const v = bag[key];
    next = setBagValue(setBagValue(next, scope, key, null), scope, nextKey, v);
  }
  return next;
}

export function deleteKey(s: Store, key: string): Store {
  assertKey(key);
  let next = s;
  for (const scope of [APP_ENV_SCOPE, APP_INDEX_SCOPE, ...workspaceScopes(s)]) {
    if (s[scope] && key in s[scope]) next = setBagValue(next, scope, key, null);
  }
  return next;
}

export function setLine(
  s: Store, key: string, ws: string, line: { mode: 'inherit' } | { mode: 'override'; value: string }
): Store {
  assertKey(key);
  assertWorkspace(ws);
  const meta = getMeta(s, key);
  if (!meta) throw new Error(`unknown key: ${key}`);
  const others = meta.inherit.filter((w) => w !== ws);
  if (line.mode === 'inherit') {
    return setMeta(setBagValue(s, ws, key, null), key, { ...meta, inherit: [...others, ws] });
  }
  if (typeof line.value !== 'string') throw new Error('override value must be a string');
  return setMeta(setBagValue(s, ws, key, line.value), key, { ...meta, inherit: others });
}

export function removeLine(s: Store, key: string, ws: string): Store {
  assertKey(key);
  assertWorkspace(ws);
  const meta = getMeta(s, key);
  let next = setBagValue(s, ws, key, null);
  if (meta) next = setMeta(next, key, { ...meta, inherit: meta.inherit.filter((w) => w !== ws) });
  return next;
}

export function copyWorkspace(s: Store, from: string, to: string): Store {
  assertWorkspace(from);
  assertWorkspace(to);
  let next = s;
  for (const e of listEntries(s)) {
    const mode = lineMode(s, e.key, from);
    if (mode === 'inherit') next = setLine(next, e.key, to, { mode: 'inherit' });
    else if (mode === 'override') next = setLine(next, e.key, to, { mode: 'override', value: s[from][e.key] });
  }
  return next;
}

function dropOrphan(s: Store, key: string): Store {
  const e = listEntries(s).find((x) => x.key === key);
  return e && !e.rootSet && e.lines.length === 0 ? setMeta(s, key, null) : s;
}

export function removeWorkspace(s: Store, ws: string): Store {
  assertWorkspace(ws);
  const touched = new Set(Object.keys(s[ws] ?? {}));
  let next = { ...s };
  delete next[ws];
  for (const e of listEntries(next)) {
    if (!e.meta.inherit.includes(ws)) continue;
    touched.add(e.key);
    next = setMeta(next, e.key, { ...e.meta, inherit: e.meta.inherit.filter((w) => w !== ws) });
  }
  for (const key of touched) next = dropOrphan(next, key);
  return next;
}

export function applyWorkspaceEdits(s: Store, ws: string, edits: WorkspaceEdit[]): Store {
  assertWorkspace(ws);
  let next = s;
  for (const e of edits) {
    if (e.op === 'inherit') next = setLine(next, e.key, ws, { mode: 'inherit' });
    else if (e.op === 'override') next = setLine(next, e.key, ws, { mode: 'override', value: e.value });
    else if (e.op === 'remove') next = dropOrphan(removeLine(next, e.key, ws), e.key);
    else if (e.op === 'create') {
      if (!getMeta(next, e.key)) {
        next = putKey(next, { key: e.key, secret: e.secret, tags: e.tags, rootValue: e.asRoot ? e.value : undefined });
        next = setLine(next, e.key, ws, e.asRoot ? { mode: 'inherit' } : { mode: 'override', value: e.value });
      } else {
        next = setLine(next, e.key, ws, { mode: 'override', value: e.value });
      }
    } else throw new Error('unknown edit');
  }
  return next;
}

export function migrateManifestEnv(
  s: Store, manifests: { id: string; plain: Record<string, string>; secretKeys: string[] }[]
): Store {
  let next = s;
  const secret = new Map<string, boolean>();
  for (const man of manifests) {
    if (!man.id || man.id.includes(':')) continue;
    for (const [k, v] of Object.entries(man.plain)) {
      if (!isValidKey(k) || typeof v !== 'string') continue;
      next = setBagValue(next, man.id, k, v);
      secret.set(k, secret.get(k) ?? false);
    }
    for (const k of man.secretKeys) if (isValidKey(k)) secret.set(k, true);
  }
  for (const [key, isSecret] of secret) {
    const prev = getMeta(next, key);
    next = setMeta(next, key, { secret: isSecret || prev?.secret === true, inherit: prev?.inherit ?? [], tags: prev?.tags ?? [] });
  }
  return setBagValue(next, APP_INDEX_SCOPE, MIGRATED_MARKER, '1');
}

export function envHash(env: Record<string, string>): string {
  const pairs = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}
