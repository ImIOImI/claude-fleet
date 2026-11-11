// A real fleet-host endpoint over a fake broker, for desktop-side tests (not shipped).
import type { AddressInfo } from 'node:net';
import type { GrantRule } from '../main/identity/grants.js';
import { IdentityError, type Identity } from '../main/identity/types.js';
import { AttachHub } from './attachHub.js';
import { buildAuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import { createLogger } from './log.js';
import type { PublishRoute } from './publishRoute.js';
import { brokerRpcChannels } from './rpc.js';
import { createHostServer } from './server.js';
import { fakeBroker } from './testFakes.js';

export const TEST_WORKSPACE_ID = '01JC0000000000000000000000';

export async function startTestHost(opts: { tokens: Record<string, Identity>; grants: GrantRule[]; sessions?: string[]; pingMs?: number; publish?: PublishRoute }) {
  const broker = fakeBroker(opts.sessions ?? []);
  const events = new EventHub();
  let lease: LeaseState = 'holder';
  const config = parseHostConfig({ workspace: { name: 'review-bot', description: 'reviews' }, grants: opts.grants });
  const auth = buildAuthContext(config, () => ({
    id: 'github',
    verify: async (t) => {
      const who = opts.tokens[t];
      if (!who) throw new IdentityError('unauthorized', 'bad credentials', 401);
      return who;
    }
  }));
  const hub = new AttachHub(broker.ops);
  const host = createHostServer({
    workspace: () => ({ ...config.workspace, id: TEST_WORKSPACE_ID }),
    auth: () => auth,
    lease: () => lease,
    healthy: () => true,
    hub,
    events,
    rpc: brokerRpcChannels(broker.ops, hub.owners),
    publish: opts.publish,
    log: createLogger(() => undefined),
    pingMs: opts.pingMs
  });
  await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  return { url, host, broker, events, setLease: (s: LeaseState) => (lease = s), close: () => host.close() };
}
