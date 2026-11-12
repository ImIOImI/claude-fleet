// Remote notices through the local notification policy (D132): each host's
// notices feed becomes notifyService.request calls from that workspace, so
// local rules, pause and downtime decide; a host can't force delivery. The
// stored rows are the only remote data kept (D133); forget() drops them.
//
// Cursor: the host stamps ts before an async insert, so commits can land out
// of ts order. Each pull re-reads CURSOR_OVERLAP_MS before the furthest
// (ts, id) seen, deduping by the CURSOR_IDS ids it remembers (never before
// `floor`, the newest id it forgot), then pages strictly after that keyset, so
// a run of one ts can't stall it. A late commit is missed only when more than
// CURSOR_IDS newer notices arrived within the overlap.
import type { RemoteNotice } from '../../preload/remoteAutomations.js';
import type { NotifyInput } from '../inbox/notifyService.js';

export const REMOTE_NOTICE_RATE = 20;
export const REMOTE_LATE_MS = 3_600_000;
export const CURSOR_OVERLAP_MS = 5_000;
/** The host's notices:feed page cap (D135). */
export const FEED_LIMIT = 100;
export const MAX_PAGES = 20;
/** Ids a cursor remembers (NotifyStore keeps the same number). */
export const CURSOR_IDS = 500;
/** Overlap re-read cap: the remembered ids span at most this many pages. */
export const OVERLAP_PAGES = CURSOR_IDS / FEED_LIMIT + 1;
export const POLL_MS = 60_000;
const DEBOUNCE_MS = 1_000;

export interface Keyset { ts: number; id: string }
/** (ts, id): the furthest notice seen; ids: those remembered for the overlap; floor: the newest one forgotten. */
export interface NoticeCursor extends Keyset { ids: string[]; floor: Keyset | null }
/** sinceTs null: the host's newest page. afterId: strictly after (sinceTs, afterId). */
export interface FeedQuery { sinceTs: number | null; afterId?: string }

export function remoteNoticeInput(n: RemoteNotice, origin: string, name: string, held: string | null): NotifyInput {
  return {
    kind: n.kind,
    title: `${name} · ${n.title}`.slice(0, 260),
    body: n.body,
    priority: n.priority,
    source: { kind: 'workspace', id: origin },
    todoId: null,
    workspaceId: origin,
    dedupeKey: n.dedupeKey,
    tags: [],
    ...(held ? { forceHold: held } : {})
  };
}

export interface RemoteNotifierDeps {
  /** undefined or a throw: the host is unavailable. Rows oldest first by (ts, id). */
  fetch(origin: string, q: FeedQuery): Promise<RemoteNotice[] | undefined>;
  name(origin: string): string;
  request(n: NotifyInput): Promise<unknown>;
  getCursor(origin: string): Promise<NoticeCursor | null>;
  setCursor(origin: string, c: NoticeCursor): Promise<void>;
  cursorOrigins(): Promise<string[]>;
  forget(origin: string): Promise<void>;
  now(): number;
  schedule?: (fn: () => void, ms: number) => () => void;
  onError?(e: unknown): void;
}

export interface RemoteNotifier {
  /** The host said its notices changed (or reconnected): pull soon. */
  hint(origin: string): void;
  /** The bookmarked remote origins: forgets the rest, polls those not pulled for POLL_MS. */
  sync(origins: string[]): void;
  stop(): void;
}

const after = (a: Keyset, b: Keyset) => a.ts > b.ts || (a.ts === b.ts && a.id > b.id);
const query = (k: Keyset): FeedQuery => (k.id ? { sinceTs: k.ts, afterId: k.id } : { sinceTs: k.ts });

