// Keystroke → echo round-trip pairing (perf telemetry Phase 2, spec B3).
// Pure: no xterm/IPC/window imports, so vitest covers it directly. One
// tracker per terminal session. Each pty:data arrival closes every pending
// keystroke inside the window — noisy per-sample, meaningful as a histogram.

export const ECHO_WINDOW_MS = 2000;

/** Paste storms enqueue one "keystroke" per chunk; anything beyond this is
 *  not typing latency worth sampling, and an unbounded queue is a leak. */
const MAX_PENDING = 256;

export class EchoRttTracker {
  private pending: number[] = [];

  keystroke(ts: number): void {
    if (this.pending.length >= MAX_PENDING) return;
    this.pending.push(ts);
  }

  /** Close all pending keystrokes against this output arrival. Returns the
   *  round-trip durations (oldest first); expired keystrokes are dropped. */
  output(ts: number): number[] {
    if (this.pending.length === 0) return [];
    const closed = this.pending
      .filter((k) => ts - k <= ECHO_WINDOW_MS && ts >= k)
      .map((k) => ts - k);
    this.pending = [];
    return closed;
  }
}
