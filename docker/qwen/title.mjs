// Emits the OSC-2 title fleet's activityDetector reads: braille first glyph = busy.
//
// activityDetector.ts (src/renderer/src/activityDetector.ts) treats a leading
// codepoint in 0x2800–0x28FF as busy (braille spinner). This module produces
// the right glyph based on qwen's JSONL record stream so the fleet UI chip
// reflects qwen activity without fleet knowing qwen's TUI layout.
//
// Idle signal: the only confirmed real qwen-code idle subtype is 'turn_result'
// (verified from QwenLM/qwen-code chatRecordingService.ts 2026-08-24).
// 'user_input_wait' is kept for forward-compat (it's a claude-code concept;
// qwen may add it later — if never seen it's harmless).

/**
 * Scan a batch of raw qwen JSONL lines and return an OSC-2 title string.
 * First codepoint ∈ U+2800–U+28FF → busy (braille spinner ⠁).
 * Otherwise → idle (✳ U+2733, matching claude's idle glyph).
 *
 * @param {string[]} lines — raw JSONL strings from the current pump batch
 * @returns {string} — e.g. `]0;⠁ qwen` or `]0;✳ qwen`
 */
export function titleFor(lines) {
  let busy = false;
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === 'assistant') busy = true;
    if (r.type === 'system' && (r.subtype === 'turn_result' || r.subtype === 'user_input_wait')) busy = false;
  }
  const glyph = busy ? '⠁' : '✳'; // ⠁ U+2801 busy / ✳ U+2733 idle (matches claude's idle glyph)
  return `]0;${glyph} qwen`;
}
