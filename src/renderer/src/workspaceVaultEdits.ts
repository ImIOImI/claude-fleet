// Staged vault edits for the workspace form; applied via vault:applyWorkspaceEdits on submit.
import type { VaultEntry, VaultLine, VaultWorkspaceEdit } from '../../preload/vaultTypes';

export interface StagedState { edits: VaultWorkspaceEdit[] }

/**
 * Last edit per key wins, except on a staged create: its value absorbs later
 * overrides, and a root-backed create keeps a trailing override (main applies
 * edits in order, so `create` then `override` yields root + override).
 */
export function stage(state: StagedState, edit: VaultWorkspaceEdit): StagedState {
  const others = state.edits.filter((e) => e.key !== edit.key);
  const create = state.edits.find((e) => e.key === edit.key && e.op === 'create');
  if (!create || create.op !== 'create' || edit.op === 'create') return { edits: [...others, edit] };
  if (edit.op === 'remove') return { edits: others };
  if (edit.op === 'override') {
    return { edits: [...others, ...(create.asRoot ? [create, edit] : [{ ...create, value: edit.value }])] };
  }
  return { edits: [...others, create] };
}

export function discard(state: StagedState, key: string): StagedState {
  return { edits: state.edits.filter((e) => e.key !== key) };
}

/** The override value typed for `key` in staged edits, if any. */
function stagedOverride(staged: StagedState, key: string): string | null {
  const mine = staged.edits.filter((e) => e.key === key);
  const override = mine.find((e) => e.op === 'override');
  if (override?.op === 'override') return override.value;
  const create = mine.find((e) => e.op === 'create');
  return create?.op === 'create' ? create.value : null;
}

/** A staged override counts by its typed value; a saved secret override's
 *  value is never sent down, so it counts as set. */
export function resolvesNonEmpty(e: VaultEntry, workspaceId: string, staged?: StagedState): boolean {
  const line = e.lines.find((l) => l.workspaceId === workspaceId);
  if (!line) return false;
  if (line.mode === 'inherit') return e.root.set && (e.secret || e.root.value !== '');
  const typed = staged ? stagedOverride(staged, e.key) : null;
  if (typed !== null) return typed !== '';
  return e.secret || !!line.value;
}

function withLine(e: VaultEntry, line: VaultLine): VaultEntry {
  return { ...e, lines: [...e.lines.filter((l) => l.workspaceId !== line.workspaceId), line] };
}

function overrideLine(e: { secret: boolean }, ws: string, value: string): VaultLine {
  return e.secret ? { workspaceId: ws, mode: 'override', pending: false } : { workspaceId: ws, mode: 'override', value, pending: false };
}

/** The entry list as it will look once `staged` is applied to `workspaceId`. Secret values stay absent. */
export function previewEntries(entries: VaultEntry[], workspaceId: string, staged: StagedState): VaultEntry[] {
  const out = new Map(entries.map((e) => [e.key, e]));
  for (const edit of staged.edits) {
    const e = out.get(edit.key);
    if (edit.op === 'create') {
      if (e) {
        const line: VaultLine =
          edit.asRoot && e.root.set ? { workspaceId, mode: 'inherit', pending: false } : overrideLine(e, workspaceId, edit.value);
        out.set(edit.key, withLine(e, line));
        continue;
      }
      const rootValue = edit.secret ? {} : { value: edit.value };
      out.set(edit.key, {
        key: edit.key,
        secret: edit.secret,
        tags: edit.tags,
        fleet: false,
        root: edit.asRoot ? { set: true, ...rootValue } : { set: false },
        lines: [
          edit.asRoot
            ? { workspaceId, mode: 'inherit', pending: false }
            : overrideLine(edit, workspaceId, edit.value)
        ]
      });
      continue;
    }
    if (!e) continue;
    if (edit.op === 'inherit') out.set(e.key, withLine(e, { workspaceId, mode: 'inherit', pending: false }));
    else if (edit.op === 'override') out.set(e.key, withLine(e, overrideLine(e, workspaceId, edit.value)));
    else out.set(e.key, { ...e, lines: e.lines.filter((l) => l.workspaceId !== workspaceId) });
  }
  return [...out.values()];
}

/** Display-only copy of `from`'s lines onto `to` (a clone before vault:copyWorkspace runs). */
export function rekeyLines(entries: VaultEntry[], from: string, to: string): VaultEntry[] {
  return entries.map((e) => {
    const src = e.lines.find((l) => l.workspaceId === from);
    return src ? withLine(e, { ...src, workspaceId: to, pending: false }) : e;
  });
}
