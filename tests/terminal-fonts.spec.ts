// The terminal pane bundles two subsetted symbol fonts (styles.css @font-face)
// so Claude Code's TUI glyphs render on Linux/WSLg, whose fontconfig set has no
// glyph for them — the permission-mode media triangles (⏵, U+23F5) and the
// tool-result tree connector (⎿, U+23BF). This guards that wiring: if a font
// file is renamed/moved or the @font-face is dropped, document.fonts.load fails.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers.js';

test('bundled terminal symbol fonts load (Claude TUI glyphs the host lacks)', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    // FontFaceSet.load() matches the @font-face rules by family and fetches
    // them; a resolved non-empty array means the bundled data: URI was found
    // and passed Chrome's font sanitizer (OTS). Rejects ("network error") if a
    // file is missing/renamed or the woff2 is malformed — the regression guard.
    const counts = await window.evaluate(async () => ({
      noto: (await document.fonts.load('13px "Noto Sans Symbols 2"')).length,
      uni: (await document.fonts.load('13px "Unifont"')).length
    }));
    expect(counts.noto).toBeGreaterThan(0);
    expect(counts.uni).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
