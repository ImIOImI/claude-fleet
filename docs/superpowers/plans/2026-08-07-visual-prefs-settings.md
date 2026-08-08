# Visual Preferences in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four display preferences to the settings modal — show/hide the plan-usage budget bar (right rail), show/hide per-session cost (left rail), and two sessions-list filters (max count, max age) — persisted as `uiPrefs` in `<userData>/config.json`.

**Architecture:** New `uiPrefs` key in the main-process config module (getter resolves defaults, setter shallow-merges), exposed through the existing `config:get` IPC payload plus one new `config:setUiPrefs` channel. Renderer consumption is prop-plumbing: App.tsx holds `uiPrefs` state and gates the budget-bar render + its poll; SessionsPane hides the cost badge and applies a new pure `limitSessions()` helper from `sessionsView.ts`. Spec: `docs/superpowers/specs/2026-08-07-visual-prefs-settings-design.md`.

**Tech Stack:** Electron main (Node, plain fs JSON config), typed `contextBridge` preload, React renderer, vitest for pure modules.

## Global Constraints

- **Work in the worktree:** `/workspace/claude-fleet/.claude/worktrees/visual-prefs-settings` (branch `worktree-visual-prefs-settings`). Run every command from this directory. NEVER `cd /workspace/claude-fleet` (that's the main checkout on a different branch).
- **One-time setup:** the worktree has no `node_modules`. Symlink the main checkout's (it already has the prebuilt better-sqlite3 + electron stub fixes that make vitest runnable in this container):
  ```bash
  ln -s ../../../node_modules /workspace/claude-fleet/.claude/worktrees/visual-prefs-settings/node_modules
  ```
- **Verification gate (no display in this container, no e2e):** `npm run typecheck` + `npx vitest run <touched test files>` per task; full `npm run test:unit` + `npm run build` in the final task. The PR must say UI was not visually verified in-container (Troy eyeballs on host).
- **Defaults preserve current behavior:** absent `uiPrefs` ⇒ both toggles `true`, both filters `0` (unlimited). `0` means "unlimited" for both numeric prefs.
- **Spec-maintenance rule:** the SPEC.md edits (Task 2) land **in the same commit** as the IPC/data-model change.
- Copy/naming: section header **"Display"**; control labels exactly — "Show plan-usage budget in the observability rail", "Show session cost in the sessions list", "Max sessions shown", "Max session age".

---

### Task 1: `uiPrefs` in the main-process config module

**Files:**
- Modify: `src/main/config.ts`
- Test: `src/main/config.test.ts`

**Interfaces:**
- Consumes: existing `read()`/`write()` config cache helpers (internal to config.ts).
- Produces: `export interface UiPrefs { showBudgetBar: boolean; showSessionCost: boolean; maxSessions: number; maxSessionAgeDays: number }`, `export async function getUiPrefs(): Promise<UiPrefs>`, `export async function setUiPrefs(partial: Partial<UiPrefs>): Promise<void>`. Task 2 imports all three.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/config.test.ts` (add `getUiPrefs, setUiPrefs` to the existing destructured `await import('./config.js')` block at the top of the file):

```ts
describe('get/setUiPrefs', () => {
  it('defaults everything to visible/unlimited when unset', async () => {
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: true,
      showSessionCost: true,
      maxSessions: 0,
      maxSessionAgeDays: 0
    });
  });

  it('merges partial writes — setting one key preserves the others', async () => {
    await setUiPrefs({ showBudgetBar: false });
    await setUiPrefs({ maxSessions: 25 });
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: false,
      showSessionCost: true,
      maxSessions: 25,
      maxSessionAgeDays: 0
    });
  });

  it('an explicit false survives a fresh read from disk', async () => {
    await setUiPrefs({ showSessionCost: false, maxSessionAgeDays: 7 });
    _resetConfigCacheForTests();
    const p = await getUiPrefs();
    expect(p.showSessionCost).toBe(false);
    expect(p.maxSessionAgeDays).toBe(7);
  });

  it('rounds fractional filter values and rejects negatives (keeps prior value)', async () => {
    await setUiPrefs({ maxSessions: 25.7 });
    expect((await getUiPrefs()).maxSessions).toBe(26);
    await setUiPrefs({ maxSessions: -5 });
    expect((await getUiPrefs()).maxSessions).toBe(26); // negative rejected, prior kept
  });

  it('preserves a non-preset value verbatim (hand-edited config.json)', async () => {
    await setUiPrefs({ maxSessions: 42 });
    _resetConfigCacheForTests();
    expect((await getUiPrefs()).maxSessions).toBe(42);
  });

  it('ignores a malformed persisted uiPrefs, falling back to defaults', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ uiPrefs: { showBudgetBar: 'nope', maxSessions: 'many' } }),
      'utf8'
    );
    _resetConfigCacheForTests();
    expect(await getUiPrefs()).toEqual({
      showBudgetBar: true,
      showSessionCost: true,
      maxSessions: 0,
      maxSessionAgeDays: 0
    });
  });

  it('does not clobber the other settings', async () => {
    const root = join(userDataDir, 'fleet');
    await setFleetRoot(root);
    await setUsageBudget('max5', 9_000_000);
    await setUiPrefs({ showBudgetBar: false });
    expect(await getFleetRoot()).toBe(root);
    expect((await getUsageBudget()).preset).toBe('max5');
    expect((await getUiPrefs()).showBudgetBar).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/config.test.ts`
Expected: FAIL — `getUiPrefs is not a function` (7 new tests failing, all pre-existing tests still passing).

- [ ] **Step 3: Implement in `src/main/config.ts`**

Add after the `ResolvedUsageBudget` interface (line ~52):

```ts
/** Visual/display preferences (#TBD-issue): pure UI toggles + left-rail
 *  session filters. All display-only — tracking and the DB are unaffected.
 *  0 means "unlimited" for both numeric filters. */
export interface UiPrefs {
  showBudgetBar: boolean;
  showSessionCost: boolean;
  maxSessions: number;
  maxSessionAgeDays: number;
}
```

Add `uiPrefs?: Partial<UiPrefs>;` to the `AppConfig` interface (after `favorites?: string[];`), with the comment `/** Display preferences; partial on disk — getUiPrefs() resolves defaults. */`.

Add after `parseUsageBudget()`:

```ts
/** Defensively parse persisted/incoming uiPrefs (untrusted JSON). Keeps only
 *  well-typed keys: booleans as-is; numbers rounded, negatives rejected. */
function parseUiPrefs(v: unknown): Partial<UiPrefs> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<UiPrefs> = {};
  if (typeof o.showBudgetBar === 'boolean') out.showBudgetBar = o.showBudgetBar;
  if (typeof o.showSessionCost === 'boolean') out.showSessionCost = o.showSessionCost;
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined;
  const maxSessions = num(o.maxSessions);
  if (maxSessions !== undefined) out.maxSessions = maxSessions;
  const maxSessionAgeDays = num(o.maxSessionAgeDays);
  if (maxSessionAgeDays !== undefined) out.maxSessionAgeDays = maxSessionAgeDays;
  return Object.keys(out).length > 0 ? out : undefined;
}
```

In `read()`, add to the `cached = { ... }` literal (after `usageBudget: ...`):

```ts
      uiPrefs: parseUiPrefs(parsed.uiPrefs)
```

Add after `setUsageBudget()`:

```ts
/** Display preferences, resolved for the renderer: absent toggles default to
 *  shown, absent filters to 0 (unlimited) — so existing installs see no change. */
export async function getUiPrefs(): Promise<UiPrefs> {
  const cfg = await read();
  return {
    showBudgetBar: cfg.uiPrefs?.showBudgetBar !== false,
    showSessionCost: cfg.uiPrefs?.showSessionCost !== false,
    maxSessions: cfg.uiPrefs?.maxSessions ?? 0,
    maxSessionAgeDays: cfg.uiPrefs?.maxSessionAgeDays ?? 0
  };
}

/** Shallow-merge a partial update into the stored uiPrefs. Invalid values are
 *  dropped by parseUiPrefs (prior/default value wins), never written. */
export async function setUiPrefs(partial: Partial<UiPrefs>): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, uiPrefs: { ...cfg.uiPrefs, ...parseUiPrefs(partial) } });
}
```

(Replace `#TBD-issue` in the UiPrefs doc comment with the issue number the spec auto-issue hook filed for the design spec — check `gh issue list --limit 5 --search "visual preferences"`; if none exists, drop the reference.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/config.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts src/main/config.test.ts
git commit -m "feat(config): uiPrefs — display toggles + session-list filters"
```

---

### Task 2: IPC channel + preload API + SPEC.md (single commit)

**Files:**
- Modify: `src/main/ipc.ts` (config handlers at ~line 1222)
- Modify: `src/preload/index.ts` (types ~line 137, config api ~line 397)
- Modify: `docs/SPEC.md` (§ *Settings (app config)*, line ~280)

**Interfaces:**
- Consumes: `getUiPrefs`, `setUiPrefs`, `UiPrefs` from Task 1.
- Produces: IPC `config:get` response gains `uiPrefs: UiPrefs`; new channel `config:setUiPrefs(prefs: Partial<UiPrefs>) → { uiPrefs: UiPrefs }`; preload exports `interface UiPrefs` and `window.api.config.setUiPrefs()`. Tasks 4–6 consume these.

- [ ] **Step 1: main-process handler**

In `src/main/ipc.ts`, extend the `from './config.js'` import block (ends line ~30) with `getUiPrefs,` and `setUiPrefs,` (type `UiPrefs` isn't needed in ipc.ts — the handler arg is typed inline). Then in the `config:get` handler (~line 1222) add:

```ts
    uiPrefs: await getUiPrefs(),
