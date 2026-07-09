/**
 * Injecting a message into a running `claude` PTY (committee post, #120).
 *
 * The naive approach — writing `message + '\r'` in a single chunk — does NOT
 * submit. Claude Code's TUI input composer treats a chunk that contains text
 * followed by a carriage return as a *paste*, so the `\r` is absorbed as a
 * literal newline in the composer and the message just sits there until a human
 * presses Enter separately. That defeats hands-free committee orchestration.
 *
 * To submit reliably we mimic what a real terminal does on paste-then-Enter:
 *
 *   1. Write the message wrapped in bracketed-paste markers, so a multi-line
 *      body is inserted verbatim and the TUI knows it's pasted content.
 *   2. Flush, wait a beat, then write a lone `\r` as a *discrete* Enter keypress
 *      — a separate write the TUI reads as a submit rather than paste content.
 */

/** Bracketed-paste start marker (ESC [ 200 ~). */
export const PASTE_START = '\x1b[200~';
/** Bracketed-paste end marker (ESC [ 201 ~). */
export const PASTE_END = '\x1b[201~';

/**
 * Gap between the pasted payload and the submit keystroke. Long enough that the
 * TUI processes the paste as its own event before the Enter arrives, short
 * enough to stay imperceptible in the committee loop.
 */
export const SUBMIT_DELAY_MS = 40;

/**
 * Inject `text` into a PTY via `write`, then submit it with a discrete Enter.
 *
 * `write` receives raw strings to feed to the PTY's stdin (the caller adapts it
 * to a Node stream, a broker INPUT frame, etc.). The returned promise resolves
 * once the submit keystroke has been written.
 */
export async function injectAndSubmit(
  write: (chunk: string) => void,
  text: string
): Promise<void> {
  write(`${PASTE_START}${text}${PASTE_END}`);
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
  write('\r');
}
