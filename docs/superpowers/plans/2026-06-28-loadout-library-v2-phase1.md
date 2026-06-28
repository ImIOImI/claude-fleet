# Loadout Library v2 — Phase 1 (local catalog + favorites + browser modal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global favorites set, an assembled-catalog IPC, a facet-sidebar browser modal, and rail favorite toggle + favorites filter — all against the **local** loadout library (no network).

**Architecture:** A pure `toggleFavorite` helper + `assembleCatalog` (already in `ociCore.ts`) carry the logic. A thin main-process `loadoutCatalog.ts` gathers inputs (local list, installed set, favorites) and calls `assembleCatalog`. Two new IPC channels (`loadouts:catalog`, `loadouts:setFavorite`) expose it. The renderer migrates `LibraryPane` onto the catalog and gains a favorite toggle + favorites filter; a new `LoadoutBrowserModal` is the full-catalog browser.

**Tech Stack:** Electron (main IPC), React + TypeScript (renderer), vitest (unit), Playwright (e2e). No new dependencies.

## Global Constraints

- **Phase 1 is local-only** — no network, no `ociClient`, no remote sources. `assembleCatalog` is called with `remote: []`. The `Update ↑` affordance and source checkboxes are **Phase 2** and out of scope here.
- **MCP server stays read-only** — all new IPC is host-side (`ipc.ts`), never an MCP tool (SPEC §7 invariant).
- **Favorites are global** — one set in `config.json` (`AppConfig.favorites`), shown in every workspace; install/installed state is per selected workspace.
- **Reuse the existing install/uninstall path untouched** (`installLoadout`/`uninstallLoadout`).
- **Catalog entry shape is `CatalogEntry` from `src/main/ociCore.ts`** (already defined + unit-tested) — do not redefine it.
- **Spec discipline:** update `docs/SPEC.md` §7 in the same change (the loadout library section); the Phase-1 parts move out of §11 Open decisions into the body, Phase 2 stays noted.
- Run unit tests with `npx vitest run <path>`; the full suite with `npm run test:unit`; typecheck with `npm run typecheck`.

---

### Task 1: Pure `toggleFavorite` helper

**Files:**
- Modify: `src/main/ociCore.ts` (append helper)
- Test: `src/main/ociCore.test.ts` (append describe block)

**Interfaces:**
- Produces: `toggleFavorite(favorites: string[], id: string, on: boolean): string[]` — returns a new de-duplicated array; adding is idempotent, removing absent is a no-op; order stable (existing order preserved, new id appended).

- [ ] **Step 1: Write the failing test** — append to `src/main/ociCore.test.ts`:

```ts
describe('toggleFavorite', () => {
  it('adds an id (idempotent) and removes it, de-duplicating', () => {
    expect(toggleFavorite([], 'a', true)).toEqual(['a']);
    expect(toggleFavorite(['a'], 'a', true)).toEqual(['a']); // idempotent add
    expect(toggleFavorite(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleFavorite(['a'], 'z', false)).toEqual(['a']); // remove absent = no-op
  });

  it('preserves existing order and appends new ids', () => {
    expect(toggleFavorite(['b', 'a'], 'c', true)).toEqual(['b', 'a', 'c']);
  });
});
```

