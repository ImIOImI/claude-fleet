// Pushes opted-in workspaces' newly ingested events to their remote targets (remote-workspaces §7).
// The one cross-boundary write: only acks come back, nothing lands in the local DB (D62).
import { publishFloor, type WorkspacePublish } from '../../preload/publish.js';
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
/** The wait after a 429 without Retry-After. */
export const PUBLISH_BUSY_RETRY_MS = 1_000;
/** The host will refuse this batch every time: skip it rather than block the cursor. */
const SKIP_STATUSES = new Set([400, 409, 413]);

export type PublisherManifest = Pick<WorkspaceSpec, 'id' | 'kind' | 'env' | 'remote' | 'createdAt' | 'endpointId'> & {
  authMode?: WorkspaceSpec['authMode'];
  publish?: WorkspacePublish;
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
  events(workspaceId: string, afterId: number, limit: number): Promise<PublishRow[]>;
  /** The durable floor the first pass after a restart starts from. */
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
  /**
   * Every opted-in (workspace, target) pair now. Only the timer calls it outside tests: it re-arms after each sweep
   * finishes, and the re-scan window in `pass` relies on sweeps being at least `sweepMs` apart.
   */
  sweep(): Promise<void>;
  /**
   * Resolves once the workspace's sends in flight now have finished. A send re-checks withheld first, so after
   * withhold + idle no send of that session is pending or can start. Unpublish: withhold, await this, then DELETE.
   */
  idle(workspaceId: string): Promise<void>;
  /** Resolves once no pass of the workspace is running, re-runs included; may not settle under steady ingest (tests). */
  drain(workspaceId: string): Promise<void>;
  /**
   * Runs `fn` with no pass of the workspace running or starting: waits out running passes (and their cursor
   * write-back) first. The backfill action resets a cursor and lowers a floor inside it.
   */
  exclusive<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
  stop(): void;
}

type Kind = 'bump' | 'sweep';
/** `since` is the opt-in time (the bookmark check); `from` the session-start floor (D140). */
interface Pair { spec: PublisherManifest; target: string; url: string; since: number; from: number }
interface PairState {
  since: number;
  from: number;
  running: Promise<void> | null;
  /** The span from the per-batch withheld/pair re-check through the host's reply; never rejects. */
  sending: Promise<void> | null;
  again: Kind | null;
  retryAt: number;
  attempt: number;
  failing: string | null;
  /** Live position; null until loaded from the durable floor. */
  pos: number | null;
  /** `pos` at the start of the last two completed sweeps, oldest first; a sweep starts from the first. */
  marks: [number, number];
  /** Ids above `marks[0]` already sent or reported, so a sweep's re-scan doesn't repeat them. */
  seen: Set<number>;
}

