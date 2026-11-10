// sessions:listRemote: the remote half of the Sessions list (remote-workspaces
// (d)). The local half stays sessions:list; the renderer merges the two.
// history:search: local and remote transcript search merged by score (D64, D67).
import type { IpcMain } from 'electron';
import { LOCAL_ORIGIN, type FederatedSearchResult, type SearchHitItem, type SessionCursor } from '../../preload/federation.js';
import type { FederatedReader } from './federatedReader.js';
import { mergeHits } from './searchMerge.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** workspaces.ts REMOTE_ID_RE, kept local so this module stays Electron-free. */
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function parseReq(v: unknown): { origin?: string; after?: SessionCursor } {
  if (v === undefined || v === null) return {};
  const o = v as { origin?: unknown; after?: { lastActiveAt?: unknown; id?: unknown } };
  if (typeof o.origin !== 'string' || !REMOTE_ID_RE.test(o.origin)) throw new Error('origin must be a remote workspace id');
  if (!('after' in o) || o.after === undefined) return { origin: o.origin };
  const a = o.after;
  if (!a || typeof a.lastActiveAt !== 'number' || !Number.isSafeInteger(a.lastActiveAt) || a.lastActiveAt < 0 || typeof a.id !== 'string' || !ID_RE.test(a.id)) {
    throw new Error('after must be a session cursor');
  }
  return { origin: o.origin, after: { lastActiveAt: a.lastActiveAt, id: a.id } };
}

export interface LocalSearch {
  /** null: the local embedder isn't ready. */
  embed(query: string): Promise<Float32Array | null>;
  hits(vector: Float32Array, scope: string, limit: number): Promise<Omit<SearchHitItem, 'origin'>[]>;
  localIds(): Promise<Set<string>>;
}

export function registerFederationIpc(ipc: Pick<IpcMain, 'handle'>, reader: FederatedReader, search: LocalSearch): void {
  ipc.handle('sessions:listRemote', async (_e, req: unknown) => reader.listSessions(parseReq(req)));
  ipc.handle('history:search', async (_e, query: unknown, opts: unknown): Promise<FederatedSearchResult> => {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('query must be 1-2000 characters');
    const o = (opts ?? {}) as { scope?: unknown; limit?: unknown };
    const scope = o.scope === 'all' ? 'all' : typeof o.scope === 'string' && ID_RE.test(o.scope) ? o.scope : null;
    if (!scope) throw new Error("scope must be 'all' or a workspace id");
    const limit = typeof o.limit === 'number' && Number.isSafeInteger(o.limit) ? Math.min(Math.max(o.limit, 1), 50) : 20;
    const vector = await search.embed(query.trim());
    if (!vector) throw new Error('transcript search index is unavailable');
    const local = await search.localIds();
    const origins = reader.sources().filter((s) => scope === 'all' || s.id === scope).map((s) => s.id);
    const [mine, fed] = await Promise.all([
      scope === 'all' || local.has(scope) ? search.hits(vector, scope, limit) : Promise.resolve([]),
      reader.search({ vector, limit, origins })
    ]);
    return { hits: mergeHits([{ origin: LOCAL_ORIGIN, hits: mine }, ...fed.remote], limit), unavailable: fed.unavailable };
  });
}
