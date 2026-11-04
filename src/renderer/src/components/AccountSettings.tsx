// Settings › Account: GitHub device-flow sign-in and sign-out. Each action
// applies at once (no batch Save). This panel only ever sees AccountStatus.
import { useEffect, useRef, useState } from 'react';
import type { AccountStatus, SignInStart } from '../../../preload';
import { accountControls, countdown, driveSignIn, loadAccount, packagesNote, parseIdentityError, ssoPrompt, type SignInRun } from '../accountView';

interface ActiveRun extends SignInRun {
  wake: () => void;
}

export function AccountSettings() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [flow, setFlow] = useState<SignInStart | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const run = useRef<ActiveRun | null>(null);
  const mounted = useRef(true);

  async function load(): Promise<void> {
    setError(null);
    const err = await loadAccount(
      (opts) => window.api.identity.status(opts),
      (s) => mounted.current && setStatus(s)
    );
    if (err && mounted.current) setError(err);
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      // Leaving the tab abandons a half-done sign-in.
      if (run.current) {
        stopRun();
        void window.api.identity.signInCancel();
      }
    };
  }, []);

  useEffect(() => {
    if (!flow) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [flow]);

  function stopRun(): void {
    const r = run.current;
    if (!r) return;
    r.cancelled = true;
    r.wake();
  }

  async function signIn(): Promise<void> {
    setError(null);
    setBusy(true);
    let f: SignInStart;
    try {
      f = await window.api.identity.signInStart();
    } catch (e) {
      if (mounted.current) setError(parseIdentityError(e).message);
      return;
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) {
      void window.api.identity.signInCancel();
      return;
    }
    const r: ActiveRun = { cancelled: false, wake: () => {} };
    run.current = r;
    setFlow(f);
    setNow(Date.now());
    setSigningIn(true);
    const outcome = await driveSignIn(
      f,
      {
        now: () => Date.now(),
        poll: () => window.api.identity.signInPoll(),
        wait: (ms) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            r.wake = () => {
              clearTimeout(t);
              resolve();
            };
          })
      },
      r
    );
    if (run.current === r) run.current = null;
    if (!mounted.current) return;
    setSigningIn(false);
    setFlow(null);
    if (outcome.kind === 'done') {
      setStatus(outcome.status);
      setError(null);
    } else if (outcome.kind === 'error') {
      setError(outcome.message);
    }
  }

  async function cancel(): Promise<void> {
    stopRun();
    setFlow(null);
    try {
      await window.api.identity.signInCancel();
    } catch (e) {
      if (mounted.current) setError(parseIdentityError(e).message);
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.api.identity.signOut();
      const s = await window.api.identity.status();
      if (mounted.current) setStatus(s);
    } catch (e) {
      if (mounted.current) setError(parseIdentityError(e).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function copyCode(): Promise<void> {
    if (!flow) return;
    await window.api.clipboard.write(flow.userCode);
    setCopied(true);
    setTimeout(() => mounted.current && setCopied(false), 1500);
  }

  if (!status) {
    return (
      <div className="new-tab account-tab" role="tabpanel">
        {error ? (
          <>
            <div className="form-hint error-text">{error}</div>
            <button type="button" className="btn" onClick={() => void load()}>
              Retry
            </button>
          </>
        ) : (
          <p className="setting-desc">Loading…</p>
        )}
      </div>
    );
  }

  const controls = accountControls({ busy, signingIn });
  const sso = status.signedIn ? ssoPrompt(status.sso) : null;
  const pkg = packagesNote(status.signedIn, status.packagesAccess);
  const who = status.identity;

  return (
    <div className="new-tab account-tab" role="tabpanel">
      <div className="settings-section">
        <div className="settings-section-header">GitHub</div>

        {!status.configured && (
          <p className="setting-desc">
            GitHub sign-in isn't configured in this build. Set <code>CLAUDE_FLEET_GITHUB_CLIENT_ID</code> or{' '}
            <code>identity.github.clientId</code> in config.json.
          </p>
        )}

        {status.signedIn && who && (
          <div className="account-card">
            {who.avatarUrl && <img className="account-avatar" src={who.avatarUrl} alt="" width={40} height={40} />}
            <div className="account-who">
              <div className="account-name">{who.displayName}</div>
              <div className="account-login">@{who.login}</div>
            </div>
            <button type="button" className="btn" onClick={() => void signOut()} disabled={controls.signOutDisabled}>
              Sign out
            </button>
          </div>
        )}
        {status.signedIn && who && who.teams.length > 0 && <p className="setting-desc">Teams: {who.teams.join(', ')}</p>}

        {status.configured && !status.signedIn && !flow && (
          <>
            <button type="button" className="btn primary" onClick={() => void signIn()} disabled={controls.signInDisabled}>
              Sign in with GitHub
            </button>
            <p className="setting-desc">
              Uses claude-fleet's own GitHub app (separate from the gh CLI). It asks for read:org (your teams) and
              read:packages (private ghcr.io loadouts).
            </p>
          </>
        )}

        {flow && (
          <div className="device-flow">
            <p className="setting-desc">Enter this code on GitHub:</p>
            <div className="device-code" aria-label="Device code">
              {flow.userCode}
            </div>
            <div className="device-actions">
              <button type="button" className="btn" onClick={() => void copyCode()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a className="btn primary" href={flow.verificationUri} target="_blank" rel="noreferrer">
                Open github.com/login/device
              </a>
              <button type="button" className="btn" onClick={() => void cancel()} disabled={controls.cancelDisabled}>
                Cancel
              </button>
            </div>
            <p className="setting-desc">Waiting for GitHub. The code expires in {countdown(flow.expiresAt, now)}.</p>
          </div>
        )}

        {sso && (
          <p className="setting-desc account-sso">
            {sso.text}
            {sso.url && (
              <>
                {' '}
                <a href={sso.url} target="_blank" rel="noreferrer">
                  Authorise on GitHub
                </a>
              </>
            )}
          </p>
        )}
        {pkg && <p className="setting-desc">{pkg}</p>}
        {!status.persisted && (
          <p className="setting-desc">Secret storage isn't available on this system, so your sign-in lasts until the app quits.</p>
        )}
        {status.notice && <p className="setting-desc account-notice">{status.notice}</p>}
        {status.signedIn && (
          <p className="setting-desc">
            Sign out removes the token from this computer. To revoke it on GitHub too, use GitHub Settings → Applications
            → Authorized OAuth Apps.
          </p>
        )}
        {error && <div className="form-hint error-text">{error}</div>}
      </div>
    </div>
  );
}
