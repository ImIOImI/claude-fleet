// `broker:drain` from a host's /events (D152): validated, deduplicated, kept per host for the renderer.
import type { RemoteDrain } from '../preload/remoteTypes.js';

const PHASES = new Set(['serving', 'draining', 'unknown']);
const INSTANCE_RE = /^[\x21-\x7e]{1,32}$/;
const ms = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export function parseDrainEvent(p: unknown): RemoteDrain | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.phase !== 'string' || !PHASES.has(o.phase) || !ms(o.softAt) || !ms(o.hardAt)) return null;
  if (o.instance !== null && (typeof o.instance !== 'string' || !INSTANCE_RE.test(o.instance))) return null;
  return { phase: o.phase as RemoteDrain['phase'], softAt: o.softAt, hardAt: o.hardAt, instance: o.instance };
}

export function createDrainRelay(send: (u: { workspaceId: string; drain: RemoteDrain }) => void) {
  const states = new Map<string, RemoteDrain>();
  return {
    update(origin: string, payload: unknown): void {
      const d = parseDrainEvent(payload);
      if (!d) return;
      const prev = states.get(origin);
      if (prev && prev.phase === d.phase && prev.softAt === d.softAt && prev.hardAt === d.hardAt && prev.instance === d.instance) return;
      states.set(origin, d);
      send({ workspaceId: origin, drain: d });
    },
    snapshot(): Record<string, RemoteDrain> {
      return Object.fromEntries(states);
    },
    forget(origin: string): void {
      states.delete(origin);
    }
  };
}