/** Bounds `seen`; past it a re-scan re-sends, which the host's dedup makes a no-op. */
const SEEN_MAX = 20_000;

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
  const held = new Map<string, number>();
  let stopped = false;
  const halted = (ws: string): boolean => stopped || held.has(ws);

  async function pairs(only?: string): Promise<Pair[]> {
    const all = await d.manifests();
    const targets = new Map(all.flatMap((m) => (m.kind === 'remote' && m.remote ? [[m.id, m] as const] : [])));
    const out: Pair[] = [];
    for (const spec of all) {
      if (spec.kind === 'remote' || !spec.publish || (only !== undefined && spec.id !== only)) continue;
      for (const target of spec.publish.to) {
        const t = targets.get(target);
        const since = spec.publish.since[target];
        // A bookmark added after the opt-in (forgotten and re-added, or another host now claiming the id) never inherits it.
        if (t?.remote && Number.isSafeInteger(since) && t.createdAt <= since) {
          out.push({ spec, target, url: t.remote.url, since, from: publishFloor(spec.publish, target) });
        }
      }
    }
    return out;
  }

  const current = async (p: Pair): Promise<Pair | undefined> =>
    (await pairs(p.spec.id)).find((q) => q.target === p.target && q.since === p.since && q.from === p.from);

  const same = (st: PairState, p: Pair): boolean => st.since === p.since && st.from === p.from;

  function reset(st: PairState, p: Pick<Pair, 'since' | 'from'>): void {
    Object.assign(st, { since: p.since, from: p.from, retryAt: 0, attempt: 0, failing: null, pos: null, marks: [0, 0] });
    st.seen.clear();
  }

  function fail(st: PairState, ws: string, type: string, message: string, waitMs: number): void {
    st.retryAt = now() + waitMs;
    if (st.failing !== type) d.log({ level: 'warn', type, message, workspaceId: ws });
    st.failing = type;
  }

  const backoff = (st: PairState): number => PUBLISH_BACKOFF_MS[Math.min(st.attempt++, PUBLISH_BACKOFF_MS.length - 1)];

  /**
   * Bumps read from the live position. A sweep re-reads from where the live position stood two sweeps ago:
   * on Postgres concurrent ingest transactions can commit ids out of order, so the live position may have
   * passed an id that commits later. Assumes ingest transactions finish within PUBLISH_SWEEP_MS.
   */
  async function pass(p0: Pair, st: PairState, kind: Kind): Promise<void> {
    let p = p0;
    const ws = p.spec.id;
    if (!same(st, p)) reset(st, p);
    let scrub: (line: string) => ScrubbedLine;
    try {
      scrub = makeScrubber(await d.secretValues(p.spec));
    } catch (err) {
      return fail(st, ws, 'publish-scrub-unavailable', `not publishing: this workspace's secrets can't be read to scrub transcripts (${(err as Error).message})`, PUBLISH_SIGNED_OUT_MS);
    }
    if (st.pos === null) {
      const floor = await d.getCursor(ws, p.target);
      st.pos = floor;
      st.marks = [floor, floor];
    }
    const capture = st.pos;
    let after = kind === 'sweep' ? st.marks[0] : st.pos;
    const report = (r: PublishRow, why: string): void => {
      st.seen.add(r.id);
      d.log({ level: 'warn', type: 'publish-line-skipped', message: `event ${r.id} not published: ${why}`, workspaceId: ws });
    };
    for (;;) {
      if (halted(ws)) return;
      const cur = await current(p);
      if (!cur) return reset(st, st);
      p = cur;
      const rows = await d.events(ws, after, page);
      if (rows.length === 0) break;
      const fresh = rows.filter((r) => !st.seen.has(r.id));
      const plan = planBatches(ws, fresh, {
        scrub,
        since: p.from,
        withheld: await d.withheld(ws),
        onOversize: (r) => report(r, 'over the 1 MiB publish limit'),
        onUnpublishable: report
      });
      let i = 0;
      for (const b of plan) {
        if (halted(ws)) return;
        const covered = i;
        while (i < fresh.length && fresh[i].id <= b.lastId) i++;
        if (b.batch) {
          const batch = b.batch;
          const pair = p;
          // One span for idle(): a withhold or opt-out that lands before idle() snapshots it is either seen here or awaited.
          const step = (async (): Promise<'gone' | 'withheld' | 'sent'> => {
            if (!(await current(pair))) return 'gone';
            if ((await d.withheld(ws)).has(batch.sessionId)) return 'withheld';
            await d.publish(pair.url, batch);
            return 'sent';
          })();
          st.sending = step.then(() => undefined, () => undefined);
          let outcome: 'gone' | 'withheld' | 'sent' | 'refused';
          try {
            outcome = await step;
          } catch (err) {
            const e = err instanceof RemoteError ? err : null;
            if (e?.status === undefined || !SKIP_STATUSES.has(e.status)) {
              const signedOut = e?.kind === 'not-signed-in' || e?.kind === 'unauthorized' || e?.kind === 'forbidden';
              // A busy host (shared by many publishers) is not a failing one: honour Retry-After, don't climb the ladder.
              const wait = signedOut ? PUBLISH_SIGNED_OUT_MS
                : e?.status === 429 ? Math.min(e.retryAfterMs ?? PUBLISH_BUSY_RETRY_MS, PUBLISH_SIGNED_OUT_MS)
                : Math.max(backoff(st), e?.retryAfterMs ?? 0);
              return fail(st, ws, 'publish-failed', (err as Error).message, wait);
            }
            d.log({ level: 'warn', type: 'publish-batch-refused', message: `the host refused a batch (${e.status}); skipped: ${e.message}`, workspaceId: ws });
            outcome = 'refused';
          } finally {
            st.sending = null;
          }
          if (outcome === 'gone') return reset(st, st);
          if (outcome !== 'withheld') for (const r of fresh.slice(covered, i)) st.seen.add(r.id);
        }
        st.pos = Math.max(st.pos, b.lastId);
      }
      after = rows[rows.length - 1].id;
      st.pos = Math.max(st.pos, after);
      if (rows.length < page) break;
    }
    if (kind === 'sweep') {
      st.marks = [st.marks[1], capture];
      for (const id of st.seen) if (id <= st.marks[0]) st.seen.delete(id);
      if (st.seen.size > SEEN_MAX) st.seen.clear();
      // The next sweep's floor, so a restart re-covers the window. A revoked pair must not get its cursor back.
      if (await current(p)) await d.setCursor(ws, p.target, st.marks[0]);
    }
    if (st.failing) d.log({ level: 'info', type: 'publish-recovered', message: 'publishing resumed', workspaceId: ws });
    st.failing = null;
    st.attempt = 0;
  }

  function run(p: Pair, kind: Kind): Promise<void> {
    const key = `${p.spec.id}>${p.target}`;
    let st = states.get(key);
    if (!st) states.set(key, (st = { since: p.since, from: p.from, running: null, sending: null, again: null, retryAt: 0, attempt: 0, failing: null, pos: null, marks: [0, 0], seen: new Set() }));
    if (st.running) {
      // Rows ingested after the running pass read its last page would otherwise wait for the next sweep.
      if (kind === 'sweep' || !st.again) st.again = kind;
      return st.running;
    }
    if (halted(p.spec.id) || (now() < st.retryAt && same(st, p))) return Promise.resolve();
    const s = st;
    s.running = (async () => {
      let q: Pair | undefined = p;
      let k = kind;
      while (q) {
        await pass(q, s, k).catch((err: Error) => fail(s, q!.spec.id, 'publish-failed', err.message, backoff(s)));
        const again = s.again;
        s.again = null;
        if (!again || halted(p.spec.id) || now() < s.retryAt) return;
        k = again;
        q = (await pairs(p.spec.id)).find((r) => r.target === p.target);
      }
    })()
      .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message, workspaceId: p.spec.id }))
      .finally(() => {
        s.running = null;
      });
    return s.running;
  }

  async function drain(ws: string): Promise<void> {
    for (;;) {
      const running = [...states].flatMap(([key, st]) => (key.startsWith(`${ws}>`) && st.running ? [st.running] : []));
      if (!running.length) return;
      await Promise.all(running);
    }
  }

  async function sweep(): Promise<void> {
    for (const p of await pairs()) await run(p, 'sweep');
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
          .then((ps) => Promise.all(ps.map((p) => run(p, 'bump'))))
          .catch((err: Error) => d.log({ level: 'warn', type: 'publish-failed', message: err.message, workspaceId: ws }));
      }, o.debounceMs ?? PUBLISH_DEBOUNCE_MS));
    },
    sweep,
    async idle(ws) {
      await Promise.all([...states].flatMap(([key, st]) => (key.startsWith(`${ws}>`) && st.sending ? [st.sending] : [])));
    },
    drain,
    async exclusive(ws, fn) {
      held.set(ws, (held.get(ws) ?? 0) + 1);
      try {
        await drain(ws);
        return await fn();
      } finally {
        const n = (held.get(ws) ?? 1) - 1;
        if (n) held.set(ws, n);
        else held.delete(ws);
      }
    },
    stop() {
      stopped = true;
      cancelSweep();
      for (const cancel of pending.values()) cancel();
      pending.clear();
    }
  };
}
