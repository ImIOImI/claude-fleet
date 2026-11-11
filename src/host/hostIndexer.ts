// Embeds the hosted workspace's turns: a backfill at holder start, then one
// pass per ingested session, serially. Inserts are fenced store writes.
import { deleteEmbeddingsForOtherModels, sessionsWithPendingTurns } from '../main/db.js';
import { indexSessionTurnsWith } from '../main/transcriptIndexCore.js';
import { EMBED_MODEL_ID, type EmbedFn } from '../main/vectors.js';
import type { Logger } from './log.js';

export interface HostIndexer { backfill(): Promise<void>; bump(sessionId: string): void; stop(graceMs?: number): Promise<void> }

export const INDEXER_STOP_GRACE_MS = 2_000;

const noSpan = <T>(_n: string, fn: () => Promise<T>): Promise<T> => fn();

export function startHostIndexer(o: {
  embed: EmbedFn;
  log: Logger;
  /** True once the embedder can't serve; queued work is dropped. */
  paused?: () => boolean;
  /** Tests: replaces the turn-indexing pass. */
  index?: (id: string) => Promise<number>;
}): HostIndexer {
  const index = o.index ?? ((id: string) => indexSessionTurnsWith(noSpan, id, o.embed));
  const paused = o.paused ?? (() => false);
  const queued = new Set<string>();
  let running: Promise<void> | null = null;
  let stopped = false;
  const drain = async (): Promise<void> => {
    while (!stopped && !paused() && queued.size) {
      const [id] = queued;
      queued.delete(id);
      try {
        await index(id);
      } catch (err) {
        o.log.log('warn', 'transcript index failed', { sessionId: id, error: (err as Error).message });
      }
    }
    if (paused()) queued.clear();
    running = null;
  };
  const bump = (id: string): void => {
    if (stopped || paused()) return;
    queued.add(id);
    running ??= drain();
  };
  return {
    bump,
    async backfill() {
      await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID);
      for (const id of await sessionsWithPendingTurns(EMBED_MODEL_ID)) bump(id);
    },
    async stop(graceMs = INDEXER_STOP_GRACE_MS) {
      stopped = true;
      queued.clear();
      const inflight = running;
      if (inflight) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([inflight, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
        clearTimeout(timer);
      }
    }
  };
}
