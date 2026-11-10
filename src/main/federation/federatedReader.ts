// Federated reads (remote-workspaces §7): fan out to every bookmarked host,
// gated by the probe loop's cached liveness, bounded per source, validated.
// Nothing is kept after a call settles: remote data is live-only.
import { RemoteError } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';
import type { WorkspaceSummary } from '../db.js';
import type { RemoteSessionsResult, SearchHitItem, SessionCursor, SourcePage, UnavailableReason, UnavailableSource } from '../../preload/federation.js';
import { EMBED_MODEL_ID } from '../vectors.js';
import { MAX_REMOTE_SESSIONS, parseSearchReply, parseSessionsPage, parseSummary, type RemoteSessionItem } from './remoteRows.js';

export const SOURCE_TIMEOUT_MS = 3_000;

export type RemoteListItem = RemoteSessionItem & {
  workspaceName: string;
  workspaceColorHue: number | null;
  workspaceState: 'running' | 'unreachable';
  capture: false;
  origin: string;
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: UnavailableReason };

export interface FederatedReaderDeps {
  sources(): RemoteSourceInfo[];
  rpc(url: string, channel: string, args: unknown[], timeoutMs: number): Promise<unknown>;
  timeoutMs?: number;
}

export interface FederatedReader {
  listSessions(req: { origin?: string; after?: SessionCursor }): Promise<RemoteSessionsResult<RemoteListItem>>;
  /** undefined: the host is unknown or unavailable. */
  summary(remoteId: string, sessionId: string | null): Promise<WorkspaceSummary | null | undefined>;
  call<T>(src: RemoteSourceInfo, channel: string, args: unknown[], parse: (v: unknown) => T): Promise<Outcome<T>>;
  sources(): RemoteSourceInfo[];
  /** Sends only the query vector, to `origins` only (D67). */
  search(o: { vector: Float32Array; limit: number; origins: string[] }): Promise<{
    remote: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[];
    unavailable: UnavailableSource[];
  }>;
}

class SourceTimeout extends Error {}

function reasonOf(err: unknown): UnavailableReason {
  if (err instanceof SourceTimeout) return 'timeout';
  if (err instanceof RemoteError) return err.kind;
  return 'protocol';
}

const byOrigin = <T extends { origin: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));

export function createFederatedReader(d: FederatedReaderDeps): FederatedReader {
  const timeoutMs = d.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const inflight = new Map<string, Promise<unknown>>();

  function bounded(src: RemoteSourceInfo, channel: string, args: unknown[]): Promise<unknown> {
    const key = `${src.url}\u0000${channel}\u0000${JSON.stringify(args)}`;
    let p = inflight.get(key);
    if (!p) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SourceTimeout()), timeoutMs);
        timer.unref?.();
      });
      p = Promise.race([d.rpc(src.url, channel, args, timeoutMs), timeout]).finally(() => {
        clearTimeout(timer);
        inflight.delete(key);
      });
      inflight.set(key, p);
    }
    return p;
  }

  async function call<T>(src: RemoteSourceInfo, channel: string, args: unknown[], parse: (v: unknown) => T): Promise<Outcome<T>> {
    if (src.state !== 'running') return { ok: false, reason: src.state === null ? 'checking' : 'unreachable' };
    try {
      return { ok: true, value: parse(await bounded(src, channel, args)) };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  }

  return {
    call,
    sources: () => d.sources(),
    async search(o) {
      const targets = d.sources().filter((s) => o.origins.includes(s.id));
      const remote: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[] = [];
      const unavailable: UnavailableSource[] = [];
      const vector = Array.from(o.vector);
      await Promise.all(targets.map(async (s) => {
        const r = await call(s, 'history:search', [{ vector, modelId: EMBED_MODEL_ID, limit: o.limit }], (v) => parseSearchReply(v, s.id));
        if (!r.ok) return void unavailable.push({ origin: s.id, name: s.name, reason: r.reason });
        if (r.value.modelId !== EMBED_MODEL_ID) return void unavailable.push({ origin: s.id, name: s.name, reason: 'model' });
        remote.push({ origin: s.id, hits: r.value.hits.map((h) => ({ ...h, workspaceName: s.name })) });
      }));
      return { remote: byOrigin(remote), unavailable: byOrigin(unavailable) };
    },
    async listSessions(req) {
      const all = d.sources();
      const targets = req.origin ? all.filter((s) => s.id === req.origin) : all;
      const pages: SourcePage<RemoteListItem>[] = [];
      const unavailable: UnavailableSource[] = [];
      await Promise.all(
        targets.map(async (s) => {
          const after = req.origin ? (req.after ?? null) : null;
          const r = await call(s, 'history:sessions', [{ after, limit: MAX_REMOTE_SESSIONS }], (v) => parseSessionsPage(v, s.id));
          if (!r.ok) {
            unavailable.push({ origin: s.id, name: s.name, reason: r.reason });
            return;
          }
          pages.push({
            origin: s.id,
            next: r.value.next,
            rows: r.value.rows.map((row) => ({
              ...row, workspaceName: s.name, workspaceColorHue: s.hue, workspaceState: 'running' as const, capture: false as const, origin: s.id
            }))
          });
        })
      );
      return { pages: byOrigin(pages), unavailable: byOrigin(unavailable) };
    },
    async summary(remoteId, sessionId) {
      const s = d.sources().find((x) => x.id === remoteId);
      if (!s) return undefined;
      const r = await call(s, 'history:summary', [sessionId], parseSummary);
      return r.ok ? r.value : undefined;
    }
  };
}
