// GET /events: server push of the channel names desktops use internally.
// Every channel needs `read`, which every authenticated subscriber has.
import type { BrokerOps } from './brokerOps.js';

export const EVENT_CHANNELS = new Set([
  'sessions:changed',
  'ports:changed',
  'observability:summary',
  'sessionstatus:update',
  'inputwait:update',
  'automations:changed',
  'proposals:changed',
  'inbox:changed'
]);

export interface Subscriber {
  send(text: string): void;
}

export class EventHub {
  private readonly subs = new Set<Subscriber>();

  add(s: Subscriber): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  get size(): number {
    return this.subs.size;
  }

  publish(channel: string, payload: unknown): void {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`unknown event channel ${channel}`);
    const text = JSON.stringify({ channel, payload });
    for (const s of this.subs) s.send(text);
  }
}

export interface OwnerPruner {
  ownerMark(): number;
  pruneOwners(live: ReadonlySet<string>, mark: number): void;
}

/** Polls the broker and publishes sessions:changed / ports:changed on a change. */
export function brokerWatch(ops: BrokerOps, hub: EventHub, owners?: OwnerPruner) {
  let lastSessions = '';
  let lastPorts = '';
  async function poll(): Promise<void> {
    const mark = owners?.ownerMark() ?? 0;
    const sessions = await ops.list();
    owners?.pruneOwners(new Set(sessions.filter((x) => x.alive).map((x) => x.id)), mark);
    const s = JSON.stringify([...sessions].sort((a, b) => a.id.localeCompare(b.id)));
    if (s !== lastSessions) {
      lastSessions = s;
      hub.publish('sessions:changed', { sessions });
    }
    const ports = await ops.listPorts();
    const p = JSON.stringify([...ports].sort((a, b) => a.port - b.port));
    if (p !== lastPorts) {
      lastPorts = p;
      hub.publish('ports:changed', { ports });
    }
  }
  return { poll };
}
