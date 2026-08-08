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
import { ActivityDetector } from '../activityDetector';
import { decideTerminalKeyAction } from '../terminalKeymap';
import { EchoRttTracker } from '../echoRtt';
import { initPerfState, perfRecording } from '../perfState';

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
  // Bundled @font-face subset (styles.css): crisp Miscellaneous-Technical
  // symbols the host fontconfig set lacks — notably Claude's permission-mode
  // media-control triangles (⏵, U+23F5). Placed before the emoji fonts so a
  // sharp glyph wins over an emoji-style one.
  '"Noto Sans Symbols 2"',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  '"Noto Color Emoji"',
  '"Segoe UI Symbol"',
  'emoji',
  // Last-resort catch-all (bundled Unifont subset) for glyphs nothing else
  // covers — e.g. the tool-result tree connector ⎿ (U+23BF), which even Noto
  // Sans Symbols 2 lacks. Pixelated, but guarantees no tofu boxes.
  '"Unifont"'
].join(', ');

const URL_REGEX = /https?:\/\/[^\s'"`<>()\[\]{}]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const MAX_SAMPLE_BATCH = 1000; // matches sanitizePerfSamples MAX_BATCH in main

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
  /** ULID — used to pin this session's durable-mirror override before attach. */
  workspaceId: string;
  /** Stable session id from sessions.json — used as the broker's
   *  session key so re-attach across an app restart finds the same
   *  live PTY. */
  sessionId: string;
  /**
   * Effective durable-mirror setting for this session (the per-tab override or
   * the workspace default). Pinned into the main process right before attach,
   * so it's locked before any transcript line is ingested.
   */
  mirrorSetting: 'on' | 'off';
  /**
   * When set, this tab resumes a prior claude session: the first CREATE
   * for it spawns `claude --resume <resumeOf>` (resumeOf is the claude
   * session UUID). Passed straight to pty.attach; ignored on reattach when
   * the broker session is already alive.
   */
  resumeOf?: string;
  visible: boolean;
  /**
   * Whether the workspace is paused (container frozen via `docker pause`).
   * A paused container's broker (PID 1) is frozen too: a unix-socket
   * connect still succeeds at the kernel level (the connection sits in the
   * listen backlog), so ATTACH is sent but the frozen broker never replies
   * with ATTACHED — the RPC hangs the full 30s and fails with "ATTACHED
   * timed out". So we must NOT attach while paused. The attach effect skips
   * the network attach when this is true and re-runs (clean reattach, broker
   * replays its ring buffer) when it flips back to false on resume. (#18)
   */
  paused?: boolean;
  /**
   * Called when the PTY signals end-of-life (user `/exit`, claude
   * crash, docker stop, etc.). The parent TerminalPane uses this to
   * surface per-tab status in the tab strip — `live` until this fires,
   * `ended` after.
   */
  onLifecycleChange?: (sessionId: string, status: 'live' | 'ended') => void;
  /**
   * Fired when this session's busy/idle state flips, detected from claude's
   * terminal-title glyph in the PTY stream (see activityDetector). The parent
   * aggregates per-workspace to drive the chip's "working" indicator.
   */
  onActivityChange?: (sessionId: string, busy: boolean) => void;
  /**
   * Reload/refresh trigger. Each time this number changes to a new non-null
   * value, the session terminates its broker session (kills claude) and
   * re-attaches the same id with `claude --resume <uuid>`, resuming the
   * conversation in place. Fed per-session by TerminalPane's reloadTargets
   * map; the parent only advances it while the session is idle. Used by both
   * the loadout reload (#16) and the manual chip-menu Refresh.
   */
  reloadToken?: number | null;
  /**
   * Fired when a reload/refresh was requested but this tab's claude session
   * could not be identified (no broker→claude mapping). The reload is skipped
   * — resuming a guessed session silently attaches the tab to a different
   * conversation (#195) — and the parent surfaces the skip to the user.
   */
  onRefreshUnresolved?: (sessionId: string) => void;
}

