// Shared by main and renderer (the only dir both tsconfigs compile).

/**
 * `since[id]`: epoch ms when target `id` was turned on. `from[id]`: a lower session-start floor set by the
 * "Also publish existing sessions" action (D140). Main sets both; the renderer can't.
 */
export interface WorkspacePublish {
  to: string[];
  since: Record<string, number>;
  from?: Record<string, number>;
}

export const PUBLISH_TARGETS_MAX = 16;
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && REMOTE_ID_RE.test(x)))].slice(0, PUBLISH_TARGETS_MAX) : [];

/** Read side: drops malformed targets and any target without a valid `since`. */
export function sanitizePublish(v: unknown): WorkspacePublish | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { to?: unknown; since?: unknown; from?: unknown };
  const since = o.since && typeof o.since === 'object' ? (o.since as Record<string, unknown>) : {};
  const to = ids(o.to).filter((id) => Object.hasOwn(since, id) && Number.isSafeInteger(since[id]) && (since[id] as number) > 0);
  if (!to.length) return undefined;
  const rawFrom = o.from && typeof o.from === 'object' ? (o.from as Record<string, unknown>) : {};
  const from = to.filter((id) => Object.hasOwn(rawFrom, id) && Number.isSafeInteger(rawFrom[id]) && (rawFrom[id] as number) >= 0 && (rawFrom[id] as number) < (since[id] as number));
  return withFrom({ to, since: Object.fromEntries(to.map((id) => [id, since[id] as number])) }, Object.fromEntries(from.map((id) => [id, rawFrom[id] as number])));
}

function withFrom(p: WorkspacePublish, from: Record<string, number>): WorkspacePublish {
  return Object.keys(from).length ? { ...p, from } : p;
}

/** Sessions of `target` that started at or after this are published. */
export function publishFloor(p: WorkspacePublish, target: string): number {
  return p.from?.[target] ?? p.since[target];
}

/**
 * The backfill action: lowers `target`'s floor to `from` (epoch ms, or 'all' = 0). Only widens; a target
 * that isn't on, or a value that isn't a safe integer ≥ 0, is refused.
 */
export function widenPublish(existing: WorkspacePublish | undefined, target: string, from: unknown): WorkspacePublish {
  if (!existing?.to.includes(target)) throw new Error('publishing to this host is not on; turn it on and save first');
  const at = from === 'all' ? 0 : from;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw new Error('choose a start date or all sessions');
  if (at >= publishFloor(existing, target)) throw new Error('only earlier sessions can be added');
  return { ...existing, from: { ...existing.from, [target]: at } };
}

/** Write side: `to` from the form, limited to bookmarked remote workspaces; a target already on keeps its `since`. */
export function publishForWrite(incoming: unknown, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined {
  const raw = incoming && typeof incoming === 'object' ? (incoming as { to?: unknown }).to : undefined;
  const to = ids(raw).filter((id) => remoteIds.has(id));
  if (!to.length) return undefined;
  const kept = to.filter((id) => existing?.to.includes(id) && existing.from?.[id] !== undefined);
  return withFrom(
    { to, since: Object.fromEntries(to.map((id) => [id, existing?.to.includes(id) ? existing.since[id] : now])) },
    Object.fromEntries(kept.map((id) => [id, existing!.from![id]]))
  );
}

/** writeManifest: an absent `publish` key keeps the stored block (the resume and committee writes don't send it). */
export function publishOnWrite(spec: object, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined {
  return 'publish' in spec ? publishForWrite((spec as { publish?: unknown }).publish, existing, remoteIds, now) : existing;
}

export interface UnpublishResult {
  removed: number;
  /** Hosts that couldn't be reached or refused; the session is withheld from publishing regardless. */
  failed: { remoteId: string; name: string; error: string }[];
}

/** `publish:backfillCount`: what the confirm text names. */
export interface BackfillCount {
  sessions: number;
  host: string;
}

export interface BackfillResult {
  sessions: number;
}
