// The renderer-facing vault:* IPC surface: root/override/tag CRUD over the
// app vault, plus the Fleet key registry merged into `vault:list`.
import { assertRendererWorkspaceId } from './vaultScopes.js';
import { isValidKey, type ModelEntry, type WorkspaceEdit } from './vaultModel.js';
import { FLEET_KEYS, FLEET_KEY_NAMES } from '../preload/fleetKeys.js';
import type { VaultEntry, VaultLine, VaultWorkspaceEdit } from '../preload/vaultTypes.js';

export type VaultWorkspaceKind = 'container' | 'local' | 'remote' | null;

export interface VaultIpcDeps {
  isVaultAvailable(): Promise<boolean>;
  listModelEntries(): Promise<ModelEntry[]>;
  getRootValue(key: string): Promise<string | null>;
  revealValue(key: string, ws: string | null): Promise<string | null>;
  putKey(a: { key: string; secret: boolean; tags: string[]; rootValue?: string | null }): Promise<void>;
  renameKey(key: string, next: string): Promise<void>;
  deleteKey(key: string): Promise<void>;
  setLine(key: string, ws: string, line: { mode: 'inherit' } | { mode: 'override'; value: string }): Promise<void>;
  removeLine(key: string, ws: string): Promise<void>;
  copyWorkspace(from: string, to: string): Promise<void>;
  applyWorkspaceEdits(ws: string, edits: WorkspaceEdit[]): Promise<void>;
  deleteAllForWorkspace(ws: string): Promise<void>;
  /** Does the workspace's live env (container/local process) still match the vault's current resolution? */
  pendingFor(ws: string): Promise<boolean>;
  /** Manifest `kind`, or null when no manifest exists yet (mid-`workspace:create`). */
  workspaceKind(ws: string): Promise<VaultWorkspaceKind>;
}

/** Manifest kind, else (mock mode, where seeded workspaces have no manifest)
 *  the mock workspace's kind. */
export async function resolveVaultWorkspaceKind(
  ws: string,
  d: { manifestKind(ws: string): Promise<VaultWorkspaceKind>; mockWorkspaces?: () => Promise<{ id: string; kind?: 'container' | 'local' | 'remote' }[]> }
): Promise<VaultWorkspaceKind> {
  const kind = await d.manifestKind(ws);
  if (kind !== null || !d.mockWorkspaces) return kind;
  return (await d.mockWorkspaces()).find((w) => w.id === ws)?.kind ?? null;
}

const FLEET_KEY_PAT = 'GITHUB_TOKEN';
type PatWrites = Pick<VaultIpcDeps, 'putKey' | 'deleteKey' | 'renameKey'>;

/** Root `GITHUB_TOKEN` writes run through `watch` (`IdentityService.patChanged`), so a PAT added or removed signs in or out. */
export function watchPatWrites<D extends PatWrites>(deps: D, watch: <T>(write: () => Promise<T>) => Promise<T>): D {
  const isPat = (...keys: string[]) => keys.includes(FLEET_KEY_PAT);
  return {
    ...deps,
    putKey: (a) => (isPat(a.key) ? watch(() => deps.putKey(a)) : deps.putKey(a)),
    deleteKey: (key) => (isPat(key) ? watch(() => deps.deleteKey(key)) : deps.deleteKey(key)),
    renameKey: (key, next) => (isPat(key, next) ? watch(() => deps.renameKey(key, next)) : deps.renameKey(key, next))
  };
}

export interface IpcHandleLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches IpcMain.handle's listener
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void;
}

function assertKey(key: unknown): asserts key is string {
  if (!isValidKey(key)) throw new Error('invalid vault key');
}

/** Refuse a remote workspace outright; `allowUnknown` lets `applyWorkspaceEdits`
 *  and `copyWorkspace`'s `to` run before `workspace:create` has written a manifest. */
function assertWritableKind(kind: VaultWorkspaceKind, allowUnknown: boolean): void {
  if (kind === 'remote') throw new Error('cannot write vault lines for a remote workspace');
  if (kind === null && !allowUnknown) throw new Error('unknown workspace');
}

function assertLineShape(line: unknown): asserts line is { mode: 'inherit' } | { mode: 'override'; value: string } {
  if (typeof line !== 'object' || line === null) throw new Error('invalid vault line');
  const mode = (line as { mode?: unknown }).mode;
  if (mode === 'inherit') return;
  if (mode === 'override') {
    if (typeof (line as { value?: unknown }).value !== 'string') throw new Error('override value must be a string');
    return;
  }
  throw new Error('invalid vault line mode');
}

const EDIT_OPS = new Set(['inherit', 'override', 'remove', 'create']);

function assertEdit(e: unknown): asserts e is VaultWorkspaceEdit {
  if (typeof e !== 'object' || e === null) throw new Error('invalid vault edit');
  const obj = e as Record<string, unknown>;
  assertKey(obj.key);
  if (!EDIT_OPS.has(obj.op as string)) throw new Error('invalid vault edit op');
  if ((obj.op === 'override' || obj.op === 'create') && typeof obj.value !== 'string') {
    throw new Error('vault edit value must be a string');
  }
  if (obj.op === 'create' && (typeof obj.secret !== 'boolean' || typeof obj.asRoot !== 'boolean')) {
    throw new Error('vault edit secret/asRoot must be booleans');
  }
}

