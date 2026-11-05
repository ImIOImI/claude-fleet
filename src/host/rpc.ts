// POST /rpc/<channel>: IPC channel names and argument lists, each channel
// allowlisted with the tier it needs. Anything not registered doesn't exist.
import { tierAtLeast, type Tier } from '../main/identity/grants.js';
import type { Principal } from './attachHub.js';
import { DEFAULT_PORT } from './config.js';
import { portKillRefusal, type BrokerOps } from './brokerOps.js';
import type { Logger } from './log.js';

export interface RpcChannel {
  tier: Tier;
  handle(args: unknown[], caller: Principal): Promise<unknown>;
}

export type RpcRegistry = ReadonlyMap<string, RpcChannel>;

export class RpcArgError extends Error {}
export class RpcForbiddenError extends Error {}

export interface RpcResponse {
  status: number;
  body: { ok: true; result: unknown } | { ok: false; error: string };
}

export async function dispatchRpc(reg: RpcRegistry, channel: string, body: unknown, caller: Principal, log?: Logger): Promise<RpcResponse> {
  const ch = reg.get(channel);
  if (!ch) return { status: 404, body: { ok: false, error: 'no such channel' } };
  if (!tierAtLeast(caller.tier, ch.tier)) return { status: 403, body: { ok: false, error: `forbidden: needs ${ch.tier}` } };
  const args = body && typeof body === 'object' && !Array.isArray(body) ? (body as { args?: unknown }).args : undefined;
  if (!Array.isArray(args)) return { status: 400, body: { ok: false, error: 'body must be {"args": [...]}' } };
  try {
    return { status: 200, body: { ok: true, result: await ch.handle(args, caller) } };
  } catch (err) {
    if (err instanceof RpcArgError) return { status: 400, body: { ok: false, error: err.message } };
    if (err instanceof RpcForbiddenError) return { status: 403, body: { ok: false, error: err.message } };
    log?.log('error', 'rpc handler failed', { channel, error: err });
    return { status: 500, body: { ok: false, error: 'internal error' } };
  }
}

export function brokerRpcChannels(ops: BrokerOps, hostPort: number = DEFAULT_PORT): Map<string, RpcChannel> {
  return new Map<string, RpcChannel>([
    ['sessions:live', { tier: 'read', handle: () => ops.list() }],
    ['ports:list', { tier: 'read', handle: () => ops.listPorts() }],
    [
      'ports:kill',
      {
        tier: 'steer',
        handle: async ([port]) => {
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new RpcArgError('port must be 1-65535');
          const refusal = await portKillRefusal(ops, port, hostPort);
          if (refusal) throw new RpcForbiddenError(refusal);
          return ops.killPort(port);
        }
      }
    ]
  ]);
}
