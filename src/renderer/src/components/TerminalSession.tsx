// One terminal session: a single xterm + one docker-exec PTY into the
// workspace's container. The parent TerminalPane manages how many of
// these are mounted for a given workspace (one per session tab) and
// which one is visible at a time.
//
// When the PTY ends (user types /exit, claude crashes, etc.), an
// overlay appears with a "Start new session" button. That button bumps
// a session-epoch local to THIS session, which restarts just this tab
// with a fresh PTY — other session tabs are unaffected.
//
// `visible` controls whether the host div is shown. We keep the xterm
// mounted and the PTY attached even when hidden so the user can switch
// back without losing the running claude or its scrollback.

import { useEffect, useRef, useState } from 'react';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';

// Stretch the font fallback chain so canvas renders for glyphs xterm
// can't find in a monospace font (emoji, symbols, regional indicators)
// fall through to a system emoji font instead of rendering as tofu. The
// monospace fonts come first so character-grid alignment is preserved
// for the common case; emoji-font glyphs are typically wide and pair
// with the unicode11 width tables below.
const TERMINAL_FONT_FAMILY = [
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  '"DejaVu Sans Mono"',
  'monospace',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  '"Noto Color Emoji"',
  '"Segoe UI Symbol"',
  '"Noto Sans Symbols2"',
  'emoji'
].join(', ');

const URL_REGEX = /https?:\/\/[^\s'"`<>()\[\]{}]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function multilineLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      const cols = term.cols;

      let firstRow = bufferLineNumber;
      while (firstRow > 1 && buf.getLine(firstRow - 1)?.isWrapped) firstRow--;

      let lastRow = firstRow;
      while (lastRow < buf.length && buf.getLine(lastRow)?.isWrapped) lastRow++;

      let logical = '';
      for (let r = firstRow; r <= lastRow; r++) {
        logical += buf.getLine(r - 1)?.translateToString(false) ?? '';
      }

      const links: ILink[] = [];
      URL_REGEX.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_REGEX.exec(logical)) !== null) {
        const url = m[0].replace(TRAILING_PUNCTUATION, '');
        if (!url) continue;

        const startIdx = m.index;
        const endIdx = startIdx + url.length - 1;
        const startRow = firstRow + Math.floor(startIdx / cols);
        const startCol = (startIdx % cols) + 1;
        const endRow = firstRow + Math.floor(endIdx / cols);
        const endCol = (endIdx % cols) + 1;

        if (startRow > bufferLineNumber || endRow < bufferLineNumber) continue;

        links.push({
          range: { start: { x: startCol, y: startRow }, end: { x: endCol, y: endRow } },
          text: url,
          activate: () => {
            window.open(url, '_blank');
          }
        });
      }
      callback(links.length ? links : undefined);
    }
  };
}

interface Props {
  containerId: string;
  /** Stable session id from sessions.json — used as the broker's
   *  session key so re-attach across an app restart finds the same
   *  live PTY. */
  sessionId: string;
  visible: boolean;
  /**
   * Called when the PTY signals end-of-life (user `/exit`, claude
   * crash, docker stop, etc.). The parent TerminalPane uses this to
   * surface per-tab status in the tab strip — `live` until this fires,
   * `ended` after.
   */
  onLifecycleChange?: (sessionId: string, status: 'live' | 'ended') => void;
}