export function TerminalSession({
  containerId,
  workspaceId,
  sessionId,
  mirrorSetting,
  resumeOf,
  visible,
  paused = false,
  onLifecycleChange,
  onActivityChange,
  reloadToken,
  onRefreshUnresolved,
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

  // The live pty handle id for the current attach, mirrored out of the effect
  // closure so the loadout-reload handler can close it. Null between attaches.
  const ptyHandleRef = useRef<string | null>(null);
  // When set, the NEXT attach resumes this claude UUID instead of starting
  // fresh — set by the reload handler right before it bumps the epoch, then
  // consumed (cleared) by the attach. Overrides the `resumeOf` prop.
  const resumeOverrideRef = useRef<string | null>(null);
  // Dedupes reload triggers so a re-render with the same token doesn't reload
  // twice (StrictMode double-invoke, unrelated prop churn).
  const lastReloadTokenRef = useRef<number>(0);

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

    // The bundled symbol fonts (styles.css @font-face) load lazily. The DOM
    // renderer repaints text when a webfont arrives, but force the load + a
    // refresh so Claude's TUI glyphs (⏵, ⎿) don't flash as tofu on first paint.
    void Promise.all([
      document.fonts.load('13px "Noto Sans Symbols 2"'),
      document.fonts.load('13px "Unifont"')
    ]).then(() => {
      if (!disposed) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* renderer torn down between open and font load */
        }
      }
    });

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

    const linkProviderDisposable = term.registerLinkProvider(multilineLinkProvider(term));

    // ptyHandleId is the internal handle returned by main's pty:attach —
    // used to address input/resize/detach. Distinct from the prop
    // `sessionId`, which is the broker's persistent session key.
    let ptyHandleId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let samplingClosed = false;

    // Scoped one-shot repaint nudge. claude paints some startup screens
    // (notably the org "Managed settings require approval" gate) on the
    // primary buffer with incremental erases and no full clear — verified
    // by capturing its output stream: no ESC[2J, no alternate-screen
    // switch. If a layout-settling resize lands after claude already
    // painted at the attach-time size, claude reflows but leaves stale rows
    // behind and the user sees overlapping text. We can't make claude
    // full-clear, so on the FIRST real post-attach size change — and only
    // before the user starts typing — we send Ctrl+L (claude's redraw key)
    // to force a clean repaint. Setups whose size is already correct at
    // attach (the common case, including anyone with no org-managed
    // settings) get no post-attach resize, so this never fires: a no-op.
    let attachCols = 0;
    let attachRows = 0;
    let nudgeArmed = false;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const REPAINT_NUDGE_WINDOW_MS = 6000;
    const REPAINT_NUDGE_DEBOUNCE_MS = 200;
    const disarmNudge = (): void => {
      nudgeArmed = false;
      if (nudgeTimer) {
        clearTimeout(nudgeTimer);
        nudgeTimer = null;
      }
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
    };

    const doCopy = (): void => {
      const sel = term.getSelection();
      if (sel) {
        void window.api.clipboard.write(sel);
        term.clearSelection();
      }
    };

    const doPaste = (): void => {
      // Image on the clipboard → ingest as a drop instead of pasting text.
      // The custom key handler calls preventDefault() on Ctrl+V (see below), so
      // the browser's native paste never reaches xterm's textarea and this stays
      // the single paste path (#150). Clipboard images are handed off via a
      // window CustomEvent that useDropIngestion handles.
      void window.api.clipboard.readImage().then((img) => {
        if (img) {
          window.dispatchEvent(new CustomEvent('cf:drop-image', { detail: img }));
          return;
        }
        return window.api.clipboard.read().then((text) => {
          if (text && ptyHandleId) window.api.pty.input(ptyHandleId, text);
        });
      });
    };

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const action = decideTerminalKeyAction(e, term.hasSelection());
      // preventDefault is what stops the native browser paste from firing a
      // second time alongside our doPaste() (#150); the decision owns when.
      if (action.preventDefault) e.preventDefault();
      if (action.effect === 'copy') doCopy();
      else if (action.effect === 'paste') doPaste();
      return action.pass;
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

    // CRITICAL: fit BEFORE attach. Otherwise xterm sits at its default
    // 80×24, claude is spawned thinking that's the terminal size, and
    // a frame later when the real fit lands xterm re-flows its
    // scrollback to the new dimensions. Claude's setup flow (dark
    // mode → OAuth → trust folder) issues ESC[2J between prompts, but
    // those clears only target the visible viewport at the pre-resize
    // size — rows beyond the original 24 inherit stale scrollback
    // from earlier setup screens. The user sees claude's main UI at
    // the top + leftover trust-prompt fragments below.
    //
    // Defer the whole attach to one frame after `term.open` so
    // xterm's renderer is settled, safeFit runs against real host
    // dimensions, and the cols/rows we pass to the broker on attach
    // are right from the very first byte claude writes.
    //
    // Regression-tested by: "Always-mount: pty:attach receives
    // fitted xterm cols/rows…" in tests/smoke.spec.ts. That test
    // asserts the cols recorded by the pty-attach log entry are not
    // 80 (xterm's default). Without this rAF the test fails because
    // attach runs synchronously with the default term.cols.
    const initialFitRaf = requestAnimationFrame(async () => {
      if (disposed) return;
      safeFit();

      // Don't attach into a frozen broker. While paused, set up the xterm
      // (so the under-overlay terminal is sized and ready) but skip the
      // network attach — it would hang 30s against the frozen PID-1 broker
      // and fail with "ATTACHED timed out". When `paused` flips to false on
      // resume, this effect re-runs and attaches cleanly. (#18)
      if (paused) return;

      try {
        // Pin the durable-mirror decision before the PTY (and thus the
        // transcript) starts, so no line is ingested under the wrong setting.
        // Non-fatal: a failure here must never block the attach.
        await window.api.mirror.setOverride(workspaceId, sessionId, mirrorSetting).catch(() => {});
        // A reload sets resumeOverrideRef just before bumping the epoch; it wins
        // over the resumeOf prop for this one attach, then is cleared.
        const resumeTarget = resumeOverrideRef.current ?? resumeOf;
        resumeOverrideRef.current = null;
        const sid = await window.api.pty.attach(
          containerId,
          sessionId,
          term.cols,
          term.rows,
          resumeTarget
        );
        if (disposed) {
          window.api.pty.detach(sid);
          return;
        }
        ptyHandleId = sid;
        ptyHandleRef.current = sid;
        // Latency sampling (perf Phase 2): keystroke→echo pairing + output
        // hop, batched to main every 5s. Gated on perfRecording() per event.
        initPerfState();
        const echoTracker = new EchoRttTracker();
        const sampleBatch: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }> = [];
        sampleTimer = setInterval(() => {
          if (sampleBatch.length === 0) return;
          window.api.perf.samples({ sessionId: sid, samples: sampleBatch.splice(0) });
        }, 5000);
        const activity = new ActivityDetector();
        // PTY chunks are bytes; decode (streaming-safe so a multibyte glyph
        // split across chunks still reassembles) for the title detector.
        const decoder = new TextDecoder();
        unsubData = window.api.pty.onData(sid, (chunk, ts) => {
          if (perfRecording()) {
            const arrival = performance.timeOrigin + performance.now();
            for (const rtt of echoTracker.output(arrival)) {
              if (sampleBatch.length < MAX_SAMPLE_BATCH) sampleBatch.push({ kind: 'echo_rtt', durMs: rtt });
            }
            if (typeof ts === 'number') {
              // Completion callback fires after xterm has processed the chunk.
              term.write(chunk, () => {
                if (!samplingClosed && sampleBatch.length < MAX_SAMPLE_BATCH) {
                  sampleBatch.push({
                    kind: 'output_hop',
                    durMs: performance.timeOrigin + performance.now() - ts
                  });
                }
              });
            } else {
              term.write(chunk);
            }
          } else {
            term.write(chunk);
          }
          // Watch the title glyph for busy/idle; report only on a flip.
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          if (activity.push(text)) onActivityChange?.(sessionId, activity.isBusy);
        });
        unsubEnd = window.api.pty.onEnd(sid, () => {
          term.writeln('\r\n[session ended]');
          if (!disposed) {
            // A dead session isn't busy.
            onActivityChange?.(sessionId, false);
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
        term.onData((data) => {
          // First user keystroke ⇒ they're interacting; cancel any pending
          // repaint nudge so we never inject Ctrl+L into an active session.
          disarmNudge();
          if (perfRecording()) {
            const ts = performance.timeOrigin + performance.now();
            echoTracker.keystroke(ts);
            window.api.pty.input(sid, data, ts);
          } else {
            window.api.pty.input(sid, data);
          }
        });

        // Arm the scoped repaint nudge (consumed by the ResizeObserver
        // below). attachCols/Rows is the size claude is laying out at right
        // now; a later resize that changes it is the trigger.
        attachCols = term.cols;
        attachRows = term.rows;
        nudgeArmed = true;
        armTimer = setTimeout(disarmNudge, REPAINT_NUDGE_WINDOW_MS);
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
    });

    const ro = new ResizeObserver(() => {
      safeFit();
      if (ptyHandleId) {
        try {
          window.api.pty.resize(ptyHandleId, term.cols, term.rows);
        } catch {
          // pty:resize is best-effort — failing to resize doesn't
          // justify killing the terminal.
        }
        // A real post-attach size change while still armed ⇒ debounce a
        // single Ctrl+L once resizes settle, then disarm. Fires at most
        // once per session, only when the size actually changed, and never
        // after the user has typed.
        if (nudgeArmed && (term.cols !== attachCols || term.rows !== attachRows)) {
          attachCols = term.cols;
          attachRows = term.rows;
          if (nudgeTimer) clearTimeout(nudgeTimer);
          nudgeTimer = setTimeout(() => {
            nudgeTimer = null;
            const handle = ptyHandleId;
            disarmNudge();
            if (handle) {
              try {
                window.api.pty.input(handle, '\x0c');
              } catch {
                // best-effort repaint; never fault the terminal
              }
            }
          }, REPAINT_NUDGE_DEBOUNCE_MS);
        }
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      onActivityChange?.(sessionId, false);
      cancelAnimationFrame(initialFitRaf);
      disarmNudge();
      samplingClosed = true;
      if (sampleTimer) clearInterval(sampleTimer);
      ro.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      unsubData?.();
      unsubEnd?.();
      linkProviderDisposable.dispose();
      if (ptyHandleId) window.api.pty.detach(ptyHandleId);
      if (ptyHandleRef.current === ptyHandleId) ptyHandleRef.current = null;
      term.dispose();
    };
  }, [containerId, sessionId, resumeOf, sessionEpoch, paused]);

  // Loadout reload (#16): when the parent targets this session with a fresh
  // token, terminate the live broker session (kills claude) and re-attach the
  // same id with `--resume <claude-uuid>`, so the tab picks the conversation
  // back up with the newly-installed loadout loaded. The parent only fires this
  // while the session is idle. No-op if we can't resolve a claude session to
  // resume (e.g. claude never started in this tab) — the files are already in
  // place and will load on the next `claude` start regardless.
  useEffect(() => {
    if (reloadToken == null) return;
    if (reloadToken === lastReloadTokenRef.current) return;
    lastReloadTokenRef.current = reloadToken;
    let cancelled = false;
    void (async () => {
      try {
        // Resume-grade lookup only: never resume from a legacy guessed
        // mapping — resuming a guess silently swaps the tab onto a
        // different conversation (#195).
        const claudeUuid = await window.api.observability.resolveResumeTarget(
          workspaceId,
          sessionId
        );
        if (cancelled) return;
        if (!claudeUuid) {
          // No mapping — we don't know which conversation this tab holds.
          // Never guess (#195): tell the user the refresh was skipped.
          onRefreshUnresolved?.(sessionId);
          return;
        }
        // Resume the SAME conversation on the next attach.
        resumeOverrideRef.current = claudeUuid;
        const handle = ptyHandleRef.current;
        if (handle) await window.api.pty.closeSession(handle);
        if (cancelled) return;
        // Re-run the attach effect: the broker session is gone, so attach
        // CREATEs it with `--resume <uuid>`.
        setSessionEpoch((e) => e + 1);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[TerminalSession] loadout reload failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, sessionId, workspaceId, onRefreshUnresolved]);

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
