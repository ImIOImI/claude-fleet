// Runs a remote action with a per-intent request id; tracks busy keys and the last message per key.
import { useCallback, useRef, useState } from 'react';
import type { RemoteActionResult } from '../../../preload/remoteAutomations';
import { actionMessage, intentRunner } from '../remoteAutomationsView';

export function useRemoteAction() {
  const runner = useRef(intentRunner());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = useCallback(async <T,>(key: string, send: (requestId: string) => Promise<RemoteActionResult<T>>): Promise<RemoteActionResult<T>> => {
    setBusy((b) => new Set(b).add(key));
    setErrors(({ [key]: _drop, ...rest }) => rest);
    const r = await runner.current.run(key, send);
    const msg = actionMessage(r);
    if (msg) setErrors((x) => ({ ...x, [key]: msg }));
    setBusy((b) => {
      const n = new Set(b);
      n.delete(key);
      return n;
    });
    return r;
  }, []);
  return { run, busy, errors };
}