```

after `usageBudget: await getUsageBudget()` (add the comma to the prior line). Directly after the `config:setUsageBudget` handler add:

```ts
  // Display preferences (budget-bar/session-cost visibility, session-list
  // filters). Partial merge — the renderer sends only what changed.
  ipcMain.handle('config:setUiPrefs', async (_e, prefs: unknown) => {
    await setUiPrefs((prefs ?? {}) as Partial<import('./config.js').UiPrefs>);
    return { uiPrefs: await getUiPrefs() };
  });
```

- [ ] **Step 2: preload types + API**

In `src/preload/index.ts`, after the `UsageBudget` interface (ends ~line 145), add:

```ts
/** Display preferences (mirrors `UiPrefs` in main/config). 0 = unlimited. */
export interface UiPrefs {
  showBudgetBar: boolean;
  showSessionCost: boolean;
  maxSessions: number;
  maxSessionAgeDays: number;
}
```

In the `config:` section: add `uiPrefs: UiPrefs;` to the `get()` return type (after `usageBudget: UsageBudget;`), and after the `setUsageBudget` entry add:

```ts
    setUiPrefs: (prefs: Partial<UiPrefs>): Promise<{ uiPrefs: UiPrefs }> =>
      ipcRenderer.invoke('config:setUiPrefs', prefs)
