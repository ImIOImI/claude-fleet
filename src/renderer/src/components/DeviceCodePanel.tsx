// Inline GitHub device-flow step for the signed-out banner and remote tab cards (D173).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { countdown } from '../accountView';
import type { SignInFlowState } from '../signInFlow';
import { signInFlow } from '../signInFlowInstance';

export function useSignInFlow(): SignInFlowState {
  return useSyncExternalStore(signInFlow.subscribe, signInFlow.get);
}

export function DeviceCodePanel() {
  const s = useSignInFlow();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (s.phase !== 'waiting') return;
    setCopied(false);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.phase]);

  if (s.phase === 'waiting') {
    return (
      <div className="device-flow inline">
        <span className="device-code" aria-label="Device code">{s.userCode}</span>
        <div className="device-actions">
          <button type="button" className="btn" onClick={() => void window.api.clipboard.write(s.userCode).then(() => setCopied(true), () => undefined)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a className="btn primary" href={s.verificationUri} target="_blank" rel="noreferrer">
            Open github.com/login/device
          </a>
          <button type="button" className="btn" onClick={() => signInFlow.cancel()}>
            Cancel
          </button>
        </div>
        <span className="device-countdown">Waiting for GitHub. The code expires in {countdown(s.expiresAt, now)}.</span>
      </div>
    );
  }
  return (
    <span className="device-flow-start">
      {s.phase === 'error' && <span className="device-flow-error">{s.message}</span>}
      <button type="button" className="btn primary" disabled={s.phase === 'starting'} onClick={() => void signInFlow.start()}>
        Sign in
      </button>
    </span>
  );
}
