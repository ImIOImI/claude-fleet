// The Istio sidecar check before fleet-host opens the ports only the mesh may reach (SPEC §7 *Remote host*).
import { setTimeout as sleep } from 'node:timers/promises';

export const MESH_READY_URL = 'http://127.0.0.1:15021/healthz/ready';
export const MESH_WAIT_MS = 60_000;
export const MESH_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;

export type MeshState = 'checking' | 'ready' | 'missing';

/** True once the readiness URL answers 200; false at the deadline or on abort. */
export async function waitForMesh(o: { url: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<boolean> {
  const deadline = Date.now() + (o.timeoutMs ?? MESH_WAIT_MS);
  const poll = o.pollMs ?? MESH_POLL_MS;
  while (!o.signal?.aborted) {
    try {
      // A redirect is not ready, as in the broker's probe.
      const res = await fetch(o.url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.body?.cancel();
      if (res.status === 200) return true;
    } catch {
      // Not listening yet.
    }
    if (Date.now() + poll > deadline) return false;
    try {
      await sleep(poll, undefined, { signal: o.signal });
    } catch {
      return false;
    }
  }
  return false;
}
