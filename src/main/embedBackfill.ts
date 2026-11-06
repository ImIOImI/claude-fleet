// Startup embedding backfill, kept off the main loop's critical path (#464):
// starts after boot settles, yields between sessions, and runs the stale-model
// purge only when the model id changed since the last successful purge.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { perfSpanAsync } from './perf.js';

export const EMBED_BACKFILL_DELAY_MS = 30_000;

export interface EmbedBackfillDeps {
  /** Holds the model id the last completed purge kept. */
  markerPath: string;
  modelId: string;
  deleteStale: () => Promise<number>;
  listSessionIds: () => Promise<string[]>;
  indexTurns: (sessionId: string) => Promise<unknown>;
  indexSummaries: () => Promise<unknown>;
  yieldFn?: () => Promise<void>;
}

const yieldMacrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

export async function runEmbedBackfill(d: EmbedBackfillDeps): Promise<void> {
  const yieldFn = d.yieldFn ?? yieldMacrotask;
  const marker = await readFile(d.markerPath, 'utf8').then((s) => s.trim(), () => null);
  if (marker !== d.modelId) {
    await perfSpanAsync('claude_fleet.index.delete_stale_models', d.deleteStale);
    await mkdir(dirname(d.markerPath), { recursive: true });
    await writeFile(d.markerPath, d.modelId);
  }
  const sessionIds = await perfSpanAsync('claude_fleet.index.list_sessions', d.listSessionIds);
  for (const id of sessionIds) {
    await yieldFn();
    await d.indexTurns(id);
  }
  await yieldFn();
  await d.indexSummaries();
}
