// Host `observability:summary` hints → one RPC read → the renderer's existing
// push. The hint carries no data, so every read stays tier-checked.
import type { RemoteEvent } from '../remoteClient.js';
import type { RemoteSourceInfo } from '../remote.js';
import type { WorkspaceSummary } from '../db.js';
import { REMOTE_CHANGE_CHANNELS, type RemoteChangeChannel } from '../../preload/remoteAutomations.js';

export const RELAY_DEBOUNCE_MS = 2_000;

export interface SummaryRelayDeps {
  sources(): RemoteSourceInfo[];
  /** `RemoteClient.subscribe`; `retryInMs` null: it has stopped for good. */
  subscribe(url: string, onEvent: (e: RemoteEvent) => void, onState: (connected: boolean, why?: { retryInMs: number | null }) => void): () => void;
  /** undefined: unavailable; nothing is pushed. */
  fetchSummary(remoteId: string): Promise<WorkspaceSummary | null | undefined>;
  broadcast(workspaceId: string, summary: WorkspaceSummary | null): void;
  schedule?: (fn: () => void, ms: number) => () => void;
  /** An automations/proposals/inbox/notices hint from that host; carries no data. */
  onHostChange?(origin: string, channel: RemoteChangeChannel): void;
  /** The /events socket for that host (re)connected. */
  onConnected?(origin: string): void;
}

export function createSummaryRelay(d: SummaryRelayDeps): { sync(): void; stop(): void } {
  const schedule = d.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const subs = new Map<string, { url: string; stop: () => void; cancel: (() => void) | null }>();
  const drop = (id: string): void => {
    const s = subs.get(id);
    s?.stop();
    s?.cancel?.();
    subs.delete(id);
  };
  const hint = (id: string): void => {
    const s = subs.get(id);
    if (!s || s.cancel) return;
    s.cancel = schedule(async () => {
      s.cancel = null;
      const summary = await d.fetchSummary(id).catch(() => undefined);
      if (summary !== undefined && subs.get(id) === s) d.broadcast(id, summary);
    }, RELAY_DEBOUNCE_MS);
  };
  return {
    sync() {
      const want = new Map(d.sources().map((s) => [s.id, s]));
      for (const [id, s] of subs) if (want.get(id)?.url !== s.url) drop(id);
      for (const [id, src] of want) {
        // A live subscription rides out a down state on its own backoff.
        if (subs.has(id) || src.state !== 'running') continue;
        const entry: { url: string; stop: () => void; cancel: (() => void) | null } = { url: src.url, stop: () => undefined, cancel: null };
        subs.set(id, entry);
        entry.stop = d.subscribe(
          src.url,
          (e) => {
            if (subs.get(id) !== entry) return;
            if ((REMOTE_CHANGE_CHANNELS as readonly string[]).includes(e.channel)) d.onHostChange?.(id, e.channel as RemoteChangeChannel);
            if (e.channel === 'observability:summary' && (e.payload as { workspaceId?: unknown } | null)?.workspaceId === id) hint(id);
          },
          (connected, why) => {
            if (connected && subs.get(id) === entry) d.onConnected?.(id);
            if (!connected && why?.retryInMs === null && subs.get(id) === entry) drop(id);
          }
        );
      }
    },
    stop() {
      for (const id of [...subs.keys()]) drop(id);
    }
  };
}
