// Level-triggered backstop for the busy indicator (#283). The busy flag is
// edge-sourced — it flips on claude's terminal-title changes — and claude
// writes the idle title exactly once, so an idle edge lost anywhere upstream
// (ConPTY is documented dropping/coalescing title writes) would leave the flag
// wrong until the next real turn, possibly forever. The corrective is a level
// signal we can always observe: a genuinely busy claude re-asserts its spinner
// title roughly once a second, and every re-assert is PTY output. Busy plus
// prolonged PTY silence therefore means the flag is stale; clearing it turns a
// permanently wrong indicator into a briefly stale one, and a real busy state
// re-asserts itself within ~1s via the next spinner frame.

/** PTY silence after which a busy flag is considered stale. ~10× the spinner
 *  cadence, so a slow frame never flickers the chip. */
export const BUSY_SILENCE_TIMEOUT_MS = 10_000;

/** True when a busy flag has outlived any plausible real activity. */
export function busyFlagIsStale(busy: boolean, lastOutputAt: number, now: number): boolean {
  return busy && now - lastOutputAt >= BUSY_SILENCE_TIMEOUT_MS;
}
