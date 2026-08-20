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
import { isBusyTitle, isUnknownTitleGlyph } from '../activityDetector';
import { busyFlagIsStale } from '../staleBusy';
import { decideTerminalKeyAction } from '../terminalKeymap';
import { EchoRttTracker } from '../echoRtt';
import { initPerfState, perfRecording } from '../perfState';
import { buildTerminalOptions } from './terminalOptions';

const URL_REGEX = /https?:\/\/[^\s'"`<>()\[\]{}]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const MAX_SAMPLE_BATCH = 1000; // matches sanitizePerfSamples MAX_BATCH in main

// Poll period for the stale-busy watchdog (see staleBusy.ts). Worst case a
// stale flag survives BUSY_SILENCE_TIMEOUT_MS + this before it clears.
const STALE_BUSY_CHECK_MS = 2000;

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
  // The live xterm, so effects outside the attach effect can force a repaint
  // without reaching into its closure (#268).
  const termRef = useRef<Terminal | null>(null);
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

    const term = new Terminal(buildTerminalOptions());
    termRef.current = term;
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

    // Fit repeatedly until the size stops changing, so the PTY is spawned at
    // the size the pane will actually BE (#268).
    //
    // One pre-attach fit isn't enough. At app startup every warm workspace's
    // pane mounts and attaches at once, before layout has settled, and they all
    // fit to the same too-small size — measured on a live install, 69% of
    // sessions spawned at 107x45 while the panes they belonged to settled at
    // 128x52 / 132x52 / 194x51 / 228x72. A `--resume` session then replays its
    // entire prior conversation into ConPTY's buffer at that wrong width, and
    // every later resize makes ConPTY re-emit that stale-width content. That is
    // the ghosting, and it is why it's worst at startup on resumed sessions.
    //
    // Two consecutive frames agreeing is the signal. Capped, so a pane whose
    // size never settles (an animation, a drag in progress) still attaches
    // promptly — attaching late is worse than attaching slightly wrong.
    const SETTLED_FIT_MAX_MS = 500;
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const fitUntilStable = async (): Promise<void> => {
      safeFit();
      const deadline = Date.now() + SETTLED_FIT_MAX_MS;
      let prev = `${term.cols}x${term.rows}`;
      while (!disposed && Date.now() < deadline) {
        await nextFrame();
        if (disposed) return;
        safeFit();
        const cur = `${term.cols}x${term.rows}`;
        if (cur === prev) return; // two frames agree — the pane has settled
        prev = cur;
      }
    };

    /** Redraw every visible row from the buffer (#268). Best-effort: a torn-down
     *  renderer must never fault the terminal. */
    const forceRepaint = (): void => {
      if (disposed) return;
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* renderer disposed mid-frame */
      }
    };

    const linkProviderDisposable = term.registerLinkProvider(multilineLinkProvider(term));

    // ptyHandleId is the internal handle returned by main's pty:attach —
    // used to address input/resize/detach. Distinct from the prop
    // `sessionId`, which is the broker's persistent session key.
    let ptyHandleId: string | null = null;
    // Size last pushed to the pty; seeded from the attach so a redundant
    // first resize is suppressed too (#268).
    let lastSentCols = -1;
    let lastSentRows = -1;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;
    let staleBusyTimer: ReturnType<typeof setInterval> | null = null;
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
      // Settled size, not just "one frame after open" (#268).
      await fitUntilStable();
      if (disposed) return;

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
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        // Busy/idle (#283): read the title from xterm's own OSC parser —
        // onTitleChange fires once per complete title no matter how the PTY
        // stream was chunked, which is the framing dependence that used to
        // swallow idle edges. isBusyTitle still classifies the glyph.
        let busy = false;
        let lastOutputAt = Date.now();
        const setBusy = (next: boolean): void => {
          if (next === busy) return;
          busy = next;
          onActivityChange?.(sessionId, next);
        };
        // Unknown glyph = claude changed its title spinner again (#343);
        // busy stays fail-safe idle but log once per attach so the next
        // upstream change surfaces as a diagnostic, not a dead indicator.
        let reportedUnknownGlyph = false;
        term.onTitleChange((title) => {
          if (!reportedUnknownGlyph && isUnknownTitleGlyph(title)) {
            reportedUnknownGlyph = true;
            void window.api.app.logError({
              type: 'activity-unknown-title-glyph',
              message: `unrecognized terminal-title glyph — busy detection may be broken (#343): ${title.trim()}`,
              extra: { sessionId, containerId, title: title.trim() }
            });
          }
          setBusy(isBusyTitle(title));
        });
        // A title write can still be lost before it ever reaches us (ConPTY
        // drops/coalesces writes, #283) and claude writes the idle title
        // exactly once — so also re-derive from a level signal: flagged busy
        // while the PTY has been silent past the timeout ⇒ the flag is stale,
        // clear it. A real busy state re-asserts itself within ~1s via the
        // next spinner-title frame.
        staleBusyTimer = setInterval(() => {
          if (busyFlagIsStale(busy, lastOutputAt, Date.now())) setBusy(false);
        }, STALE_BUSY_CHECK_MS);
        // Latency sampling (perf Phase 2): keystroke→echo pairing + output
        // hop, batched to main every 5s. Gated on perfRecording() per event.
        initPerfState();
        const echoTracker = new EchoRttTracker();
        const sampleBatch: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }> = [];
        sampleTimer = setInterval(() => {
          if (sampleBatch.length === 0) return;
          window.api.perf.samples({ sessionId: sid, samples: sampleBatch.splice(0) });
        }, 5000);
        unsubData = window.api.pty.onData(sid, (chunk, ts) => {
          lastOutputAt = Date.now();
          if (perfRecording()) {
            const arrival = Date.now();
            for (const rtt of echoTracker.output(arrival)) {
              if (sampleBatch.length < MAX_SAMPLE_BATCH) sampleBatch.push({ kind: 'echo_rtt', durMs: rtt });
            }
            if (typeof ts === 'number') {
              // Completion callback fires after xterm has processed the chunk.
              term.write(chunk, () => {
                if (!samplingClosed && sampleBatch.length < MAX_SAMPLE_BATCH) {
                  sampleBatch.push({
                    kind: 'output_hop',
                    durMs: Date.now() - ts
                  });
                }
              });
            } else {
              term.write(chunk);
            }
          } else {
            term.write(chunk);
          }
        });
        unsubEnd = window.api.pty.onEnd(sid, () => {
          term.writeln('\r\n[session ended]');
          if (!disposed) {
            // A dead session isn't busy.
            setBusy(false);
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
            // Date.now(), NOT performance.timeOrigin + performance.now():
            // timeOrigin drifts from the wall clock on long-lived renderers
            // (sleep/NTP) — observed ~4 s of skew, which inflated output_hop
            // and made main's `dur >= 0` guard silently drop every input_hop.
            // Main stamps with Date.now(); the renderer must use the same
            // clock. (2026-08-11 perf_events finding.)
            const ts = Date.now();
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
        // Only push a size the pty doesn't already have (#268). The observer
        // fires on any host layout change — a scrollbar appearing as claude's
        // output grows, rails mounting, the context bar updating — and most of
        // those leave cols/rows untouched. Forwarding them anyway was not free:
        // on Windows every resize also arms the ConPTY settler, whose whole job
        // is to jitter the winsize and force ConPTY to re-emit a frame. So a
        // no-op resize cost three ConPTY resizes and a full redraw of whatever
        // was in its buffer. 11% of settles on a live install were triggered
        // this way, with nothing having changed.
        if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          try {
            window.api.pty.resize(ptyHandleId, term.cols, term.rows);
          } catch {
            // pty:resize is best-effort — failing to resize doesn't
            // justify killing the terminal.
          }
          // Repaint every visible row from the buffer after a real size
          // change (#268). The reported symptom is stray glyphs that overlap
          // the text and — the detail that identifies the cause — do NOT go
          // away as you scroll. Buffer content scrolls with the content, so
          // anything that stays put is a cell xterm never repainted: the
          // buffer is right and the paint is stale. With the DOM renderer
          // (no canvas/webgl addon here) `refresh` is what forces rows to be
          // redrawn, and it was previously only ever called once, after the
          // symbol webfonts load. Resizes — including resizes that land while
          // a pane sits `visibility: hidden`, which is when xterm's dirty-row
          // tracking has the least chance of being right — got none.
          forceRepaint();
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
      if (staleBusyTimer) clearInterval(staleBusyTimer);
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
      if (termRef.current === term) termRef.current = null;
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
      // Panes are always-mounted and get resized while hidden, so a pane can
      // come back carrying rows xterm last painted at a different size (#268).
      // The fit above only redraws what xterm thinks is dirty; force the rest.
      const t = termRef.current;
      if (t) {
        try {
          t.refresh(0, t.rows - 1);
        } catch {
          /* disposed between frames */
        }
      }
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
