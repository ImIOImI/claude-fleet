// `remote:changed` to the renderer: a data-free hint, debounced per host and
// channel, sent only while that host is still bookmarked.
import { REMOTE_CHANGE_CHANNELS, type RemoteChange, type RemoteChangeChannel } from '../../preload/remoteAutomations.js';

export const REMOTE_CHANGE_DEBOUNCE_MS = 1_000;

export interface RemoteChangeForwarderDeps {
  isBookmarked(origin: string): boolean;
  send(change: RemoteChange): void;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export function createRemoteChangeForwarder(d: RemoteChangeForwarderDeps): {
  hint(origin: string, channel: RemoteChangeChannel): void;
  /** A (re)connected socket may have missed hints: refresh every channel. */
  connected(origin: string): void;
  stop(): void;
} {
  const schedule = d.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const pending = new Map<string, () => void>();
  const hint = (origin: string, channel: RemoteChangeChannel): void => {
    if (!REMOTE_CHANGE_CHANNELS.includes(channel)) return;
    const key = `${origin}\u0000${channel}`;
    if (pending.has(key)) return;
    pending.set(key, schedule(() => {
      pending.delete(key);
      if (d.isBookmarked(origin)) d.send({ origin, channel });
    }, REMOTE_CHANGE_DEBOUNCE_MS));
  };
  return {
    hint,
    connected: (origin) => { for (const c of REMOTE_CHANGE_CHANNELS) hint(origin, c); },
    stop() {
      for (const cancel of pending.values()) cancel();
      pending.clear();
    }
  };
}
