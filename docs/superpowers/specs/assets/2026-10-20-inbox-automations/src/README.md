# Rebuilding the inbox/automations mocks

`fleet-inbox-mocks.html` is generated. The app chrome (tab strip, rails, terminal tabs,
Settings and Edit-workspace modals) is server-rendered from the real React components;
everything new is hand-built in `build-page.mjs` using only the app's design tokens.

1. Bundle and run each SSR entry (`ssr.tsx`, `ssr2.tsx`, `ssr3.tsx`) with `build.mjs`
   (esbuild; stubs `@xterm/*`, CSS and font imports), writing `chrome.json`,
   `chrome2.json` and `chrome3.json`. Run with minimal `window` / `localStorage` /
   `navigator` / `matchMedia` globals (and a no-op `window.api` proxy for `ssr3`).
2. `node build-page.mjs` reads those JSON files plus `src/renderer/src/styles.css` and
   writes `fleet-inbox-mocks.html`.

Paths in the scripts are absolute to the authoring worktree; adjust before rerunning.
