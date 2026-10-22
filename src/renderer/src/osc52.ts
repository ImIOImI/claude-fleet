// OSC 52 (set clipboard) decoding for the terminal.
//
// A TUI that can't find a native clipboard tool falls back to asking the
// *terminal* to set the clipboard: `ESC ] 52 ; <targets> ; <base64> BEL`.
// claude does exactly this for its own copy (fullscreen selection + Ctrl+C,
// `/copy`) when xclip/wl-copy/pbcopy/PowerShell are absent — which is always
// the case inside the runner container. xterm.js ignores OSC 52 unless told
// otherwise, so without a handler those copies vanish silently. WSL-local
// sessions never hit this: claude reaches the Windows clipboard via interop.
//
// Write-only on purpose: a `?` payload is a clipboard *read* request, and
// answering it would let anything in the container read the host clipboard.
//
// Kept as a pure function (no xterm / DOM deps) so it's unit-tested directly.

/** Largest base64 payload accepted (~768 KB of text). Bigger is ignored. */
export const OSC52_MAX_BASE64 = 1024 * 1024;

/**
 * Decode an OSC 52 payload (the part after `52;`, i.e. `<targets>;<data>`)
 * into the text to put on the clipboard, or `null` to ignore it: a read
 * query (`?`), an empty or oversized payload, or invalid base64 / UTF-8.
 */
export function decodeOsc52(payload: string): string | null {
  const sep = payload.indexOf(';');
  if (sep < 0) return null;
  const data = payload.slice(sep + 1).trim();
  if (!data || data === '?' || data.length > OSC52_MAX_BASE64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
