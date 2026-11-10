// Startup embedding backfill, kept off the main loop's critical path (#464):
// starts after boot settles, yields between sessions, and runs the stale-model
// purge only when the model id changed since this store's last purge.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { perfSpanAsync } from './perf.js';

export const EMBED_BACKFILL_DELAY_MS = 30_000;

export interface EmbedBackfillDeps {
  /** Holds `<storeId> <modelId>` of the last completed purge. */
  markerPath: string;
  /** Distinguishes stores sharing one userData (SQLite vs each Postgres). */
  storeId: string;
  modelId: string;
  deleteStale: () => Promise<number>;
  /** Sessions that may have turns without an embedding for `modelId`. */
  listPendingSessionIds: () => Promise<string[]>;
  indexTurns: (sessionId: string) => Promise<unknown>;
  indexSummaries: () => Promise<unknown>;
  onError: (step: string, e: unknown) => void;
  yieldFn?: () => Promise<void>;
}

const yieldMacrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Opaque, credential-free id for a store. */
export function storeIdentity(store: { kind: 'sqlite'; path: string } | { kind: 'postgres'; host?: string; port?: number; database?: string; connectionString?: string; schema: string }): string {
  const key = store.kind === 'sqlite'
    ? `sqlite:${store.path}`
    : `postgres:${store.host ?? ''}:${store.port ?? ''}/${store.database ?? ''}#${store.schema}|${store.connectionString ?? ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export async function runEmbedBackfill(d: EmbedBackfillDeps): Promise<void> {
  const yieldFn = d.yieldFn ?? yieldMacrotask;
  const want = `${d.storeId} ${d.modelId}`;
  const marker = await readFile(d.markerPath, 'utf8').then((s) => s.trim(), () => null);
  if (marker !== want) {
    await perfSpanAsync('claude_fleet.index.delete_stale_models', d.deleteStale);
    await mkdir(dirname(d.markerPath), { recursive: true });
    await writeFile(d.markerPath, want);
  }
  const sessionIds = await perfSpanAsync('claude_fleet.index.pending_sessions', d.listPendingSessionIds);
  for (const id of sessionIds) {
    await yieldFn();
    try { await d.indexTurns(id); } catch (e) { d.onError(`turns ${id}`, e); }
  }
  await yieldFn();
  try { await d.indexSummaries(); } catch (e) { d.onError('summaries', e); }
}
