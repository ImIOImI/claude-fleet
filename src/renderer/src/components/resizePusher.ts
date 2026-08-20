// Pushes terminal size changes to the PTY, and — the part that matters —
// only remembers a size as delivered once the PTY says it arrived (#268).
//
// The bug this exists to prevent: `pty:resize` can be dropped silently. The
// handle is unknown during the attach/re-attach window, after a recreate, and
// once a tab-close has reaped it; the pty may also have exited. The old code
// latched `lastSent = term.cols` *before* the call and swallowed the result,
// so a dropped resize was recorded as delivered. The #326 dedupe then skipped
// every later resize at that same size, and nothing ever reconciled: claude
// kept laying out at its stale width while xterm rendered at the new one.
// Each full-width row claude emits then overflows xterm's narrower grid and
// wraps onto the next line's first columns — permanent scrollback corruption
// (fragments in the first `delta` columns), which is what #268 reports.
//
// Extracted from TerminalSession.tsx so the latch is unit-testable; the
// component owns only the wiring.

export interface ResizeOutcome {
  ok: boolean;
}

export interface ResizePusherOpts {
  /** The terminal's size right now, read at send time (never captured in a
   *  closure — a stale captured size is how #269's one-shot fix reintroduced
   *  the very divergence it targeted). */
  getSize: () => { cols: number; rows: number };
  /** Deliver a size to the PTY. Rejection is treated as a drop. */
  push: (cols: number, rows: number) => Promise<ResizeOutcome | void>;
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Backoff before retrying a dropped resize. */
  retryMs?: number;
  /** Stop retrying one unchanged size after this many consecutive drops, so a
   *  permanently dead handle can't spin forever. A newly requested size
   *  resets the count — a live pane always gets a fresh chance. */
  maxAttempts?: number;
  /** Called once when a size is abandoned, so the caller can log it. */
  onGiveUp?: (cols: number, rows: number, attempts: number) => void;
}

export interface ResizePusher {
  /** Note a layout change; sends if the size actually differs. */
  request: () => void;
  /** Record a size already known to be applied (the attach size). */
  seed: (cols: number, rows: number) => void;
  /** Size the PTY is believed to hold; -1 until something lands. */
  readonly delivered: { cols: number; rows: number };
  dispose: () => void;
}

export function createResizePusher(opts: ResizePusherOpts): ResizePusher {
  const schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const retryMs = opts.retryMs ?? 250;
  const maxAttempts = opts.maxAttempts ?? 5;

  let sentCols = -1;
  let sentRows = -1;
  let inFlight = false;
  let disposed = false;
  // Consecutive drops for the size currently being chased.
  let attempts = 0;
  let attemptCols = -1;
  let attemptRows = -1;

  const send = (): void => {
    if (disposed || inFlight) return;
    const { cols, rows } = opts.getSize();
    if (cols === sentCols && rows === sentRows) return;
    if (cols <= 0 || rows <= 0) return;

    // A different size than the one we were failing on is a fresh chase.
    if (cols !== attemptCols || rows !== attemptRows) {
      attemptCols = cols;
      attemptRows = rows;
      attempts = 0;
    }
    if (attempts >= maxAttempts) return;
    attempts += 1;

    inFlight = true;
    Promise.resolve()
      .then(() => opts.push(cols, rows))
      .then((res) => {
        // `void` means the backend can't report delivery — assume delivered.
        if (res === undefined || res.ok) {
          sentCols = cols;
          sentRows = rows;
          attempts = 0;
          attemptCols = -1;
          attemptRows = -1;
        }
      })
      .catch(() => {
        /* drop: latch deliberately left where it was, so we retry */
      })
      .finally(() => {
        inFlight = false;
        if (disposed) return;
        const now = opts.getSize();
        if (now.cols === sentCols && now.rows === sentRows) return;
        if (now.cols === attemptCols && now.rows === attemptRows && attempts >= maxAttempts) {
          opts.onGiveUp?.(now.cols, now.rows, attempts);
          return;
        }
        // Either the push was dropped, or the pane moved again while we were
        // in flight. Both need another pass — this is the convergence the old
        // optimistic latch lost.
        schedule(send, retryMs);
      });
  };

  return {
    request: send,
    seed: (cols: number, rows: number) => {
      sentCols = cols;
      sentRows = rows;
      attempts = 0;
      attemptCols = -1;
      attemptRows = -1;
    },
    get delivered() {
      return { cols: sentCols, rows: sentRows };
    },
    dispose: () => {
      disposed = true;
    }
  };
}
