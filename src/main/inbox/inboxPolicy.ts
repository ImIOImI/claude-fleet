// Pure inbox authorization rules (#407): who may post, how often, and which
// todos a workspace may see or change. The caller id is always host-stamped.
import type { InboxConfig, Todo } from '../../preload/inboxTypes.js';

export const DEFAULT_MAX_POSTS_PER_HOUR = 60;
const HOUR = 3_600_000;
const MAX_CAP = 10_000;

export function canPost(cfg?: InboxConfig): boolean {
  return cfg?.canPost !== false;
}

export function postLimit(cfg?: InboxConfig): number {
  return cfg?.maxPostsPerHour ?? DEFAULT_MAX_POSTS_PER_HOUR;
}

/** Sliding one-hour window per workspace. Updates by dedupe count as posts. */
export class PostRateLimiter {
  private hits = new Map<string, number[]>();

  take(workspaceId: string, max: number, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const recent = (this.hits.get(workspaceId) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= max) {
      this.hits.set(workspaceId, recent);
      return { ok: false, retryAfterMs: HOUR - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(workspaceId, recent);
    return { ok: true };
  }
}

export function canUpdate(callerId: string, t: Todo): boolean {
  return (t.source.kind === 'workspace' && t.source.id === callerId) || t.viaWorkspace === callerId;
}

export function canSee(callerId: string, t: Todo, cfg?: InboxConfig): boolean {
  return cfg?.canReadAll === true || canUpdate(callerId, t) || t.workspaceId === callerId;
}

/** Manifest sanitizer — the manifest reader is an allowlist (see workspaces.ts). */
export function sanitizeInboxConfig(v: unknown): InboxConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: InboxConfig = {};
  if (typeof o.canPost === 'boolean') out.canPost = o.canPost;
  if (typeof o.maxPostsPerHour === 'number' && Number.isFinite(o.maxPostsPerHour) && o.maxPostsPerHour >= 1) {
    out.maxPostsPerHour = Math.min(Math.floor(o.maxPostsPerHour), MAX_CAP);
  }
  if (typeof o.canReadAll === 'boolean') out.canReadAll = o.canReadAll;
  if (typeof o.trusted === 'boolean') out.trusted = o.trusted;
  if (typeof o.exposeSkills === 'boolean') out.exposeSkills = o.exposeSkills;
  return Object.keys(out).length ? out : undefined;
}
