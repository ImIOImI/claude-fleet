import React from 'react';
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
if (root) createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