Add `toggleFavorite` to the existing import at the top of the test file:
```ts
import {
  parseImageRef,
  loadoutRefFromSource,
  safeLayerPath,
  parseIndex,
  compareVersions,
  isUpdateAvailable,
  assembleCatalog,
  toggleFavorite
} from './ociCore';
```
(Match the actual existing import list; just add `toggleFavorite`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/ociCore.test.ts -t toggleFavorite`
Expected: FAIL — `toggleFavorite is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `src/main/ociCore.ts`:

```ts
/** Add or remove `id` from a favorites list, returning a new de-duplicated array.
 *  Adding is idempotent; removing an absent id is a no-op. Existing order is
 *  preserved and a newly-added id is appended. */
export function toggleFavorite(favorites: string[], id: string, on: boolean): string[] {
  const set = favorites.filter((f) => f !== id);
  if (on) set.push(id);
  return set;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/ociCore.test.ts -t toggleFavorite`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ociCore.ts src/main/ociCore.test.ts
git commit -m "feat(loadouts): pure toggleFavorite helper"
```

---

### Task 2: Favorites in app config

**Files:**
- Modify: `src/main/config.ts` (add `favorites` to `AppConfig` + a `setFavorite` helper)
- Test: `src/main/config.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: `toggleFavorite` (Task 1); existing `config.read()`/`config.write()` in `config.ts`.
- Produces: `AppConfig.favorites?: string[]`; `setFavorite(id: string, on: boolean): Promise<string[]>` (persists via `write`, returns the new list).

- [ ] **Step 1: Write the failing test** — `src/main/config.test.ts`. Mock the read/write so no real fs:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const store: { cfg: Record<string, unknown> } = { cfg: {} };
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/cf-test' } }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => JSON.stringify(store.cfg)),
  writeFile: vi.fn(async (_p: string, data: string) => {
    store.cfg = JSON.parse(data);
  }),
  mkdir: vi.fn(async () => undefined)
}));

const config = await import('./config');

describe('setFavorite', () => {
  beforeEach(() => {
    store.cfg = {};
    // reset the module-level cache so each test reads fresh
    config.__resetCacheForTests?.();
  });

  it('adds then removes a favorite, persisting to config', async () => {
    expect(await config.setFavorite('spec-driven', true)).toEqual(['spec-driven']);
    expect((await config.read()).favorites).toEqual(['spec-driven']);
    expect(await config.setFavorite('spec-driven', false)).toEqual([]);
  });
});
```

> Note: if `config.ts` already caches, add a tiny test-only `__resetCacheForTests` export (guard it with a comment that it exists only for tests) OR, if a reset hook already exists, use it. Match the file's existing test conventions if a `config.test.ts` already exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/config.test.ts`
Expected: FAIL — `setFavorite is not a function` (and/or missing `favorites`).

- [ ] **Step 3: Write minimal implementation** — in `src/main/config.ts`:

Add `favorites` to the `AppConfig` interface:
```ts
export interface AppConfig {
  fleetRoot?: string;
  disableHardwareAcceleration?: boolean;
  autoReloadLoadouts?: boolean;
  usageBudget?: number;
  /** Global loadout favorites (loadout ids), shown in every workspace's rail. */
  favorites?: string[];
}
```

Append the helper (import `toggleFavorite` from `./ociCore`):
```ts
import { toggleFavorite } from './ociCore.js';

/** Toggle a global loadout favorite and persist it. Returns the new list. */
export async function setFavorite(id: string, on: boolean): Promise<string[]> {
  const cfg = await read();
  const favorites = toggleFavorite(cfg.favorites ?? [], id, on);
  await write({ ...cfg, favorites });
  return favorites;
}
```
If the module caches config in a module-level variable, add (only if needed for the test):
```ts
/** Test-only: drop the in-memory config cache. */
export function __resetCacheForTests(): void {
  /* set the cache variable back to null/undefined here */
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts src/main/config.test.ts
git commit -m "feat(loadouts): global favorites in app config"
```

---

### Task 3: Main-process catalog builder

**Files:**
- Create: `src/main/loadoutCatalog.ts`
- Test: covered indirectly by Task 1's `assembleCatalog` tests + Task 7 e2e (this is thin I/O glue — no new logic to unit-test; keep it that way).

**Interfaces:**
- Consumes: `listLoadouts()` (`./loadouts`), `read()` (`./config`), `readWorkspaceManifest(id)` (`./workspaces`), `assembleCatalog` + `CatalogEntry` + `LocalLoadout` + `InstalledRef` (`./ociCore`).
- Produces: `buildLoadoutCatalog(workspaceId?: string): Promise<CatalogEntry[]>`.

- [ ] **Step 1: Create the module** — `src/main/loadoutCatalog.ts`:

