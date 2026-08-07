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
          // Store an empty array rather than deleting the key. Deleting would
          // let a late-arriving ports:list seed overlay resurrect the row
          // permanently if the seed lands after this clear. PortsSection
          // renders nothing for empty arrays, so the visual result is
          // identical. Broadcasts always win over the seed overlay below.
          if (workspaceId in prev && prev[workspaceId].length === 0) return prev;
          return { ...prev, [workspaceId]: [] };
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
