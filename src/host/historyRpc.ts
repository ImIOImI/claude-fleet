// history:* RPC: the desktop's federated reads. The reader is the holder's and
// scopes every query to the hosted workspace.
import { HistoryArgError, parseSessionId, parseSessionsReq, type HistoryReader } from './historyRead.js';
import { RpcArgError, RpcUnavailableError, type RpcChannel } from './rpc.js';

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HistoryArgError) throw new RpcArgError(err.message);
    throw err;
  }
}

export function historyRpcChannels(reader: () => HistoryReader | null): Map<string, RpcChannel> {
  const need = (): HistoryReader => {
    const r = reader();
    if (!r) throw new RpcUnavailableError('history unavailable');
    return r;
  };
  return new Map<string, RpcChannel>([
    ['history:sessions', { tier: 'read', handle: ([req]) => guarded(() => need().sessions(parseSessionsReq(req ?? {}))) }],
    ['history:summary', { tier: 'read', handle: ([id]) => guarded(() => need().summary(parseSessionId(id))) }]
  ]);
}
