// Debounced ConPTY re-settle for Windows local sessions (#268).
//
// ConPTY keeps its own pseudoconsole buffer and reprints/reflows it to the
// frontend on updates — an ONGOING condition, so the #269 one-shot post-spawn
// jitter could not hold (field-verified: v0.10.0 still corrupts, see the
// conpty-render-bug handoff). Worse, that timer replayed the spawn-time
// cols/rows captured in its closure: a renderer fit landing inside the 250 ms
// window (pane layout settling, rails mounting) was silently reverted,
// leaving ConPTY at the stale width while xterm rendered the new one — the
// exact width divergence the jitter was meant to prevent.
//
// This settler is the fix for both: every resize (and the initial spawn)
// schedules a debounced settle, and the settle reads the pty's size at FIRE
// time. The jitter (one column away and back) makes the winsize actually
// change so ConPTY re-emits a clean frame — the programmatic equivalent of
// the manual window resize that reliably heals the corruption.
//
// Pure module (no node-pty/electron imports) so it loads under vitest; the
// caller injects the exit-guarded resize and a live size getter.

export const CONPTY_SETTLE_DEBOUNCE_MS = 250;

export interface ConptySettlerOpts {
  /** Exit-guarded resize (never throws into a dead pty). */
  resize(cols: number, rows: number): void;
  /** The pty's CURRENT size — read at settle time, never captured. */
  getSize(): { cols: number; rows: number };
  /** Observability hook: fired once per settle with the settled size. */
  onSettle?(info: { cols: number; rows: number }): void;
  debounceMs?: number;
}

export interface ConptySettler {
  /** (Re)arm the debounced settle. Call at spawn and after every resize. */
  schedule(): void;
  /** Cancel any pending settle and disarm permanently (pty exited). */
  dispose(): void;
}

export function createConptySettler(opts: ConptySettlerOpts): ConptySettler {
  const debounceMs = opts.debounceMs ?? CONPTY_SETTLE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  return {
    schedule(): void {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const { cols, rows } = opts.getSize();
        // Jitter must CHANGE the winsize or ConPTY may treat it as a no-op
        // and skip the re-emit; go up when there's no room to go down.
        opts.resize(cols > 1 ? cols - 1 : cols + 1, rows);
        opts.resize(cols, rows);
        opts.onSettle?.({ cols, rows });
      }, debounceMs);
    },
    dispose(): void {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
