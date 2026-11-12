// The search.scan span around a worker scan with its inline fallback, shared by
// the MCP read source and db.searchEmbeddings.
import type Database from 'better-sqlite3';
import { scanTopK, SearchWorkerClient, SearchWorkerUnavailable, type ScanHit, type ScanJob } from './searchWorker.js';
import { perfSpanAsyncAttrs } from './perf.js';
import { setSqliteSearchScannerFactory } from './db.js';
import { EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';

/** Inline only when the worker can't run. `conn` is read at fallback time. */
export async function scanViaWorker(
  w: SearchWorkerClient | null, conn: () => Database.Database | null, q: Float32Array, job: ScanJob,
): Promise<ScanHit[]> {
  return perfSpanAsyncAttrs('claude_fleet.search.scan', async (set) => {
    if (w?.usable()) {
      try {
        const r = await w.search(q, job);
        set({ mode: 'worker', worker_ms: Math.round(r.ms), rows: r.scanned });
        return r.hits;
      } catch (e) {
        if (!(e instanceof SearchWorkerUnavailable)) throw e;
        if (!e.inline) throw new Error(`transcript search unavailable: ${e.message}`);
      }
    }
    const d = conn();
    if (!d?.open) throw new Error('transcript search unavailable: store closed');
    const r = scanTopK(d, q, job);
    set({ mode: 'inline', main_ms: Math.round(r.ms), rows: r.scanned });
    return r.hits;
  });
}

/** db.searchEmbeddings (history:search's local half) scans through a worker on SQLite. */
export function installSqliteSearchWorker(log?: (message: string) => void): void {
  setSqliteSearchScannerFactory((dbPath) => {
    const w = new SearchWorkerClient(dbPath, { log });
    return {
      scan: (conn, q, scope, o) => scanViaWorker(w, conn, q, { allowed: scope, modelId: EMBED_MODEL_ID, kind: o.kind, limit: o.limit, dim: EMBED_DIM }),
      close: () => w.close(),
    };
  });
}