function assertEdits(edits: unknown): asserts edits is VaultWorkspaceEdit[] {
  if (!Array.isArray(edits)) throw new Error('vault edits must be an array');
  edits.forEach(assertEdit);
}

interface ToEntryDeps {
  revealValue(key: string, ws: string | null): Promise<string | null>;
  getRootValue(key: string): Promise<string | null>;
  pendingFor(ws: string): Promise<boolean>;
}

async function toVaultEntry(deps: ToEntryDeps, e: ModelEntry): Promise<VaultEntry> {
  const lines: VaultLine[] = [];
  for (const line of e.lines) {
    const value = e.meta.secret ? undefined : ((await deps.revealValue(e.key, line.workspaceId)) ?? undefined);
    lines.push({ workspaceId: line.workspaceId, mode: line.mode, value, pending: await deps.pendingFor(line.workspaceId) });
  }
  const rootValue = !e.meta.secret && e.rootSet ? ((await deps.getRootValue(e.key)) ?? undefined) : undefined;
  return {
    key: e.key,
    secret: e.meta.secret,
    tags: e.meta.tags,
    fleet: FLEET_KEY_NAMES.has(e.key),
    root: { set: e.rootSet, value: rootValue },
    lines
  };
}

export function registerVaultIpc(ipc: IpcHandleLike, deps: VaultIpcDeps): void {
  ipc.handle('vault:available', () => deps.isVaultAvailable());

  ipc.handle('vault:list', async () => {
    const entries = await deps.listModelEntries();
    // one pendingFor call per workspace per list, however many keys reference it
    const pendingCache = new Map<string, Promise<boolean>>();
    const pendingFor = (ws: string): Promise<boolean> => {
      let p = pendingCache.get(ws);
      if (!p) {
        p = deps.pendingFor(ws);
        pendingCache.set(ws, p);
      }
      return p;
    };
    const entryDeps: ToEntryDeps = { revealValue: deps.revealValue, getRootValue: deps.getRootValue, pendingFor };
    const out = await Promise.all(entries.map((e) => toVaultEntry(entryDeps, e)));
    for (const fk of FLEET_KEYS) {
      if (!out.some((e) => e.key === fk.key)) {
        out.push({ key: fk.key, secret: fk.secret, tags: [], fleet: true, root: { set: false }, lines: [] });
      }
    }
    return out;
  });

  ipc.handle('vault:reveal', (_e, key: unknown, ws: unknown) => {
    assertKey(key);
    if (ws !== null) assertRendererWorkspaceId(ws);
    return deps.revealValue(key, ws);
  });

  ipc.handle('vault:putKey', (_e, arg: unknown) => {
    const a = (arg ?? {}) as { key?: unknown; secret?: unknown; tags?: unknown; rootValue?: unknown };
    assertKey(a.key);
    if (typeof a.secret !== 'boolean') throw new Error('vault secret flag must be a boolean');
    if (a.rootValue !== undefined && a.rootValue !== null && typeof a.rootValue !== 'string') {
      throw new Error('vault root value must be a string or null');
    }
    const secret = FLEET_KEYS.find((k) => k.key === a.key)?.secret ?? a.secret;
    return deps.putKey({ key: a.key, secret, tags: a.tags as string[], rootValue: a.rootValue as string | null | undefined });
  });

  ipc.handle('vault:renameKey', (_e, key: unknown, next: unknown) => {
    assertKey(key);
    assertKey(next);
    return deps.renameKey(key, next);
  });

  ipc.handle('vault:deleteKey', (_e, key: unknown) => {
    assertKey(key);
    return deps.deleteKey(key);
  });

  ipc.handle('vault:setLine', async (_e, key: unknown, ws: unknown, line: unknown) => {
    assertKey(key);
    assertRendererWorkspaceId(ws);
    assertLineShape(line);
    assertWritableKind(await deps.workspaceKind(ws), false);
    return deps.setLine(key, ws, line);
  });

  ipc.handle('vault:removeLine', (_e, key: unknown, ws: unknown) => {
    assertKey(key);
    assertRendererWorkspaceId(ws);
    return deps.removeLine(key, ws);
  });

  ipc.handle('vault:copyWorkspace', async (_e, from: unknown, to: unknown) => {
    assertRendererWorkspaceId(from);
    assertRendererWorkspaceId(to);
    assertWritableKind(await deps.workspaceKind(to), true);
    return deps.copyWorkspace(from, to);
  });

  ipc.handle('vault:applyWorkspaceEdits', async (_e, ws: unknown, edits: unknown) => {
    assertRendererWorkspaceId(ws);
    assertEdits(edits);
    assertWritableKind(await deps.workspaceKind(ws), true);
    return deps.applyWorkspaceEdits(ws, edits);
  });

  ipc.handle('vault:deleteAllForWorkspace', (_e, ws: unknown) => {
    assertRendererWorkspaceId(ws);
    return deps.deleteAllForWorkspace(ws);
  });
}
