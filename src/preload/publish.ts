// Shared by main and renderer (the only dir both tsconfigs compile).

/** `since[id]`: epoch ms when target `id` was turned on. Main sets it; the renderer can't. */
export interface WorkspacePublish {
  to: string[];
  since: Record<string, number>;
}

export const PUBLISH_TARGETS_MAX = 16;
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && REMOTE_ID_RE.test(x)))].slice(0, PUBLISH_TARGETS_MAX) : [];

/** Read side: drops malformed targets and any target without a valid `since`. */
export function sanitizePublish(v: unknown): WorkspacePublish | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { to?: unknown; since?: unknown };
  const since = o.since && typeof o.since === 'object' ? (o.since as Record<string, unknown>) : {};
  const to = ids(o.to).filter((id) => Object.hasOwn(since, id) && Number.isSafeInteger(since[id]) && (since[id] as number) > 0);
  return to.length ? { to, since: Object.fromEntries(to.map((id) => [id, since[id] as number])) } : undefined;
}

/** Write side: `to` from the form, limited to bookmarked remote workspaces; a target already on keeps its `since`. */
export function publishForWrite(incoming: unknown, existing: WorkspacePublish | undefined, remoteIds: ReadonlySet<string>, now: number): WorkspacePublish | undefined {
  const raw = incoming && typeof incoming === 'object' ? (incoming as { to?: unknown }).to : undefined;
  const to = ids(raw).filter((id) => remoteIds.has(id));
  if (!to.length) return undefined;
  return { to, since: Object.fromEntries(to.map((id) => [id, existing?.to.includes(id) ? existing.since[id] : now])) };
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
