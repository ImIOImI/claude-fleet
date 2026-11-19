// sessions:drained (D151): the interactive sessions a drain closed, for desktops to resume their open tabs.
import { DRAINED_TTL_MS, MAX_DRAINED_ROWS, type DrainStore } from './drainStore.js';
import { RpcUnavailableError, type RpcChannel } from './rpc.js';

/** `read`: a desktop resumes only tabs it has open, and the resume itself is a `session`-tier CREATE. */
export function drainRpcChannels(drains: () => DrainStore | null, o: { db: boolean; now?: () => number }): Map<string, RpcChannel> {
  return new Map<string, RpcChannel>([[
    'sessions:drained',
    {
      tier: 'read',
      handle: async () => {
        if (!o.db) return { rows: [] };
        const d = drains();
        if (!d) throw new RpcUnavailableError('sessions unavailable');
        return { rows: await d.drained((o.now ?? Date.now)() - DRAINED_TTL_MS, MAX_DRAINED_ROWS) };
      }
    }
  ]]);
}