```

(comma after the `setUsageBudget` entry).

- [ ] **Step 3: SPEC.md**

In `docs/SPEC.md` § *Settings (app config)* (line ~280):

1. In the intro line, extend the persisted shape with `, uiPrefs?: { showBudgetBar?: boolean, showSessionCost?: boolean, maxSessions?: number, maxSessionAgeDays?: number }` (inside the `{ ... }` literal, before the closing brace).
2. After the `- **usageBudget** — ...` bullet, add:

```markdown
- **uiPrefs** — display-only preferences, all defaulting to "no change from prior behavior" (absent toggle ⇒ shown; absent/0 filter ⇒ unlimited). `showBudgetBar` gates the observability rail's plan-usage bar *and* the renderer's 15s `usage:rollingSpend` poll (no consumer ⇒ no poll). `showSessionCost` gates the per-session USD badge in the left-rail Sessions list. `maxSessions` / `maxSessionAgeDays` trim the Sessions list via the pure `sessionsView.ts:limitSessions()` helper (age filter, then newest-N cap) — applied to the **Recent** group only (open-tab sessions always render), bypassed while a text search or tag filter is active so old sessions stay findable, and reflected in the "All · N" badge (which keeps counting exactly what the All view lists). Values outside the settings dropdown presets (hand-edited config) are honored and rendered as an extra "N (custom)" option. Sessions stay in SQLite regardless — these never delete anything.
```

3. In the `config:get()` bullet, extend the response shape: `{ fleetRoot, sharedDir, disableHardwareAcceleration, autoReloadLoadouts, usageBudget, uiPrefs }` and append `+ the resolved display prefs (`uiPrefs`, all four keys present)` to the description.
4. After the `config:setUsageBudget` bullet, add:

```markdown
- `config:setUiPrefs(prefs)` → `{ uiPrefs }` — shallow-merge a partial display-prefs update (booleans kept as-is; numbers rounded, negatives dropped so the prior value wins).
```

5. In §5's observability-pane paragraph (line ~172), change the plan-usage-bar sentence "shown regardless of scope or selection because the plan limit is account-wide, not per-workspace" to "shown regardless of scope or selection because the plan limit is account-wide, not per-workspace (hidden entirely — poll included — when `uiPrefs.showBudgetBar` is off, §*Settings*)".

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: clean exit, no errors.

- [ ] **Step 5: Commit (IPC + spec together — spec-maintenance rule)**

```bash
git add src/main/ipc.ts src/preload/index.ts docs/SPEC.md
git commit -m "feat(ipc): config:setUiPrefs + uiPrefs in config:get; spec update"
```

---

### Task 3: `limitSessions()` pure helper

**Files:**
- Modify: `src/renderer/src/sessionsView.ts`
- Test: `src/renderer/src/sessionsView.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export function limitSessions<T extends { lastActiveAt: number | null }>(items: readonly T[], opts: { maxCount: number; maxAgeDays: number }, now: number): T[]`. Task 6 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/sessionsView.test.ts` (add `limitSessions` to the import from `./sessionsView` at the top):

