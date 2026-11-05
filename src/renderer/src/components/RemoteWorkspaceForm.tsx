// The + modal's Remote kind: sign in, check a host URL, bookmark it.
import { useCallback, useEffect, useState } from 'react';
import type { AccountStatus, RemoteProbe } from '../../../preload';
import { applyProbe, remoteFormView, tierTitle, type RemoteFormState } from '../remoteView';
import { AccountSettings } from './AccountSettings';

export function RemoteWorkspaceForm({ onAdded, onCancel }: { onAdded: (id: string) => void; onCancel: () => void }) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [url, setUrl] = useState('');
  const [state, setState] = useState<RemoteFormState>({ ok: null, err: null });
  const [busy, setBusy] = useState(false);
  const onStatus = useCallback((s: AccountStatus) => setAccount(s), []);

  useEffect(() => {
    void window.api.identity.status().then(setAccount, () => undefined);
  }, []);

  async function run(call: () => Promise<RemoteProbe>, addsOnOk: boolean): Promise<void> {
    setBusy(true);
    try {
      const r = await call();
      setState((prev) => applyProbe(prev, r));
      if (addsOnOk && r.ok) onAdded(r.workspace.id);
    } finally {
      setBusy(false);
    }
  }

  const view = remoteFormView(state);
  const primary = (): void => {
    if (view.primary === 'check') void run(() => window.api.remote.probe(url), false);
    else if (view.primary === 'add') void run(() => window.api.remote.add(url), true);
    else void run(() => window.api.remote.add(url, { sameHostNewAddress: true }), true);
  };

  if (account && !account.signedIn) {
    return (
      <div className="remote-form">
        <p className="form-hint">Remote workspaces check who you are with your GitHub sign-in. One sign-in serves every host.</p>
        <AccountSettings onStatus={onStatus} />
      </div>
    );
  }

  const ok = state.ok;
  return (
    <div className="remote-form">
      <div className="form-row">
        <label htmlFor="remote-url">Host URL</label>
        <input
          id="remote-url"
          type="url"
          placeholder="https://review-bot.example.com"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setState({ ok: null, err: null });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() && !busy) primary();
          }}
          disabled={busy}
          autoFocus
        />
      </div>
      {ok && (
        <div className="remote-probe">
          <div className="remote-probe-name">{ok.workspace.name}</div>
          {ok.workspace.description && <div className="remote-probe-desc">{ok.workspace.description}</div>}
          <div className="remote-probe-who">
            Signed in as @{ok.user.login} · your tier:{' '}
            <span className={`tier-badge tier-${ok.tier}`} title={tierTitle(ok.tier)}>
              {ok.tier}
            </span>
          </div>
          {ok.warning && <div className="remote-warning">{ok.warning}</div>}
        </div>
      )}
      {view.notice && (
        <div className={`form-hint${view.notice.tone === 'error' ? ' error-text' : ''}`} role={view.notice.tone === 'error' ? 'alert' : 'status'}>
          {view.notice.text}
          {view.notice.linkUrl && (
            <>
              {' '}
              <a href={view.notice.linkUrl} target="_blank" rel="noreferrer">
                Authorise on GitHub
              </a>
            </>
          )}
        </div>
      )}
      <div className="modal-footer">
        <span className="modal-footer-spacer" />
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={primary} disabled={busy || !url.trim()}>
          {busy ? 'Working…' : view.primaryLabel}
        </button>
      </div>
    </div>
  );
}
