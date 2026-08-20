// Width-agreement monitor (#268).
//
// Every layer between the renderer and the PTY can lose a resize without
// saying so: `pty:resize` no-ops on an unknown handle, local.ts's safeResize
// swallows a throw, and on WSL the size still has to survive the ConPTY →
// wsl.exe → in-distro pty relay. When one is lost, claude keeps laying out at
// the old width while xterm renders at the new one. Claude's TUI paints
// absolutely-positioned full-width rows, so every row it emits then overflows
// xterm's narrower grid by `deltaCols` and wraps onto the next line's first
// columns — permanent scrollback corruption, since nothing rewrites history.
//
// Nothing in the stack reports that state today, which is why #268 has
// outlived four root-cause theories. This turns it into a log line.

export interface SizePair {
  cols: number;
  rows: number;
}

export interface Divergence {
  handleId: string;
  want: SizePair;
  got: SizePair;
  /** Positive when the PTY is NARROWER than what we pushed — the direction
   *  that produces overflow fragments in the transcript's first columns. */
  deltaCols: number;
  deltaRows: number;
}

export interface WidthAgreementMonitor {
  /** Returns a Divergence the first time a given (handle, want, got) triple is
   *  seen, then null for repeats. The condition is sticky — it persists until
   *  something resizes again — so an un-deduped check would emit a warning
   *  every sweep for the life of the session and bury the signal it exists to
   *  raise. */
  check: (handleId: string, want: SizePair | undefined, got: SizePair | undefined) => Divergence | null;
  /** Drop a handle's dedupe state when its session goes away. */
  forget: (handleId: string) => void;
  /** Test/diagnostic view of how many distinct divergences have been raised. */
  readonly size: number;
}

export function createWidthAgreementMonitor(): WidthAgreementMonitor {
  const seen = new Set<string>();
  return {
    check(handleId, want, got) {
      // A backend that can't report its real size (container/broker, test
      // fakes) is not evidence of agreement — it's absence of evidence. Skip.
      if (!want || !got) return null;
      if (want.cols === got.cols && want.rows === got.rows) return null;
      const key = `${handleId}:${want.cols}x${want.rows}:${got.cols}x${got.rows}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        handleId,
        want,
        got,
        deltaCols: want.cols - got.cols,
        deltaRows: want.rows - got.rows
      };
    },
    forget(handleId) {
      for (const key of seen) {
        if (key.startsWith(`${handleId}:`)) seen.delete(key);
      }
    },
    get size() {
      return seen.size;
    }
  };
}
