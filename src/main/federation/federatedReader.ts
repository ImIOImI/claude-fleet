// Federated reads (remote-workspaces §7): fan out to every bookmarked host,
// gated by the probe loop's cached liveness, bounded per source, validated.
// Nothing is kept after a call settles: remote data is live-only.
import { RemoteError } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';
import type { WorkspaceSummary } from '../db.js';
import type { RemoteSessionsResult, SearchHitItem, SessionCursor, SourcePage, UnavailableReason, UnavailableSource } from '../../preload/federation.js';
import { EMBED_MODEL_ID } from '../vectors.js';
import { MAX_REMOTE_SESSIONS, parseOwnerCosts, parseSearchReply, parseSessionsPage, parseSummary, type RemoteSessionItem } from './remoteRows.js';
import type { OwnerCostRow } from '../../preload/sessionOwner.js';
import type { RemoteActionResult } from '../../preload/remoteAutomations.js';
import { actionError } from './actionError.js';
import { parseActionReply } from './remoteAutomationRows.js';

export const SOURCE_TIMEOUT_MS = 3_000;
export const ACTION_TIMEOUT_MS = 15_000;

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
  /** undefined: the host is unknown or unavailable. */
  ownerCosts(remoteId: string): Promise<OwnerCostRow[] | undefined>;
  call<T>(src: RemoteSourceInfo, channel: string, args: unknown[], parse: (v: unknown) => T): Promise<Outcome<T>>;
  sources(): RemoteSourceInfo[];
  /** Sends only the query vector, to `origins` only (D67). */
  search(o: { vector: Float32Array; limit: number; origins: string[] }): Promise<{
    remote: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[];
    unavailable: UnavailableSource[];
  }>;
  /** One read per running source, in parallel, each bounded; failures listed under `unavailable`. */
  each<T>(channel: string, args: unknown[], parse: (v: unknown, src: RemoteSourceInfo) => T): Promise<{ values: Array<{ src: RemoteSourceInfo; value: T }>; unavailable: UnavailableSource[] }>;
  /** undefined: no such bookmark. */
  one<T>(origin: string, channel: string, args: unknown[], parse: (v: unknown, src: RemoteSourceInfo) => T): Promise<Outcome<T> | undefined>;
  /** An action RPC to the host that owns the row (never federated, never shared with another call). */
  act(origin: string, channel: string, payload: Record<string, unknown>): Promise<RemoteActionResult<unknown>>;
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
    async each<T>(channel: string, args: unknown[], parse: (v: unknown, src: RemoteSourceInfo) => T) {
      const values: Array<{ src: RemoteSourceInfo; value: T }> = [];
      const unavailable: UnavailableSource[] = [];
      await Promise.all(d.sources().map(async (s) => {
        const r = await call(s, channel, args, (v) => parse(v, s));
        if (r.ok) values.push({ src: s, value: r.value });
        else unavailable.push({ origin: s.id, name: s.name, reason: r.reason });
      }));
      values.sort((a, b) => (a.src.id < b.src.id ? -1 : a.src.id > b.src.id ? 1 : 0));
      return { values, unavailable: byOrigin(unavailable) };
    },
    async one(origin, channel, args, parse) {
      const s = d.sources().find((x) => x.id === origin);
      return s ? call(s, channel, args, (v) => parse(v, s)) : undefined;
    },
    async act(origin, channel, payload) {
      const s = d.sources().find((x) => x.id === origin);
      if (!s) return { ok: false, kind: 'unavailable', message: 'that remote workspace is no longer bookmarked' };
      if (s.state !== 'running') return { ok: false, kind: 'unavailable', message: `${s.name} is unreachable; try again when it's back` };
      try {
        const r = parseActionReply(await d.rpc(s.url, channel, [payload], ACTION_TIMEOUT_MS));
        return r.error !== null ? { ok: false, kind: 'failed', message: r.error } : { ok: true, replayed: r.replayed, result: r.result };
      } catch (err) {
        return { ok: false, ...actionError(err) };
      }
    },
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
    },
    async ownerCosts(remoteId) {
      const s = d.sources().find((x) => x.id === remoteId);
      if (!s) return undefined;
      const r = await call(s, 'history:owners', [], parseOwnerCosts);
      return r.ok ? r.value : undefined;
    }
  };
}