```ts
// Assemble the loadout catalog for the renderer (browser modal + rail). Phase 1
// is local-only: the local library + the target workspace's installed set +
// global favorites, with no remote sources (assembleCatalog `remote` is []).
// Pure assembly lives in ociCore.ts:assembleCatalog; this is the I/O glue.

import { listLoadouts } from './loadouts.js';
import { read as readConfig } from './config.js';
import { readWorkspaceManifest } from './workspaces.js';
import { assembleCatalog, type CatalogEntry, type LocalLoadout, type InstalledRef } from './ociCore.js';

export async function buildLoadoutCatalog(workspaceId?: string): Promise<CatalogEntry[]> {
  const [summaries, cfg] = await Promise.all([listLoadouts(), readConfig()]);
  const local: LocalLoadout[] = summaries.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    tags: s.tags
    // version omitted — local list carries none; update detection is Phase 2.
  }));
  let installed: InstalledRef[] = [];
  if (workspaceId) {
    const ws = await readWorkspaceManifest(workspaceId);
    installed = (ws?.installedLoadouts ?? []).map((l) => ({
      id: l.id,
      version: (l as { version?: string }).version
    }));
  }
  return assembleCatalog({ local, installed, favorites: cfg.favorites ?? [] });
}
```

> Adjust the `read` import name to match `config.ts`'s actual export (the explore shows `read`/`write`). If `listLoadouts` is a named export under a namespace import elsewhere (e.g. `import * as loadouts`), match the existing convention in `ipc.ts`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:node`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/main/loadoutCatalog.ts
git commit -m "feat(loadouts): main-process catalog builder (local-only)"
```

---

### Task 4: IPC channels + preload

**Files:**
- Modify: `src/main/ipc.ts` (register two handlers near the existing `loadouts:*` block, ~line 877)
- Modify: `src/preload/index.ts` (extend the `loadouts` API, ~line 323)

**Interfaces:**
- Consumes: `buildLoadoutCatalog` (Task 3), `setFavorite` (Task 2).
- Produces (preload): `window.api.loadouts.catalog(workspaceId?: string): Promise<CatalogEntry[]>` and `window.api.loadouts.setFavorite(id: string, on: boolean): Promise<string[]>`.

- [ ] **Step 1: Register IPC** — in `src/main/ipc.ts`, add to the loadouts handler block:

```ts
ipcMain.handle('loadouts:catalog', (_e, workspaceId?: string) => buildLoadoutCatalog(workspaceId));
ipcMain.handle('loadouts:setFavorite', (_e, id: string, on: boolean) => setFavorite(id, on));
```
Add imports at the top of `ipc.ts`:
```ts
import { buildLoadoutCatalog } from './loadoutCatalog.js';
import { setFavorite } from './config.js';
```
(If `config` is imported as a namespace, use `config.setFavorite` instead.)

- [ ] **Step 2: Extend preload** — in `src/preload/index.ts`, inside the `loadouts:` object, add a shared catalog-entry type and two methods:

```ts
catalog: (
  workspaceId?: string
): Promise<
  Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    version: string;
    remoteVersion?: string;
    present: boolean;
    installed: boolean;
    installedVersion?: string;
    updateAvailable: boolean;
    favorited: boolean;
    sources: string[];
  }>
> => ipcRenderer.invoke('loadouts:catalog', workspaceId),
setFavorite: (id: string, on: boolean): Promise<string[]> =>
  ipcRenderer.invoke('loadouts:setFavorite', id, on),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(loadouts): catalog + setFavorite IPC + preload"
```

---

### Task 5: LibraryPane — catalog data, favorite toggle, favorites filter

**Files:**
- Modify: `src/renderer/src/components/LibraryPane.tsx`

**Interfaces:**
- Consumes: `window.api.loadouts.catalog`, `window.api.loadouts.setFavorite`.
- Produces: a `CatalogEntry`-shaped row type used locally; a `favOnly` filter state; an `onBrowse` prop hook (wired in Task 6) — add `onBrowse?: () => void` to `Props`.

- [ ] **Step 1: Switch the data source to the catalog.** Replace the `loadouts` fetch (currently `window.api.loadouts.list()`, ~line 64) with `window.api.loadouts.catalog(selectedWorkspace?.id)`, storing the result as `entries`. Re-fetch when `selectedWorkspace?.id` changes. Derive `installedIds` from `entries.filter(e => e.installed)` instead of from the prop (the catalog now carries it). Keep a local type:

```ts
type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];
const [entries, setEntries] = useState<Entry[]>([]);
const [favOnly, setFavOnly] = useState(false);

