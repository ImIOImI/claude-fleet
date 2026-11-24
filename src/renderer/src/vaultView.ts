// Pure view model for Settings → Vault and the workspace form's vault chips.
import { FLEET_KEYS } from '../../preload/fleetKeys';
import type { VaultEntry } from '../../preload/vaultTypes';

export interface DerivedTag { tag: string; derived: true }

/** Slug a workspace name into a tag: lowercase, non [a-z0-9-] runs collapse to one '-', edges trimmed, clamped to 32 chars. */
export function workspaceTag(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 32).replace(/-+$/, '');
}

export function derivedTags(e: VaultEntry, names: Record<string, string>): string[] {
  const tags: string[] = [];
  if (e.root.set) tags.push('root');
  if (e.fleet) tags.push('fleet');
  tags.push(e.secret ? 'secret' : 'plain');
  for (const line of e.lines) {
    const tag = workspaceTag(names[line.workspaceId] ?? line.workspaceId) || workspaceTag(line.workspaceId);
    if (tag) tags.push(tag);
  }
  return tags;
}

function allEntryTags(e: VaultEntry, names: Record<string, string>): string[] {
  return [...e.tags, ...derivedTags(e, names)];
}

export function allTags(entries: VaultEntry[], names: Record<string, string>): { tag: string; derived: boolean }[] {
  const derived = new Set<string>();
  const seen = new Set<string>();
  for (const e of entries) {
    for (const t of e.tags) seen.add(t);
    for (const t of derivedTags(e, names)) {
      seen.add(t);
      derived.add(t);
    }
  }
  return [...seen].sort().map((tag) => ({ tag, derived: derived.has(tag) }));
}

export function filterEntries(
  entries: VaultEntry[],
  names: Record<string, string>,
  q: { text: string; tags: string[] }
): VaultEntry[] {
  const text = q.text.trim().toLowerCase();
  return entries.filter((e) => {
    const tags = allEntryTags(e, names);
    if (text) {
      const inKey = e.key.toLowerCase().includes(text);
      const inTags = tags.some((t) => t.toLowerCase().includes(text));
      if (!inKey && !inTags) return false;
    }
    return q.tags.every((want) => tags.includes(want));
  });
}

export function groupEntries(entries: VaultEntry[]): { fleet: VaultEntry[]; keys: VaultEntry[] } {
  const order = new Map(FLEET_KEYS.map((k, i) => [k.key, i]));
  const fleet = entries
    .filter((e) => e.fleet)
    .sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  const keys = entries
    .filter((e) => !e.fleet)
    .sort((a, b) => a.key.localeCompare(b.key));
  return { fleet, keys };
}

export function entriesForWorkspace(entries: VaultEntry[], workspaceId: string): VaultEntry[] {
  return entries.filter((e) => e.lines.some((l) => l.workspaceId === workspaceId));
}

export function publishableWorkspaces<T extends { id: string; kind: string }>(e: VaultEntry, workspaces: T[]): T[] {
  const lined = new Set(e.lines.map((l) => l.workspaceId));
  return workspaces.filter((w) => w.kind !== 'remote' && !lined.has(w.id));
}

const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG_RE = /^[a-z0-9-]{1,32}$/;

export function isValidKeyName(k: string): boolean {
  return KEY_NAME_RE.test(k);
}

/** Comma/space separated tag input → normalized tags plus any that fail validation. */
export function parseTagInput(input: string): { tags: string[]; invalid: string[] } {
  const parts = [...new Set(input.split(/[\s,]+/).map((t) => t.toLowerCase()).filter(Boolean))];
  return { tags: parts.filter((t) => TAG_RE.test(t)), invalid: parts.filter((t) => !TAG_RE.test(t)) };
}

/** Datalist options for a multi-tag input: the full input with its last token completed. */
export function tagSuggestions(input: string, tags: string[]): string[] {
  const m = /^(.*[\s,])?([^\s,]*)$/.exec(input);
  const head = m?.[1] ?? '';
  const partial = (m?.[2] ?? '').toLowerCase();
  const used = new Set(parseTagInput(head).tags);
  return tags.filter((t) => !used.has(t) && t.startsWith(partial)).map((t) => head + t);
}

export function inheritCount(e: VaultEntry): number {
  return e.lines.filter((l) => l.mode === 'inherit').length;
}

export function pendingLabel(kind: string | undefined): string | null {
  if (kind === 'container') return 'recreate to apply';
  if (kind === 'local') return 'restart to apply';
  return null;
}
