// The renderer-facing vault:* IPC surface: root/override/tag CRUD over the
// app vault (#444), plus the Fleet key registry merged into `vault:list`.
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

export interface IpcHandleLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches IpcMain.handle's listener
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void;
}

function assertKey(key: unknown): asserts key is string {
  if (!isValidKey(key)) throw new Error('invalid vault key');
}

/** `ws` may be null only where the caller explicitly allows it (reveal, and the
 *  pre-manifest paths below) — every other scope-taking channel requires a string. */
function assertWorkspaceIdOrNull(ws: unknown): asserts ws is string | null {
  if (ws !== null) assertRendererWorkspaceId(ws);
}

/** Refuse a remote workspace outright; `allowUnknown` lets `applyWorkspaceEdits`
 *  and `copyWorkspace`'s `to` run before `workspace:create` has written a manifest. */
async function assertWritableKind(ws: string, kind: VaultWorkspaceKind, allowUnknown: boolean): Promise<void> {
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

async function toVaultEntry(deps: VaultIpcDeps, e: ModelEntry): Promise<VaultEntry> {
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
    const out = await Promise.all(entries.map((e) => toVaultEntry(deps, e)));
    for (const fk of FLEET_KEYS) {
      if (!out.some((e) => e.key === fk.key)) {
        out.push({ key: fk.key, secret: fk.secret, tags: [], fleet: true, root: { set: false }, lines: [] });
      }
    }
    return out;
  });

  ipc.handle('vault:reveal', (_e, key: unknown, ws: unknown) => {
    assertKey(key);
    assertWorkspaceIdOrNull(ws);
    return deps.revealValue(key, ws);
  });

  ipc.handle('vault:putKey', (_e, arg: unknown) => {
    const a = (arg ?? {}) as { key?: unknown; secret?: unknown; tags?: unknown; rootValue?: unknown };
    assertKey(a.key);
    if (typeof a.secret !== 'boolean') throw new Error('vault secret flag must be a boolean');
    if (a.rootValue !== undefined && a.rootValue !== null && typeof a.rootValue !== 'string') {
      throw new Error('vault root value must be a string or null');
    }
    return deps.putKey({ key: a.key, secret: a.secret, tags: a.tags as string[], rootValue: a.rootValue as string | null | undefined });
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
    await assertWritableKind(ws, await deps.workspaceKind(ws), false);
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
    await assertWritableKind(to, await deps.workspaceKind(to), true);
    return deps.copyWorkspace(from, to);
  });

  ipc.handle('vault:applyWorkspaceEdits', async (_e, ws: unknown, edits: unknown) => {
    assertRendererWorkspaceId(ws);
    if (!Array.isArray(edits)) throw new Error('vault edits must be an array');
    await assertWritableKind(ws, await deps.workspaceKind(ws), true);
    return deps.applyWorkspaceEdits(ws, edits as VaultWorkspaceEdit[]);
  });

  ipc.handle('vault:deleteAllForWorkspace', (_e, ws: unknown) => {
    assertRendererWorkspaceId(ws);
    return deps.deleteAllForWorkspace(ws);
  });
}