const reload = useCallback(async () => {
  setEntries(await window.api.loadouts.catalog(selectedWorkspace?.id));
}, [selectedWorkspace?.id]);
useEffect(() => { void reload(); }, [reload]);
```
Update `doInstall`/`doUninstall`/`onChanged` paths to call `void reload()` after mutating so favorited/installed state refreshes.

- [ ] **Step 2: Add the favorites filter toggle** beside the Tags dropdown (in `.library-filter`):

```tsx
<button
  type="button"
  className={`fav-filter ${favOnly ? 'on' : ''}`}
  aria-pressed={favOnly}
  title="Show favorites only"
  onClick={() => setFavOnly((v) => !v)}
>
  {favOnly ? '★' : '☆'}
</button>
```
Fold it into the `filtered` computation:
```ts
const filtered = entries.filter((e) => {
  if (favOnly && !e.favorited) return false;
  if (activeTags.length && !activeTags.every((t) => e.tags.includes(t))) return false;
  if (query && !(`${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase()))) return false;
  return true;
});
```
(Match the existing query/tag semantics already in the file; just add the `favOnly` clause.)

- [ ] **Step 3: Add the expanded-only favorite toggle** in the card body (render only when `!isCollapsed`, after the tags row). Use the entry `e` in place of `l`:

```tsx
{!isCollapsed && (
  <button
    type="button"
    className={`lc-fav ${e.favorited ? 'on' : ''}`}
    onClick={async (ev) => {
      ev.stopPropagation();
      await window.api.loadouts.setFavorite(e.id, !e.favorited);
      void reload();
    }}
  >
    {e.favorited ? '★ Favorited' : '☆ Favorite'}
  </button>
)}
```

- [ ] **Step 4: Add a "Browse all" entry point** in the search row that calls `onBrowse?.()` (wired in Task 6):

```tsx
<button type="button" className="btn btn-sm lib-browse" onClick={() => onBrowse?.()}>
  Browse all
</button>
```

- [ ] **Step 5: Typecheck + run the existing unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/LibraryPane.tsx
git commit -m "feat(loadouts): rail catalog data + favorite toggle + favorites filter"
```

---

### Task 6: Browser modal (facet sidebar)

**Files:**
- Create: `src/renderer/src/components/LoadoutBrowserModal.tsx`
- Modify: `src/renderer/src/App.tsx` (mount the modal + `browseOpen` state; pass `onBrowse` into the rail → LibraryPane)
- Modify: `src/renderer/src/components/LeftRail.tsx` (thread `onBrowse` to `LibraryPane`)

**Interfaces:**
- Consumes: `window.api.loadouts.catalog`, `setFavorite`, `install`, `uninstall`; the `CatalogEntry` shape.
- Produces: `LoadoutBrowserModal` default export with props `{ workspace: WorkspaceSummary | null; onClose: () => void; onChanged: () => void }`.

- [ ] **Step 1: Create the modal** — `src/renderer/src/components/LoadoutBrowserModal.tsx`. Facet sidebar (Phase 1: tag cloud + search; **no source checkboxes** — those are Phase 2) + results list with one action each (`+ Install` / `✓ Installed`) and a favorite ★. Follow the existing `.modal-backdrop`/`.modal` pattern from `LoadoutReviewModal.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';

type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];

interface Props {
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function LoadoutBrowserModal({ workspace, onClose, onChanged }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const installable = !!workspace && workspace.kind === 'container' && !!workspace.containerId;

  const reload = useCallback(async () => {
    setEntries(await window.api.loadouts.catalog(workspace?.id));
  }, [workspace?.id]);
  useEffect(() => { void reload(); }, [reload]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }, [entries]);

  const filtered = entries.filter((e) => {
    if (activeTags.length && !activeTags.every((t) => e.tags.includes(t))) return false;
    if (query && !`${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const toggleTag = (t: string): void =>
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const onInstall = async (id: string): Promise<void> => {
    if (workspace) await window.api.loadouts.install(workspace.id, id);
    onChanged();
    void reload();
  };
  const onFav = async (e: Entry): Promise<void> => {
    await window.api.loadouts.setFavorite(e.id, !e.favorited);
    void reload();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal loadout-browser" onClick={(ev) => ev.stopPropagation()}>
        <div className="lb-head">
          <span className="eyebrow">Loadouts · browse</span>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="lb-body">
          <aside className="lb-facets">
            <input
              className="lb-search"
              placeholder="Search loadouts…"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
            <div className="lb-tagcloud">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`lb-tag ${activeTags.includes(t) ? 'on' : ''}`}
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </aside>
          <ul className="lb-results">
            {filtered.map((e) => (
              <li key={e.id} className="lb-row">
                <div className="lb-row-main">
                  <span className="lb-row-title">{e.title}</span>
                  {e.tags.length > 0 && (
                    <span className="tags">
                      {e.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
                    </span>
                  )}
                  {e.description && <span className="lb-row-desc">{e.description}</span>}
                </div>
                <div className="lb-row-actions">
                  <button
                    type="button"
                    className={`lc-fav ${e.favorited ? 'on' : ''}`}
                    title="Favorite"
                    onClick={() => void onFav(e)}
                  >
                    {e.favorited ? '★' : '☆'}
                  </button>
                  {e.installed ? (
                    <button className="btn installed btn-sm" disabled>✓ Installed</button>
                  ) : (
                    <button
                      className="btn primary btn-sm"
                      disabled={!installable}
                      onClick={() => void onInstall(e.id)}
                    >
                      + Install
                    </button>
                  )}
                </div>
              </li>
            ))}
            {filtered.length === 0 && <li className="lb-empty">No loadouts match.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in App.tsx.** Add state `const [browseOpen, setBrowseOpen] = useState(false);` (near the other modal state, ~line 157). Mount near the other modals:

```tsx
{browseOpen && (
  <LoadoutBrowserModal
    workspace={selectedWorkspace}
    onClose={() => setBrowseOpen(false)}
    onChanged={() => void refreshWorkspaces()}
  />
)}
```
(Use the app's existing workspace-refresh function in place of `refreshWorkspaces` — match what `onChanged` does elsewhere, e.g. the same callback `LeftRail` already receives.) Add the import:
```tsx
import LoadoutBrowserModal from './components/LoadoutBrowserModal';
```
Pass an `onBrowse` down to the rail: find where `<LeftRail .../>` is mounted (~line 933) and add `onBrowse={() => setBrowseOpen(true)}`.

- [ ] **Step 3: Thread `onBrowse` through LeftRail.** In `LeftRail.tsx`, add `onBrowse?: () => void` to its props and pass it into `<LibraryPane ... onBrowse={onBrowse} />`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/LoadoutBrowserModal.tsx src/renderer/src/components/LeftRail.tsx src/renderer/src/App.tsx
git commit -m "feat(loadouts): facet-sidebar browser modal (local catalog)"
```

---

### Task 7: Styles, e2e, SPEC

**Files:**
- Modify: `src/renderer/src/styles.css`
- Modify: `tests/workspace-modal.spec.ts` OR create `tests/loadout-library.spec.ts` (favorites + browse flow)
- Modify: `docs/SPEC.md` (§7 loadout library; move Phase-1 parts out of §11 Open decisions)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add styles** — append to `src/renderer/src/styles.css`, reusing existing tokens (`--ok`, `--rule`, `--bg-3`, `--ink-2`, `--r-sm`, `--r-md`):

```css
/* Loadout favorites + browser (library v2 Phase 1) */
.fav-filter { padding: 3px 8px; font-size: 13px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-3); color: var(--ink-2); cursor: pointer; }
.fav-filter.on { color: var(--ok); border-color: var(--ok); }
.lc-fav { align-self: flex-start; padding: 2px 7px; font-size: 11px; background: none; border: 1px solid var(--rule); border-radius: var(--r-sm); color: var(--ink-2); cursor: pointer; }
.lc-fav.on { color: var(--ok); border-color: var(--ok); }
.lib-browse { margin-left: auto; }

.modal.loadout-browser { width: 720px; max-width: 94vw; max-height: 86vh; display: flex; flex-direction: column; }
.lb-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.lb-body { display: grid; grid-template-columns: 200px 1fr; gap: 14px; min-height: 0; overflow: hidden; }
.lb-facets { display: flex; flex-direction: column; gap: 10px; }
.lb-search { width: 100%; }
.lb-tagcloud { display: flex; flex-wrap: wrap; gap: 5px; }
.lb-tag { padding: 2px 8px; font-size: 11px; border: 1px solid var(--rule); border-radius: 999px; background: var(--bg-3); color: var(--ink-2); cursor: pointer; }
.lb-tag.on { color: var(--ok); border-color: var(--ok); }
.lb-results { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.lb-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 8px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-3); }
.lb-row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lb-row-title { font-weight: 600; color: var(--ink); }
.lb-row-desc { font-size: 11px; color: var(--ink-2); }
.lb-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.lb-empty { color: var(--ink-2); font-size: 12px; padding: 8px; }
```

- [ ] **Step 2: Write the e2e** — `tests/loadout-library.spec.ts`. Seed a workspace + at least one built-in loadout is available (the mock `loadouts:list`/`catalog` must return entries — check `_helpers.ts` for a `loadoutList` option; if none exists, add a `loadoutCatalog` mock option mirroring the `workspaceList` pattern). Assert: opening the rail Library shows cards; clicking the expanded favorite toggle calls `setFavorite` and the ★ filter narrows the list; "Browse all" opens the modal and it lists the same loadouts.

```ts
import { test, expect } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers.js';

test('Library: favorite toggle + favorites filter + browse modal', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [/* one running container workspace */],
      loadoutCatalog: [
        { id: 'spec-driven', title: 'Spec-Driven', description: 'x', tags: ['workflow'], version: '', present: true, installed: false, updateAvailable: false, favorited: false, sources: [] }
      ]
    });
    // open the Library rail section, expand the card, click favorite, assert filter, open Browse all.
    // (Fill in selectors from the rendered classes: .loadout-card, .lc-fav, .fav-filter, .lib-browse, .loadout-browser)
  } finally {
    await app.close();
  }
});
```

> If extending `_helpers.ts`: add a `loadoutCatalog?` option and register `ipcMain.handle('loadouts:catalog', () => opts.loadoutCatalog ?? [])` and `ipcMain.handle('loadouts:setFavorite', (_e, _id, _on) => [])`, mirroring the existing `workspaceList`/`writeManifest` handlers. Capture `setFavorite` calls in `g.__calls` for assertion.

- [ ] **Step 3: Run e2e locally if the harness runs; otherwise rely on CI.**

Run: `npm run build && npx playwright test tests/loadout-library.spec.ts` (may be display-blocked in sandbox — then rely on CI).

- [ ] **Step 4: Update SPEC §7.** In `docs/SPEC.md`, document the catalog IPC (`loadouts:catalog`, `loadouts:setFavorite`), the global `config.json` favorites, the rail favorite toggle + favorites filter, and the browser modal (local catalog). Edit the §11 "Loadout library v2" Open-decisions entry to say **Phase 1 (local catalog + favorites + browser modal) is implemented; Phase 2 (remote OCI sources + index + update detection + paired loadouts-repo publish) remains.**

- [ ] **Step 5: Full verify + commit**

```bash
npm run typecheck && npm run test:unit && npm run build
git add -A
git commit -m "feat(loadouts): styles + e2e + SPEC for library v2 phase 1"
```

---

## Self-review notes

- **Spec coverage (Phase 1 rows of the design):** favorites global (Tasks 1–2, config), catalog assembly reuse (Task 3), catalog + setFavorite IPC (Task 4), rail favorite toggle + favorites filter (Task 5), facet-sidebar browser modal (Task 6), styles/e2e/SPEC (Task 7). `Update ↑` + source checkboxes + `ociClient` + `loadoutSources` + index artifact are **Phase 2** — deliberately excluded; the catalog already carries `updateAvailable`/`remoteVersion`/`sources` so Phase 2 is additive.
- **Type consistency:** the renderer's local `Entry` is derived from `window.api.loadouts.catalog`'s return (single source of truth), which mirrors `ociCore.ts:CatalogEntry`. `toggleFavorite` signature is identical in Tasks 1, 2.
- **No new deps; MCP stays read-only; downloads/network are Phase 2** (no §9 surface change in Phase 1).
