import { useEffect, useState } from 'react';
import type { ServingPort } from '../../preload';

/** Workspace ids (sorted) with at least one serving port attributed to a
 *  session — the set of session inventories worth fetching. Pure for tests. */
export function workspacesNeedingNames(
  servingPorts: Record<string, ServingPort[]>
): string[] {
  return Object.keys(servingPorts)
    .filter((id) => (servingPorts[id] ?? []).some((p) => p.sessionId !== null))
    .sort();
}

/**
 * broker-session-id → tab-name maps per workspace, for the Serving rail's
 * session chips. Reads sessions.json (sessions:read) for exactly the
 * workspaces that currently have attributed ports; re-fetches when the set
 * of (workspace, sessionId) pairs changes. A tab rename can leave a chip
 * name stale until the next ports change — acceptable for a rail label.
 */
export function useServingSessionNames(
  servingPorts: Record<string, ServingPort[]>
): Record<string, Record<string, string>> {
  const [names, setNames] = useState<Record<string, Record<string, string>>>({});
  const key = Object.entries(servingPorts)
    .flatMap(([ws, ports]) =>
      ports.filter((p) => p.sessionId).map((p) => `${ws}:${p.sessionId}`)
    )
    .sort()
    .join(',');
  useEffect(() => {
    if (key === '') {
      setNames({});
      return;
    }
    let alive = true;
    void Promise.all(
      workspacesNeedingNames(servingPorts).map(async (id) => {
        try {
          const inv = await window.api.sessions.read(id);
          return [id, Object.fromEntries(inv.sessions.map((s) => [s.id, s.name]))] as const;
        } catch {
          return [id, {} as Record<string, string>] as const;
        }
      })
    ).then((entries) => {
      if (alive) setNames(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
    // servingPorts is captured intentionally; `key` is its change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return names;
}
