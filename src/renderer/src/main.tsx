import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Forward renderer-side crashes into <userData>/error.log via the main
// process. Wired before React mounts so a crash during App's initial
// render still lands in the log.
//
// We pre-bind to a local reference of window.api so a future
// monkeypatch can't break the bridge. The handlers swallow their own
// failures (the log itself is best-effort).
const api = window.api;
function forward(payload: { type: string; message: string; stack?: string; extra?: Record<string, unknown> }) {
  try {
    api?.app.logError(payload);
  } catch {
    // intentional — never let logging itself crash the page.
  }
}
window.addEventListener('error', (e: ErrorEvent) => {
  forward({
    type: 'window.onerror',
    message: e.message ?? String(e.error ?? 'unknown'),
    stack: e.error instanceof Error ? e.error.stack : undefined,
    extra: { filename: e.filename, lineno: e.lineno, colno: e.colno }
  });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  forward({
    type: 'window.onunhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

const root = document.getElementById('root');
// React StrictMode is deliberately OFF. xterm.js 5.x's `term.dispose()`
// doesn't fully detach its global scroll/resize listeners — those
// handlers still hold a reference to the disposed renderer. StrictMode's
// dev-only synthetic double-mount (mount → cleanup → mount) creates a
// new xterm on the SAME host while the disposed one's stale listeners
// are still firing, so every subsequent scroll/resize hits the
// `Viewport.syncScrollArea` → `_renderer.dimensions` path with an
// undefined renderer and crashes. The crash makes the terminal look
// blank (xterm's render loop is broken) and the symptom is "click +
// for a new session → blank cursor", "switch workspaces and back →
// terminal blank". StrictMode is a no-op in the packaged build, so
// keeping it off in dev has zero impact on shipped behavior; it just
// removes the dev-only crash trigger. If we later want StrictMode's
// effect-cleanup verification back, the principled fix is to hoist
// the xterm instance out of the React effect into a ref so it
// survives the synthetic teardown — non-trivial and not worth it
// today.
if (root) createRoot(root).render(<App />);