```ts
describe('limitSessions', () => {
  const DAY = 86_400_000;
  const NOW = 1_754_000_000_000;
  const row = (id: string, ageDays: number | null): { id: string; lastActiveAt: number | null } => ({
    id,
    lastActiveAt: ageDays === null ? null : NOW - ageDays * DAY
  });
  // last-active-descending, matching db.ts listSessions ordering.
  const ROWS = [row('a', 0), row('b', 2), row('c', 10), row('d', 40), row('e', null)];

  it('0/0 is a passthrough (unlimited), without aliasing the input', () => {
    const out = limitSessions(ROWS, { maxCount: 0, maxAgeDays: 0 }, NOW);
    expect(out).toEqual(ROWS);
    expect(out).not.toBe(ROWS);
  });

  it('age filter drops older rows; exactly at the boundary stays', () => {
    const boundary = [row('x', 7), row('y', 7.00001)];
    const out = limitSessions(boundary, { maxCount: 0, maxAgeDays: 7 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['x']);
  });

  it('null lastActiveAt passes the age filter (age unknown ⇒ keep)', () => {
    const out = limitSessions(ROWS, { maxCount: 0, maxAgeDays: 7 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'e']);
  });

  it('count cap keeps the newest N (input order is last-active-descending)', () => {
    const out = limitSessions(ROWS, { maxCount: 2, maxAgeDays: 0 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('applies age first, then the cap', () => {
    const out = limitSessions(ROWS, { maxCount: 2, maxAgeDays: 30 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']); // d(40d) already gone before capping
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: FAIL — `limitSessions` is not exported.

- [ ] **Step 3: Implement**

Append to `src/renderer/src/sessionsView.ts`:

```ts
/** Display-prefs trim for the Recent group (uiPrefs.maxSessions /
 *  maxSessionAgeDays; 0 = unlimited). Age filter first (rows exactly at the
 *  cutoff stay; null lastActiveAt passes — age unknown ⇒ keep), then the
 *  newest-N cap — items arrive last-active-descending (db.ts listSessions),
 *  so a plain slice IS "newest N". `now` is injected for testability. */
