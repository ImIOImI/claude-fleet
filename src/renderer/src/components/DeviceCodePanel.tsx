// Inline GitHub device-flow step for the signed-out banner and remote tab cards (D173).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { countdown } from '../accountView';
import type { SignInFlowState } from '../signInFlow';
import { signInFlow } from '../signInFlowInstance';

export function useSignInFlow(): SignInFlowState {
  return useSyncExternalStore(signInFlow.subscribe, signInFlow.get, signInFlow.get);
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
      <DeviceCodeWaiting
        userCode={s.userCode}
        verificationUri={s.verificationUri}
        expiresAt={s.expiresAt}
        now={now}
        copied={copied}
        onCopy={() => void window.api.clipboard.write(s.userCode).then(() => setCopied(true), () => undefined)}
        onCancel={() => signInFlow.cancel()}
      />
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

export function DeviceCodeWaiting(p: {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  now: number;
  copied: boolean;
  onCopy: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="device-flow inline">
      <span>
        <span className="visually-hidden">Code: </span>
        <span className="device-code">{p.userCode}</span>
      </span>
      <div className="device-actions">
        <button type="button" className="btn" onClick={p.onCopy}>
          {p.copied ? 'Copied' : 'Copy'}
        </button>
        <a className="btn primary" href={p.verificationUri} target="_blank" rel="noreferrer">
          Open github.com/login/device
        </a>
        <button type="button" className="btn" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
      {/* Ticks every second; a reader would hear it each time. */}
      <span className="device-countdown" aria-live="off">
        Waiting for GitHub. The code expires in {countdown(p.expiresAt, p.now)}.
      </span>
    </div>
  );
}