export function TerminalSession({
  containerId,
  sessionId,
  visible,
  onLifecycleChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Bumped when the user clicks "Start new session" / "Retry" after a
  // session ends. The effect deps on containerId+sessionEpoch, so a new
  // attach happens with a fresh xterm instance (no stale state from the
  // dead session).
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // `null` while the session is live. After it ends, distinguishes
  // between a clean PTY exit (`{ kind: 'natural' }` — user typed
  // `/exit`, claude crashed, container stopped) and an attach failure
  // (`{ kind: 'attach-error', message }` — broker socket unreachable,
  // permission denied, etc.). The overlay renders different copy +
  // surfaces the error text for the latter so users can act on it
  // instead of staring at a generic "session ended" card.
  const [endedReason, setEndedReason] = useState<
    { kind: 'natural' } | { kind: 'attach-error'; message: string } | null
  >(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    setEndedReason(null);
    onLifecycleChange?.(sessionId, 'live');

    // Declared up front so the safeFit helper can read it. The cleanup
    // function below flips it true; safeFit early-returns to avoid
    // calling fit on a host whose xterm has already been disposed
    // (StrictMode double-mount in dev, fast workspace switches in prod).
    let disposed = false;

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      theme: { background: '#101216' },
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
      wordSeparator: ' \t()[]{}\'"<>`',
      // Default is 1, which feels glacial on most trackpads/wheels. 3 is
      // closer to native terminal scroll cadence — a normal wheel notch
      // moves a few lines instead of a single character row.
      scrollSensitivity: 3,
      fastScrollSensitivity: 6
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Unicode 11+ width tables — without this xterm uses Unicode 6 widths,
    // which classify keycap sequences (`1️⃣`), regional
    // indicators, and most modern emoji as 1-cell narrow. They then render
    // jammed together because their actual glyph width is 2 cells. With
    // the addon active, xterm reserves the right number of cells per
    // grapheme cluster and the surrounding text stays aligned.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(host);

    // xterm 5.x's Viewport.syncScrollArea reads from `_renderer.dimensions`,
    // which is set up inside `term.open` but can be transiently undefined
    // immediately after open (the renderer is wired in pieces across a
    // microtask boundary). Calling `fit.fit()` synchronously after open
    // triggers a resize → syncScrollArea path that crashes with
    // "Cannot read properties of undefined (reading 'dimensions')". The
    // crash floods the error log on every workspace switch / new tab and
    // leaves the terminal looking blank because xterm's render loop is
    // broken. Defer to the next animation frame and catch defensively;
    // by then the renderer is settled and the user's first frame of
    // PTY output arrives correctly.
    const safeFit = (): void => {
      if (disposed) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[TerminalSession] fit failed (xterm Viewport bug):', err);
      }
    };
    const initialFitRaf = requestAnimationFrame(safeFit);

    const linkProviderDisposable = term.registerLinkProvider(multilineLinkProvider(term));

    // ptyHandleId is the internal handle returned by main's pty:attach —
    // used to address input/resize/detach. Distinct from the prop
    // `sessionId`, which is the broker's persistent session key.
    let ptyHandleId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;

    const doCopy = (): void => {
      const sel = term.getSelection();
      if (sel) {
        void window.api.clipboard.write(sel);
        term.clearSelection();
      }
    };

    const doPaste = (): void => {
      void window.api.clipboard.read().then((text) => {
        if (text && ptyHandleId) window.api.pty.input(ptyHandleId, text);
      });
    };

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

      if (plainCtrl && e.code === 'KeyC') {
        if (term.hasSelection()) {
          doCopy();
          return false;
        }
        return true; // no selection — pass through as SIGINT
      }
      if (plainCtrl && e.code === 'KeyV') {
        doPaste();
        return false;
      }
      if (ctrlShift && e.code === 'KeyC') {
        doCopy();
        return false;
      }
      if (ctrlShift && e.code === 'KeyV') {
        doPaste();
        return false;
      }
      return true;
    });

    const onContextMenu = async (e: MouseEvent): Promise<void> => {
      e.preventDefault();
      const hasSelection = term.hasSelection();
      const choice = await window.api.menu.showTerminalContextMenu({ hasSelection });
      if (choice === 'copy') doCopy();
      else if (choice === 'paste') doPaste();
      else if (choice === 'selectAll') term.selectAll();
    };
    host.addEventListener('contextmenu', onContextMenu);

    (async () => {
      try {
        const sid = await window.api.pty.attach(containerId, sessionId, term.cols, term.rows);
        if (disposed) {
          window.api.pty.detach(sid);
          return;
        }
        ptyHandleId = sid;
        unsubData = window.api.pty.onData(sid, (chunk) => {
          term.write(chunk);
        });
        unsubEnd = window.api.pty.onEnd(sid, () => {
          term.writeln('\r\n[session ended]');
          if (!disposed) {
            setEndedReason({ kind: 'natural' });
            onLifecycleChange?.(sessionId, 'ended');
            // Diagnostic: distinguish "claude /exit" from "broker
            // disconnected mid-session" cases. Both currently fire the
            // same natural-ended overlay; this log captures session id
            // + handle id so we can correlate against any earlier
            // attach-error entries.
            void window.api.app.logError({
              type: 'session-ended-natural',
              message: 'pty:end fired (claude exited or broker disconnected)',
              extra: { sessionId, ptyHandleId: sid, containerId }
            });
          }
        });
        term.onData((data) => window.api.pty.input(sid, data));
      } catch (err) {
        // Attach failure most commonly means the in-container broker
        // isn't reachable — older runner images without it, or the
        // container still booting. The overlay renders this message
        // verbatim so the user has something to act on; we don't bother
        // writing it into xterm because the overlay would cover it
        // anyway (z-index over .terminal-host).
        const msg = err instanceof Error ? err.message : String(err);
        if (!disposed) {
          setEndedReason({ kind: 'attach-error', message: msg });
          // Mirror to error.log so post-mortem debugging has a record
          // even though this isn't an uncaught exception (the catch
          // here is clean — but the user still loses their terminal).
          void window.api.app.logError({
            type: 'pty-attach-error',
            message: msg,
            stack: err instanceof Error ? err.stack : undefined,
            extra: { sessionId, containerId }
          });
          onLifecycleChange?.(sessionId, 'ended');
        }
      }
    })();

    const ro = new ResizeObserver(() => {
      safeFit();
      if (ptyHandleId) {
        try {
          window.api.pty.resize(ptyHandleId, term.cols, term.rows);
        } catch {
          // pty:resize is best-effort — failing to resize doesn't
          // justify killing the terminal.
        }
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(initialFitRaf);
      ro.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      unsubData?.();
      unsubEnd?.();
      linkProviderDisposable.dispose();
      if (ptyHandleId) window.api.pty.detach(ptyHandleId);
      term.dispose();
    };
  }, [containerId, sessionId, sessionEpoch]);

  // When this session becomes visible again, force a fit. xterm's
  // ResizeObserver can fire while the host is `visibility: hidden`
  // (dimensions are preserved) but window resizes during that hidden
  // period otherwise pile up — a manual fit on show keeps the layout
  // honest.
  useEffect(() => {
    if (!visible || !hostRef.current) return;
    const host = hostRef.current;
    // Defer to next frame so the visibility change has been committed
    // and xterm can measure the real client size.
    const id = requestAnimationFrame(() => {
      const evt = new Event('resize');
      host.dispatchEvent(evt);
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div
      className="terminal-session"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      aria-hidden={!visible}
    >
      <div className="terminal-host" ref={hostRef}>
        {endedReason?.kind === 'attach-error' && (
          <div
            className="session-ended-overlay"
            role="alertdialog"
            aria-label="Failed to attach to workspace"
          >
            <div className="session-ended-card attach-error">
              <div className="session-ended-title">couldn't attach to the workspace</div>
              <pre className="session-ended-error" data-testid="attach-error-message">
                {endedReason.message}
              </pre>
              <div className="session-ended-help">
                Common cause: the local runner image is out of date and doesn't include the
                broker yet. Try <code>docker pull ghcr.io/imioimi/claude-fleet/runner:latest</code>,
                then recreate the workspace.
              </div>
              <div className="session-ended-actions">
                <button
                  className="btn"
                  onClick={() => {
                    void window.api.clipboard.write(endedReason.message);
                  }}
                  title="Copy the error message to the clipboard"
                >
                  Copy error
                </button>
                <button
                  className="btn primary"
                  onClick={() => setSessionEpoch((e) => e + 1)}
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        )}
        {endedReason?.kind === 'natural' && (
          <div className="session-ended-overlay" role="alertdialog" aria-label="Session ended">
            <div className="session-ended-card">
              <div className="session-ended-title">claude session ended</div>
              <div className="session-ended-help">
                The workspace is still running. Start a new <code>claude</code> session in this
                terminal to keep going.
              </div>
              <button
                className="btn primary"
                onClick={() => setSessionEpoch((e) => e + 1)}
              >
                Start new session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
