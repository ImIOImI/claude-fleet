import { describe, it, expect } from 'vitest';
// @ts-expect-error — title.mjs is a plain ESM script in docker/qwen/, not part of the TS build.
// Vitest resolves .mjs imports at runtime; there is no @types stub.
import { titleFor } from '../../docker/qwen/title.mjs';

const firstGlyph = (osc: string) => [...osc.replace(/^\]0;/, '').replace(/$/, '').trim()][0];
const isBraille = (ch: string) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x2800 && c <= 0x28ff; };

describe('titleFor', () => {
  it('busy while an assistant turn is streaming (no turn_result yet)', () => {
    const osc = titleFor([JSON.stringify({ type: 'assistant' })]);
    expect(isBraille(firstGlyph(osc))).toBe(true);
  });
  it('idle after a turn_result / user-input-wait', () => {
    const osc = titleFor([JSON.stringify({ type: 'system', subtype: 'turn_result' })]);
    expect(isBraille(firstGlyph(osc))).toBe(false);
  });
});
