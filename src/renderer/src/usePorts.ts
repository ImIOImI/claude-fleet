import { useEffect, useState } from 'react';
import type { ServingPort } from '../../preload';

/**
 * Live Serving snapshots keyed by workspace id. Seeds from ports:list on
 * mount (so a renderer reload rebuilds instantly) then applies
 * ports:changed broadcasts (full per-workspace replace; empty = clear).
 */
export function usePorts(): Record<string, ServingPort[]> {
  const [byWorkspace, setByWorkspace] = useState<Record<string, ServingPort[]>>({});
  useEffect(() => {
    let alive = true;
    void window.api.ports.list().then((all) => {
      if (!alive) return;
      setByWorkspace((prev) => {
        const seed: Record<string, ServingPort[]> = {};
        for (const { workspaceId, ports } of all) seed[workspaceId] = ports;
        // Broadcasts that raced the seed win: overlay prev on top.
        return { ...seed, ...prev };
      });
    });
    const unsub = window.api.ports.onChanged((workspaceId, ports) => {
      setByWorkspace((prev) => {
        if (ports.length === 0) {
          if (!(workspaceId in prev)) return prev;
          const next = { ...prev };
          delete next[workspaceId];
          return next;
        }
        return { ...prev, [workspaceId]: ports };
      });
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return byWorkspace;
}
