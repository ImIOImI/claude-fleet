# Design folder

The hi-fi visual reference for claude-fleet, exported from v0-style design
tooling and unpacked into readable artboards.

## Files

- `claude-fleet-hi-fi.html` — the original packed export. Open it in a
  browser to see the rendered mockup; it self-decompresses on load.
- `tokens.css` — the canonical design-token stylesheet pulled out of the
  export's runtime template. Light + dark theme variables (`--bg`,
  `--ink`, per-container accents `--c1`/`--c2`/`--c3`, semantic
  `--ok`/`--warn`/`--danger`, etc.). Use these names when adding to
  `src/renderer/src/styles.css` so the implementation stays aligned
  with the design.
- `components/` — the artboards as readable React/JSX (one file each).
- `extract.mjs` — the unpacker that produced `components/` and
  `tokens.css`. Re-run it after replacing the HTML to keep everything
  in sync:
  ```
  node design/extract.mjs
  ```
  Vendor bundles (React, ReactDOM, Babel), woff2 fonts, and tiny stub
  entries are filtered out.

## Artboards (11)

Each file under `components/` is a single React/JSX artboard from the
export. The first comment block in each file is the design author's note
on what the artboard shows.

| File | Header |
|---|---|
| [`designcanvas.jsx`](components/designcanvas.jsx) | DesignCanvas.jsx — Figma-ish design canvas wrapper |
| [`hi-fi-canvas.jsx`](components/hi-fi-canvas.jsx) | Hi-fi canvas — lays out all the polished artboards in one Design Canvas, |
| [`hi-fi-icon-library.jsx`](components/hi-fi-icon-library.jsx) | Hi-fi icon library — minimal line icons, inline SVG. |
| [`hi-fi-modals.jsx`](components/hi-fi-modals.jsx) | Hi-fi modals, overlays, empty states. |
| [`hi-fi-observability-rail.jsx`](components/hi-fi-observability-rail.jsx) | Hi-fi observability rail. |
| [`hi-fi-root-app-composition.jsx`](components/hi-fi-root-app-composition.jsx) | Hi-fi root app composition. |
| [`hi-fi-sessions-sidebar.jsx`](components/hi-fi-sessions-sidebar.jsx) | Hi-fi sessions sidebar. |
| [`hi-fi-shared-primitives.jsx`](components/hi-fi-shared-primitives.jsx) | Hi-fi shared primitives: theme context, mock data, base components used |
| [`hi-fi-terminal-pane.jsx`](components/hi-fi-terminal-pane.jsx) | Hi-fi terminal pane. |
| [`hi-fi-top-bar.jsx`](components/hi-fi-top-bar.jsx) | Hi-fi top bar — app mark, container picker (the row of chips), and |
| [`tweaks-panel.jsx`](components/tweaks-panel.jsx) | tweaks-panel.jsx |

## How to use this in code

These artboards aren't built or imported — they're a static visual
reference. When implementing a UI piece, find the matching artboard
and copy structure / class names / inline styles from it. The canonical
implementation lives under `src/renderer/`; the artboards are the
*design intent*, not authoritative code.

If a token from `tokens.css` isn't yet in `src/renderer/src/styles.css`,
lift it in when you reach for it — keep names consistent so a future
search across both folders matches.