export function limitSessions<T extends { lastActiveAt: number | null }>(
  items: readonly T[],
  opts: { maxCount: number; maxAgeDays: number },
  now: number
): T[] {
  let out = [...items];
  if (opts.maxAgeDays > 0) {
    const cutoff = now - opts.maxAgeDays * 86_400_000;
    out = out.filter((s) => s.lastActiveAt == null || s.lastActiveAt >= cutoff);
  }
  if (opts.maxCount > 0) out = out.slice(0, opts.maxCount);
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/sessionsView.ts src/renderer/src/sessionsView.test.ts
git commit -m "feat(sessions): limitSessions view helper for display-prefs filters"
```

---

### Task 4: Display section in SettingsModal

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `window.api.config.get().uiPrefs`, `window.api.config.setUiPrefs()` (Task 2); `UiPrefs` type from `'../../../preload'`.
- Produces: user-editable Display section; saved via the modal's existing Save.

- [ ] **Step 1: State + load + save**

In `src/renderer/src/components/SettingsModal.tsx`:

1. Extend the preload type import (line ~8): `import type { UsageBudgetPreset, UiPrefs } from '../../../preload';`
2. Module-scope constants after `fmtTokens` (values must match the spec presets):

```ts
/** Dropdown presets for the Display filters; 0 = All/unlimited. */
const SESSION_COUNT_PRESETS = [0, 10, 25, 50, 100];
const SESSION_AGE_PRESETS = [0, 1, 7, 30, 90];

/** "1 day" / "7 days" / "All" labels for the age dropdown. */
function ageLabel(days: number): string {
  if (days === 0) return 'All';
  return days === 1 ? '1 day' : `${days} days`;
}
```

3. Settings-tab state, after `budgetWindowHours` (~line 81):

```ts
  // Display prefs (#issue): budget-bar/session-cost visibility + list filters.
  const [uiPrefs, setUiPrefsState] = useState<UiPrefs>({
    showBudgetBar: true,
    showSessionCost: true,
    maxSessions: 0,
    maxSessionAgeDays: 0
  });
```

4. In the `config.get()` load effect, after the `usageBudget` guard block:

```ts
        if (cfg.uiPrefs) setUiPrefsState(cfg.uiPrefs);
```

5. In `save()`, after the `setUsageBudget` await:

```ts
      await window.api.config.setUiPrefs(uiPrefs);
```

- [ ] **Step 2: JSX — Display section**

In the Settings tab JSX, insert a fourth `settings-section` after the "Plan usage" section's closing `</div>` (i.e., after the custom-budget conditional block, before the tab's error/footer area), matching the existing `setting-row` pattern exactly:

```tsx
            <div className="settings-section">
              <div className="settings-section-header">Display</div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-show-budget">
                    Show plan-usage budget in the observability rail
                  </label>
                  <p className="setting-desc">
                    Hiding only affects display — spend tracking continues.
                  </p>
                </div>
                <input
                  id="setting-show-budget"
                  type="checkbox"
                  checked={uiPrefs.showBudgetBar}
                  onChange={(e) =>
                    setUiPrefsState((p) => ({ ...p, showBudgetBar: e.target.checked }))
                  }
                  disabled={busy || !loaded}
                />
              </div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-show-cost">
                    Show session cost in the sessions list
                  </label>
                  <p className="setting-desc">
                    Costs are still recorded and visible in the observability rail.
                  </p>
                </div>
                <input
                  id="setting-show-cost"
                  type="checkbox"
                  checked={uiPrefs.showSessionCost}
                  onChange={(e) =>
                    setUiPrefsState((p) => ({ ...p, showSessionCost: e.target.checked }))
                  }
                  disabled={busy || !loaded}
                />
              </div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-max-sessions">
                    Max sessions shown
                  </label>
                  <p className="setting-desc">
                    Trims the sessions list only — searching bypasses it; nothing is deleted.
                  </p>
                </div>
                <select
                  id="setting-max-sessions"
                  value={uiPrefs.maxSessions}
                  onChange={(e) =>
                    setUiPrefsState((p) => ({ ...p, maxSessions: Number(e.target.value) }))
                  }
                  disabled={busy || !loaded}
                >
                  {!SESSION_COUNT_PRESETS.includes(uiPrefs.maxSessions) && (
                    <option value={uiPrefs.maxSessions}>{uiPrefs.maxSessions} (custom)</option>
                  )}
                  {SESSION_COUNT_PRESETS.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'All' : n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-max-age">
                    Max session age
                  </label>
                  <p className="setting-desc">
                    Hides sessions idle longer than this. Open tabs always show.
                  </p>
                </div>
                <select
                  id="setting-max-age"
                  value={uiPrefs.maxSessionAgeDays}
                  onChange={(e) =>
                    setUiPrefsState((p) => ({ ...p, maxSessionAgeDays: Number(e.target.value) }))
                  }
                  disabled={busy || !loaded}
                >
                  {!SESSION_AGE_PRESETS.includes(uiPrefs.maxSessionAgeDays) && (
                    <option value={uiPrefs.maxSessionAgeDays}>
                      {ageLabel(uiPrefs.maxSessionAgeDays)} (custom)
                    </option>
                  )}
                  {SESSION_AGE_PRESETS.map((n) => (
                    <option key={n} value={n}>
                      {ageLabel(n)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(settings): Display section — budget/cost toggles + session filters"
```

---

### Task 5: Budget-bar visibility + poll gating in App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx` (state ~line 213, config effect ~line 570, poll effect ~line 582, ObservabilityPane props ~line 1246, SettingsModal onSaved ~line 1343)

**Interfaces:**
- Consumes: `uiPrefs` from `config:get` (Task 2); `UiPrefs` type from `'../../preload'`.
- Produces: `uiPrefs` App state that Task 6 also reads (pass to `LeftRail`). No ObservabilityPane signature change — a hidden bar is `budget={null}` (its render is already `{budget && <UsageBudgetBar/>}`).

- [ ] **Step 1: State + fetch + refresh**

1. Extend the preload type import (line ~25): add `UiPrefs` to the existing `import type { ... } from '../../preload';`
2. After the `budgetSpentTokens` state (line ~214):

```ts
  // Display prefs; null until the first config.get resolves (defaults = shown).
  const [uiPrefs, setUiPrefs] = useState<UiPrefs | null>(null);
```

3. In the mount effect's `config.get().then(...)` (line ~570), after `setUsageBudget(cfg.usageBudget);`:

```ts
      setUiPrefs(cfg.uiPrefs);
```

4. In `SettingsModal`'s `onSaved` (line ~1343), the existing refresh becomes:

```ts
            // Pick up any usage-budget / display-prefs change made in the modal.
            window.api.config.get().then((c) => {
              setUsageBudget(c.usageBudget);
              setUiPrefs(c.uiPrefs);
            });
```

- [ ] **Step 2: Gate the poll and the bar**

1. Rolling-spend poll effect (line ~582) — skip while hidden (null = not loaded yet ⇒ keep polling, bar defaults to shown):

```ts
  useEffect(() => {
    if (!apiReady || uiPrefs?.showBudgetBar === false) return;
    const poll = () =>
      window.api.usage.rollingSpend().then((r) => setBudgetSpentTokens(r.spentTokens));
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [apiReady, uiPrefs?.showBudgetBar]);
```

2. ObservabilityPane props (line ~1255): change `budget={usageBudget}` to:

```tsx
          budget={uiPrefs?.showBudgetBar === false ? null : usageBudget}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(obs): hide plan-usage bar + skip spend poll per uiPrefs"
```

---

### Task 6: Session cost badge + list filters in the left rail

**Files:**
- Modify: `src/renderer/src/App.tsx` (LeftRail props ~line 1154)
- Modify: `src/renderer/src/components/LeftRail.tsx` (Props ~line 13, SessionsPane call ~line 119)
- Modify: `src/renderer/src/components/SessionsPane.tsx`

**Interfaces:**
- Consumes: `uiPrefs` App state (Task 5), `limitSessions` (Task 3).
- Produces: `LeftRail` + `SessionsPane` gain optional props `showSessionCost?: boolean; maxSessions?: number; maxSessionAgeDays?: number` (all defaulting to current behavior when absent).

- [ ] **Step 1: Plumb the props**

1. `App.tsx` — inside `<LeftRail ...>` (line ~1154), add:

```tsx
          showSessionCost={uiPrefs?.showSessionCost !== false}
          maxSessions={uiPrefs?.maxSessions ?? 0}
          maxSessionAgeDays={uiPrefs?.maxSessionAgeDays ?? 0}
```

2. `LeftRail.tsx` — add to `interface Props` (after `openSessions`):

```ts
  /** Display prefs (uiPrefs): hide the per-session USD badge. Default show. */
  showSessionCost?: boolean;
  /** Display prefs: trim the Recent list to the newest N (0 = unlimited). */
  maxSessions?: number;
  /** Display prefs: hide Recent sessions idle > N days (0 = unlimited). */
  maxSessionAgeDays?: number;
```

Destructure them in the component signature and forward inside `<SessionsPane ...>` (line ~119):

```tsx
            showSessionCost={showSessionCost}
            maxSessions={maxSessions}
            maxSessionAgeDays={maxSessionAgeDays}
```

- [ ] **Step 2: Apply in SessionsPane**

In `src/renderer/src/components/SessionsPane.tsx`:

1. Import: add `limitSessions` to the `from '../sessionsView'` import.
2. Add to `interface Props` (after `openSessions`) the same three optional props as LeftRail (copy the doc comments), and destructure with defaults in the signature: `showSessionCost = true, maxSessions = 0, maxSessionAgeDays = 0`.
3. Replace the derived-rows block (lines ~152–161) with:

```ts
  // Sessions shown for the active scope. Display-prefs limits (uiPrefs) trim
  // the Recent group only — open-tab rows always render — and are bypassed
  // while a search/tag filter is active so old sessions stay findable.
  const scoped = sessionsForScope(items, scope, selectedWorkspaceId);
  const q = query.trim().toLowerCase();
  const filtered = filterSessions(scoped, query, activeTags);
  const openIds = new Set(openSessions?.keys() ?? []);
  const { open: openRows, recent: recentRows } = partitionByOpen(filtered, openIds);
  const limitOpts = { maxCount: maxSessions, maxAgeDays: maxSessionAgeDays };
  const bypassLimits = q !== '' || activeTags.length > 0;
  const recentShown = bypassLimits
    ? recentRows
    : limitSessions(recentRows, limitOpts, Date.now());
  // "All · N" badge: what the All view lists under the current limits (#149) —
  // open rows + the limited recent rows over the FULL list, search ignored
  // (searching never changed the badge before either).
  const allParts = partitionByOpen(items, openIds);
  const allSessionsCount =
    allParts.open.length + limitSessions(allParts.recent, limitOpts, Date.now()).length;
  const allTags = tagCounts(scoped);
```

4. Empty state: the `filtered.length === 0 ? (` branch (line ~363) becomes `openRows.length + recentShown.length === 0 ? (`, and its placeholder becomes:

```tsx
          <div className="pane-placeholder subdued">
            <strong>
              {q || activeTags.length > 0
                ? 'No matches'
                : filtered.length > 0
                  ? 'All sessions hidden by display filters'
                  : 'No sessions yet'}
            </strong>
            {q || activeTags.length > 0
              ? 'Try a different search.'
              : filtered.length > 0
                ? 'Raise Max sessions / Max session age in Settings → Display, or search.'
                : 'Claude sessions appear here once a transcript exists.'}
          </div>
```

5. List body: change `{recentRows.length > 0 && (` and `{recentRows.map(renderRow)}` (lines ~379–384) to use `recentShown`.
6. Cost badge (line ~255): wrap in the toggle:

```tsx
            {showSessionCost && <span className="session-row-cost">{formatUsd(s.usd)}</span>}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run src/renderer/src/sessionsView.test.ts`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/LeftRail.tsx src/renderer/src/components/SessionsPane.tsx
git commit -m "feat(sessions): cost-badge toggle + max-count/max-age display filters"
```

---

### Task 7: Full gate + branch finish

**Files:** none new.

- [ ] **Step 1: Full verification**

Run, in order:

```bash
npm run typecheck
npm run test:unit
npm run build
```

Expected: all three exit 0. (`test:e2e` is skipped — no display in this container.)

- [ ] **Step 2: Review the complete diff against the spec**

Run: `git log --oneline origin/main..HEAD && git diff origin/main --stat`
Check each spec requirement (both toggles, both filters, defaults, search bypass, open-exemption, badge invariant, poll skip, SPEC.md updated in the Task 2 commit).

- [ ] **Step 3: Finish the branch**

Use superpowers:finishing-a-development-branch. Per Troy's standing preference: push and open a PR without asking. PR body must note: UI verified by typecheck/unit/build only — no in-container visual verification; screenshots/eyeballing on host. Reference the design spec path and the auto-filed spec issue.
