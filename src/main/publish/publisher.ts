// Pushes opted-in workspaces' newly ingested events to their remote targets (remote-workspaces §7).
// The one cross-boundary write: only acks come back, nothing lands in the local DB (D62).
import { RemoteError } from '../remoteClient.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { planBatches, type PublishRow } from './batches.js';
import type { PublishAck, PublishBatch } from './protocol.js';
import { makeScrubber, type ScrubbedLine, type ScrubValue } from './scrub.js';

export const PUBLISH_DEBOUNCE_MS = 2_000;
export const PUBLISH_SWEEP_MS = 60_000;
export const PUBLISH_PAGE = 500;
export const PUBLISH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const PUBLISH_SIGNED_OUT_MS = 300_000;
/** The host will refuse this batch every time: skip it rather than block the cursor. */
const SKIP_STATUSES = new Set([400, 409, 413]);

export type PublisherManifest = Pick<WorkspaceSpec, 'id' | 'kind' | 'env' | 'remote'> & {
  publish?: { to: string[]; since: Record<string, number> };
};

export interface PublisherLog {
  level: 'info' | 'warn';
  type: string;
  message: string;
  workspaceId?: string;
}

export interface PublisherDeps {
  manifests(): Promise<PublisherManifest[]>;
  publish(url: string, batch: PublishBatch<ScrubbedLine>): Promise<PublishAck>;
  secretValues(spec: PublisherManifest): Promise<ScrubValue[]>;
  events(workspaceId: string, afterId: number, startedSince: number, limit: number): Promise<PublishRow[]>;
  getCursor(source: string, target: string): Promise<number>;
  setCursor(source: string, target: string, lastEventId: number): Promise<void>;
  withheld(workspaceId: string): Promise<Set<string>>;
  log(e: PublisherLog): void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface Publisher {
  /** A workspace ingested events: publish after a short quiet period. */
  bump(workspaceId: string): void;
  /** Every opted-in (workspace, target) pair now; also runs on a timer. */
  sweep(): Promise<void>;
  stop(): void;
}

interface Pair { spec: PublisherManifest; target: string; url: string; since: number }
interface PairState { running: Promise<void> | null; again: boolean; retryAt: number; attempt: number; failing: string | null }

export function startPublisher(d: PublisherDeps, o: { debounceMs?: number; sweepMs?: number; page?: number } = {}): Publisher {
  const now = d.now ?? Date.now;
  const schedule = d.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  const page = o.page ?? PUBLISH_PAGE;
  const states = new Map<string, PairState>();
  const pending = new Map<string, () => void>();
  let stopped = false;

  async function pairs(only?: string): Promise<Pair[]> {
    const all = await d.manifests();
    const urls = new Map(all.flatMap((m) => (m.kind === 'remote' && m.remote ? [[m.id, m.remote.url] as const] : [])));
    const out: Pair[] = [];
    for (const spec of all) {
      if (spec.kind === 'remote' || !spec.publish || (only !== undefined && spec.id !== only)) continue;
      for (const target of spec.publish.to) {
        const url = urls.get(target);
        const since = spec.publish.since[target];
        if (url && Number.isSafeInteger(since)) out.push({ spec, target, url, since });
      }
    }
    return out;
  }

  function fail(st: PairState, ws: string, type: string, message: string, waitMs: number): void {
    st.retryAt = now() + waitMs;
    if (st.failing !== type) d.log({ level: 'warn', type, message, workspaceId: ws });
    st.failing = type;
  }

  async function pass(p: Pair, st: PairState): Promise<void> {
    const ws = p.spec.id;
    let scrub: (line: string) => ScrubbedLine;
    try {
      scrub = makeScrubber(await d.secretValues(p.spec));
    } catch (err) {
      return fail(st, ws, 'publish-scrub-unavailable', `not publishing: this workspace's secrets can't be read to scrub transcripts (${(err as Error).message})`, PUBLISH_SIGNED_OUT_MS);
    }
    const skipped = (r: PublishRow, why: string): void =>
      d.log({ level: 'warn', type: 'publish-line-skipped', message: `event ${r.id} not published: ${why}`, workspaceId: ws });
    for (;;) {
      if (stopped) return;
      const rows = await d.events(ws, await d.getCursor(ws, p.target), p.since, page);
      if (rows.length === 0) break;
      const plan = planBatches(ws, rows, {
        scrub,
        withheld: await d.withheld(ws),
        onOversize: (r) => skipped(r, 'over the 1 MiB publish limit'),
        onUnpublishable: skipped
      });
      for (const b of plan) {
        if (stopped) return;
        if (b.batch) {
          try {
            await d.publish(p.url, b.batch);
          } catch (err) {
            const e = err instanceof RemoteError ? err : null;
            if (e?.status === undefined || !SKIP_STATUSES.has(e.status)) {
              const signedOut = e?.kind === 'not-signed-in' || e?.kind === 'unauthorized' || e?.kind === 'forbidden';
              const backoff = PUBLISH_BACKOFF_MS[Math.min(st.attempt++, PUBLISH_BACKOFF_MS.length - 1)];
              return fail(st, ws, 'publish-failed', (err as Error).message, signedOut ? PUBLISH_SIGNED_OUT_MS : Math.max(backoff, e?.retryAfterMs ?? 0));
            }
            d.log({ level: 'warn', type: 'publish-batch-refused', message: `the host refused a batch (${e.status}); skipped: ${e.message}`, workspaceId: ws });
          }
        }
        await d.setCursor(ws, p.target, b.lastId);
      }
      if (rows.length < page) break;
    }
    if (st.failing) d.log({ level: 'info', type: 'publish-recovered', message: 'publishing resumed', workspaceId: ws });
    st.failing = null;
    st.attempt = 0;
  }

  function run(p: Pair): Promise<void> {
    const key = `${p.spec.id}>${p.target}`;
    let st = states.get(key);
    if (!st) states.set(key, (st = { running: null, again: false, retryAt: 0, attempt: 0, failing: null }));
    if (st.running) {
      // Rows ingested after the running pass read its last page would otherwise wait for the sweep.
      st.again = true;
      return st.running;
    }
    if (stopped || now() < st.retryAt) return Promise.resolve();
    const s = st;
    s.running = pass(p, s)
      .catch((err: Error) => fail(s, p.spec.id, 'publish-failed', err.message, PUBLISH_BACKOFF_MS[0]))
      .finally(() => {
        s.running = null;
        if (s.again) {
          s.again = false;
          void run(p);
        }
      });
    return s.running;
  }

  async function sweep(): Promise<void> {
    for (const p of await pairs()) await run(p);
  }

  const sweepMs = o.sweepMs ?? PUBLISH_SWEEP_MS;
  let cancelSweep = schedule(function tick() {
    void sweep()
      .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message }))
      .finally(() => {
        if (!stopped) cancelSweep = schedule(tick, sweepMs);
      });
  }, sweepMs);

  return {
    bump(ws) {
      if (stopped || pending.has(ws)) return;
      pending.set(ws, schedule(() => {
        pending.delete(ws);
        void pairs(ws)
          .then((ps) => Promise.all(ps.map(run)))
          .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message, workspaceId: ws }));
      }, o.debounceMs ?? PUBLISH_DEBOUNCE_MS));
    },
    sweep,
    stop() {
      stopped = true;
      cancelSweep();
      for (const cancel of pending.values()) cancel();
      pending.clear();
    }
  };
}
