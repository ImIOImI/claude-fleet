# Bundled terminal fonts — attribution

These are **subsets** (Miscellaneous Technical block, U+2300–U+23FF only) used as
`@font-face` fallbacks in the terminal pane so Claude Code's TUI glyphs render on
systems whose fonts lack them (notably Linux/WSLg). See `src/renderer/src/styles.css`
and `TERMINAL_FONT_FAMILY` in `TerminalSession.tsx`.

## NotoSansSymbols2-misc-technical.woff2
- Source: **Noto Sans Symbols 2**, © The Noto Project Authors.
- License: SIL Open Font License 1.1 — https://openfontlicense.org
- Upstream: https://github.com/google/fonts/tree/main/ofl/notosanssymbols2

## Unifont-misc-technical.woff2
- Source: **GNU Unifont** (unifont-16.0.04), © Roman Czyborra, Paul Hardy, et al.
- License: SIL Open Font License 1.1 (also available under GPLv2+ with the GNU
  font embedding exception) — https://openfontlicense.org
- Upstream: https://unifoundry.com/unifont/

Subsetting: `pyftsubset <font> --unicodes='2300-23FF' --flavor=woff2`. For Unifont,
its source `OS/2` unicode-range bits were zeroed first (an out-of-spec bit makes
both fontTools pruning and Chrome's OTS sanitizer reject the output).