export function createRemoteNotifier(d: RemoteNotifierDeps): RemoteNotifier {
  const schedule = d.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const pending = new Map<string, () => void>();
  const chains = new Map<string, Promise<void>>();
  const sentAt = new Map<string, number[]>();
  const pulledAt = new Map<string, number>();
  let stopped = false;

  /** Runs one job at a time per origin, so a forget can't interleave with a pull. */
  function enqueue(origin: string, job: () => Promise<void>): Promise<void> {
    const next = (chains.get(origin) ?? Promise.resolve()).then(() => (stopped ? undefined : job())).catch((e) => d.onError?.(e));
    chains.set(origin, next);
    return next;
  }

  function allow(origin: string, now: number): boolean {
    const xs = (sentAt.get(origin) ?? []).filter((t) => t > now - 60_000);
    const ok = xs.length < REMOTE_NOTICE_RATE;
    if (ok) xs.push(now);
    sentAt.set(origin, xs);
    return ok;
  }

  async function pull(origin: string): Promise<void> {
    pulledAt.set(origin, d.now());
    const cur = await d.getCursor(origin);
    if (!cur) {
      const rows = await d.fetch(origin, { sinceTs: null });
      if (!rows) return;
      const last = rows.reduce<Keyset>((m, r) => (after(r, m) ? r : m), { ts: 0, id: '' });
      await d.setCursor(origin, { ts: last.ts, id: last.id, ids: rows.map((r) => r.id).slice(-CURSOR_IDS), floor: null });
      return;
    }
    const start: Keyset = { ts: cur.ts, id: cur.id };
    const seen = new Set(cur.ids);
    const ids = [...cur.ids];
    const known = new Map<string, Keyset>();
    let key = start;
    let floor = cur.floor;
    const remember = (n: Keyset & { id: string }) => {
      known.set(n.id, { ts: n.ts, id: n.id });
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      ids.push(n.id);
      while (ids.length > CURSOR_IDS) {
        const k = known.get(ids.shift()!);
        if (k && (!floor || after(k, floor))) floor = k;
      }
      return true;
    };
    const save = () => d.setCursor(origin, { ...key, ids, floor });
    const base = Math.max(0, cur.ts - CURSOR_OVERLAP_MS);
    let q: FeedQuery = floor && floor.ts >= base ? query(floor) : { sinceTs: base };
    for (let page = 1; ; page++) {
      if (stopped) return;
      const rows = await d.fetch(origin, q);
      if (!rows) return;
      for (const n of rows) {
        if (stopped) return;
        if (after(n, key)) key = { ts: n.ts, id: n.id };
        if (!remember(n)) continue;
        const now = d.now();
        const held = now - n.ts > REMOTE_LATE_MS ? 'remote-late' : allow(origin, now) ? null : 'remote-rate';
        await d.request(remoteNoticeInput(n, origin, d.name(origin), held));
        await save();
      }
      await save();
      if (rows.length < FEED_LIMIT) return;
      const last = rows[rows.length - 1];
      if (q.afterId !== undefined && !after(last, { ts: q.sinceTs!, id: q.afterId })) return;
      if (page >= MAX_PAGES) return hint(origin);
      q = query(page >= OVERLAP_PAGES && !after(last, start) ? start : last);
    }
  }

  function hint(origin: string): void {
    if (stopped || pending.has(origin)) return;
    pending.set(origin, schedule(() => {
      pending.delete(origin);
      void enqueue(origin, async () => {
        try {
          await pull(origin);
        } catch (e) {
          d.onError?.(e);
        }
      });
    }, DEBOUNCE_MS));
  }

  return {
    hint,
    sync(origins) {
      if (stopped) return;
      const keep = new Set(origins);
      void d.cursorOrigins().then((known) => {
        for (const o of known) {
          if (keep.has(o)) continue;
          pending.get(o)?.();
          pending.delete(o);
          sentAt.delete(o);
          pulledAt.delete(o);
          void enqueue(o, () => d.forget(o));
        }
      }).catch((e) => d.onError?.(e));
      const now = d.now();
      for (const o of origins) if (now - (pulledAt.get(o) ?? -Infinity) >= POLL_MS) hint(o);
    },
    stop() {
      stopped = true;
      for (const c of pending.values()) c();
      pending.clear();
    }
  };
}
