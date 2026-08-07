# Settings Design-Language Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the settings gear icon with a Feather-style cog and restyle the Settings modal (both tabs) to the approved grouped-sections design — zero behavior changes.

**Architecture:** Pure renderer changes in the Electron app: one SVG swap in `WorkspaceTabStrip.tsx`, JSX restructure of the Settings tab + a styling-only pass on the Model Endpoints tab in `SettingsModal.tsx`, and new CSS classes in `styles.css`. State, handlers, and IPC are untouched.

**Tech Stack:** React 18 + TypeScript (electron-vite), single plain-CSS stylesheet with OKLCH tokens, vitest for unit gate, Playwright e2e runs in CI only.

**Spec:** `docs/superpowers/specs/2026-08-06-settings-design-language-design.md` (this repo, same branch). Review issue: ImIOImI/claude-fleet#266.

## Global Constraints

- **Zero behavior changes**: same state variables, handlers, IPC calls, and save semantics in `SettingsModal.tsx`.
- **e2e invariants** (from `tests/observability.spec.ts:400-423`, CI-only): the trigger keeps class `settings-btn`; the modal still contains the text "Settings"; the fleet-root `<input>` remains the **first `input` element in the modal DOM**; Cancel/Save remain real `<button>` elements with those exact labels.
- **No new dependencies**; icons stay hand-inlined SVG on `currentColor`.
- **No `docs/SPEC.md` update** (styling only — per `.claude/rules/spec-maintenance.md`).
- Work happens in this worktree: `/workspace/claude-fleet/.claude/worktrees/settings-design-language` (branch `feat/settings-design-language`). Never `cd /workspace/claude-fleet` (that's the shared main checkout on another branch).
- **This container has no display/electron**: the merge gate is `npm run typecheck` + `npm run test:unit` + `npm run build`, and the PR must say the UI was not eyeballed here (Playwright + human eyeball happen on CI/host).

---

### Task 0: Worktree dev environment

**Files:**
- No source changes. Installs `node_modules` in the worktree.

**Interfaces:**
- Produces: a worktree where `npm run typecheck`, `npm run test:unit`, and `npm run build` all pass on the clean tree (baseline for every later task).

- [ ] **Step 1: Install deps without electron binary / native rebuilds**

The repo postinstall (`electron-builder install-app-deps`) rebuilds native modules against the Electron ABI, which fails in this container — skip scripts, then selectively rebuild what vitest needs.

```bash
cd /workspace/claude-fleet/.claude/worktrees/settings-design-language
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts --no-audit --no-fund
```

Expected: completes without errors (electron binary not downloaded, no native compiles).

- [ ] **Step 2: Fetch the prebuilt better-sqlite3 binding (node ABI, for vitest)**

```bash
cd node_modules/better-sqlite3 && npx prebuild-install || npm run build-release; cd ../..
node -e "require('better-sqlite3'); console.log('sqlite ok')"
```

Expected: `sqlite ok`. (`prebuild-install` downloads the prebuilt node-v22 binding; no toolchain needed.)

- [ ] **Step 3: Stub the electron path file (vitest/electron-vite import `electron` without a binary)**

```bash
echo "electron" > node_modules/electron/path.txt
```

- [ ] **Step 4: Verify the baseline gates pass on the clean tree**

```bash
npm run typecheck && npm run test:unit && npm run build
```

Expected: all three PASS. If a step fails here, fix the environment (not the code) before proceeding — the tree is untouched v0.9.0 plus the spec/plan docs.

---

### Task 1: Feather-style gear icon

**Files:**
- Modify: `src/renderer/src/components/WorkspaceTabStrip.tsx:104-121` (the `IconGear` function only)

**Interfaces:**
- Produces: `IconGear(): JSX.Element` — same name, same call site (`<IconGear />` at ~line 386 inside `.icon-btn.settings-btn`), same 14×14 rendered size.

- [ ] **Step 1: Replace the IconGear SVG**

Replace the entire existing `IconGear` function body with:

```tsx
function IconGear(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
```

Notes: `viewBox` changes 16→24 (Feather geometry); `strokeWidth` 1.8 keeps visual weight parity with the 1.4-stroke/16-viewBox sibling icons at 14px. Do not touch the sibling icon functions or the call site.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/WorkspaceTabStrip.tsx
git commit -m "feat(ui): replace settings gear icon with Feather-style cog (#266)"
```

---

### Task 2: CSS for grouped sections + setting rows

**Files:**
- Modify: `src/renderer/src/styles.css` — two edits: (a) extend the three `.form-row input/select` rules, (b) append a new block after the `.input-with-button` rules (~line 1426).

**Interfaces:**
- Produces: classes `settings-section`, `settings-section-header`, `setting-row`, `setting-row-text`, `setting-title`, `setting-desc`, `setting-custom-budget` — consumed by Tasks 3 and 4. Inputs/selects inside `.settings-section` get the same skin as `.form-row` ones.

- [ ] **Step 1: Extend the form-control skin to settings sections**

Find the three rules (~lines 1353-1368) and add the `.settings-section` selectors:

```css
.form-row input,
.form-row select,
.settings-section input:not([type='checkbox']),
.settings-section select {
  background: var(--bg-canvas);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: 8px 10px;
  color: var(--ink);
  font-size: 13px;
  font-family: var(--font-mono);
}
.form-row input:focus,
.form-row select:focus,
.settings-section input:focus,
.settings-section select:focus {
  outline: none;
  border-color: var(--ok);
}
.form-row input:disabled,
.settings-section input:disabled { opacity: 0.5; }
```

(The declaration bodies are unchanged — only selectors are added.)

- [ ] **Step 2: Append the new block**

After the `.input-with-button button:disabled` rule (~line 1426), append:

```css
/* ── SettingsModal: grouped sections + setting rows ─────────────────── */
.settings-section { margin-bottom: 18px; }
.settings-section-header {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2);
  padding-bottom: 6px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--rule-soft);
}
.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}
.setting-row-text { flex: 1; min-width: 0; }
.setting-title { font-size: 13px; color: var(--ink); }
label.setting-title { display: block; cursor: pointer; }
.setting-desc {
  font-size: 11px;
  color: var(--ink-2);
  line-height: 1.4;
  margin: 2px 0 0;
}
.setting-row input[type='checkbox'] {
  margin: 3px 0 0;
  cursor: pointer;
  accent-color: var(--ok);
  flex-shrink: 0;
}
.setting-row select { flex-shrink: 0; align-self: center; }
.setting-custom-budget { margin-top: 8px; }
.setting-custom-budget input { width: 100%; }
.setting-custom-budget .setting-desc { margin-top: 6px; }
```

- [ ] **Step 3: Build (CSS syntax gate) and commit**

```bash
npm run build
git add src/renderer/src/styles.css
git commit -m "feat(ui): section/row CSS for the settings modal redesign (#266)"
```

Expected: build PASS.

---

### Task 3: Settings tab — grouped sections JSX

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx:291-436` (the `{activeTab === 'settings' && (...)}` block only)

**Interfaces:**
- Consumes: Task 2's CSS classes.
- Produces: nothing new — all state (`fleetRoot`, `hwaDisabled`, `hwaInitial`, `autoReload`, `budgetPreset`, `budgetCustom`, `budgetPresets`, `budgetWindowHours`, `loaded`, `busy`, `error`) and handlers (`browse`, `save`, `onClose`) keep their existing names and semantics.

- [ ] **Step 1: Replace the Settings tab panel JSX**

Replace everything inside `{activeTab === 'settings' && ( ... )}` (the whole `<div className="new-tab">…</div>`) with:

```tsx
          <div className="new-tab" role="tabpanel">
            <div className="settings-section">
              <div className="settings-section-header">Storage</div>
              <div className="input-with-button">
                <input
                  value={fleetRoot}
                  onChange={(e) => setFleetRoot(e.target.value)}
                  placeholder="/home/you/fleet"
                  disabled={busy || !loaded}
                  aria-label="Fleet root (host path)"
                />
                <button type="button" onClick={browse} disabled={busy || !loaded}>
                  Browse…
                </button>
              </div>
              <p className="setting-desc">
                Private folder per workspace at <code>&lt;root&gt;/&lt;id&gt;</code> →{' '}
                <code>/workspace</code>, plus a shared <code>&lt;root&gt;/shared</code> →{' '}
                <code>/shared</code> in every container. Applies to new containers and on next
                restart.
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-header">Behavior</div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-hwa">
                    Disable hardware acceleration
                  </label>
                  <p className="setting-desc">
                    For GPU-process errors on startup (common on WSLg). Applies at next launch.
                    {hwaDisabled !== hwaInitial && (
                      <strong> Restart required to take effect.</strong>
                    )}
                  </p>
                </div>
                <input
                  id="setting-hwa"
                  type="checkbox"
                  checked={hwaDisabled}
                  onChange={(e) => setHwaDisabled(e.target.checked)}
                  disabled={busy || !loaded}
                />
              </div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-autoreload">
                    Auto-reload loadouts into running workspaces
                  </label>
                  <p className="setting-desc">
                    Reload the Claude session (<code>--resume</code>) after a loadout
                    install/update — waits until Claude is idle before reloading.
                  </p>
                </div>
                <input
                  id="setting-autoreload"
                  type="checkbox"
                  checked={autoReload}
                  onChange={(e) => setAutoReload(e.target.checked)}
                  disabled={busy || !loaded}
                />
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-header">Plan usage</div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-budget">
                    Budget for the &ldquo;tokens left&rdquo; bar
                  </label>
                  <p className="setting-desc">
                    Rolling {budgetWindowHours}-hour window (input + output + cache), fleet-wide.
                    Presets are estimates — calibrate with Custom.
                  </p>
                </div>
                <select
                  id="setting-budget"
                  value={budgetPreset}
                  onChange={(e) => setBudgetPreset(e.target.value as UsageBudgetPreset)}
                  disabled={busy || !loaded}
                >
                  <option value="pro">
                    Pro — {fmtTokens(budgetPresets.pro)} / {budgetWindowHours}h
                  </option>
                  <option value="max5">
                    Max 5× — {fmtTokens(budgetPresets.max5)} / {budgetWindowHours}h
                  </option>
                  <option value="max20">
                    Max 20× — {fmtTokens(budgetPresets.max20)} / {budgetWindowHours}h
                  </option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {budgetPreset === 'custom' && (
                <div className="setting-custom-budget">
                  <input
                    type="number"
                    min="0"
                    step="1000000"
                    value={budgetCustom}
                    onChange={(e) => setBudgetCustom(e.target.value)}
                    placeholder="e.g. 19000000"
                    disabled={busy || !loaded}
                    aria-label={`Custom budget (tokens per ${budgetWindowHours}h)`}
                  />
                  <p className="setting-desc">
                    Anthropic doesn&apos;t publish exact limits — presets are anchored to the Max
                    5×/20× multipliers. Calibrate with your real ceiling from Settings → Usage, or
                    the spend shown when Claude Code reports a limit.
                  </p>
                </div>
              )}
            </div>

            {error && <div className="form-hint error-text">{error}</div>}
            <div className="modal-footer">
              <span className="modal-footer-spacer" />
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={save} disabled={busy || !loaded}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
```

Invariant check while editing: the fleet-root `<input>` is still the first input in the modal DOM (checkboxes come after); Cancel/Save buttons unchanged; the "Restart required" nudge and the custom-budget reveal keep their conditions.

- [ ] **Step 2: Gates**

```bash
npm run typecheck && npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(ui): settings tab — grouped sections, setting rows, tightened copy (#266)"
```

---

### Task 4: Model Endpoints tab — same idioms (styling only)

**Files:**
- Modify: `src/renderer/src/styles.css` (append endpoint classes after the Task 2 block)
- Modify: `src/renderer/src/components/SettingsModal.tsx:400-478` (endpoint list `<ul>` block) and `:492-560` (form fields — wrap in sections; fields themselves unchanged)

**Interfaces:**
- Consumes: `settings-section` / `settings-section-header` from Task 2.
- Produces: classes `endpoint-list`, `endpoint-row`, `endpoint-row-text`, `endpoint-name`, `endpoint-detail`, `endpoint-key-badge` (+ modifier `on`).

- [ ] **Step 1: Append endpoint CSS**

Directly after the Task 2 block in `styles.css`:

```css
/* ── SettingsModal: model-endpoint list rows ────────────────────────── */
.endpoint-list { list-style: none; padding: 0; margin: 0 0 12px; }
.endpoint-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
}
.endpoint-row-text { flex: 1; min-width: 0; }
.endpoint-name { font-weight: 500; font-size: 13px; color: var(--ink); }
.endpoint-detail {
  font-size: 11px;
  color: var(--ink-2);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.endpoint-key-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-canvas);
  border: 1px solid var(--rule);
  color: var(--ink-2);
  white-space: nowrap;
  flex-shrink: 0;
}
.endpoint-key-badge.on {
  background: color-mix(in oklab, var(--ok) 18%, transparent);
  border-color: color-mix(in oklab, var(--ok) 35%, transparent);
  color: var(--ok);
}
```

- [ ] **Step 2: Replace the endpoint list's inline styles with the classes**

Replace the `<ul style={{…}}>…</ul>` block (endpoints list) with:

```tsx
                  <ul className="endpoint-list">
                    {endpoints.map((ep) => (
                      <li key={ep.id} className="endpoint-row">
                        <div className="endpoint-row-text">
                          <div className="endpoint-name">{ep.name}</div>
                          <div className="endpoint-detail">
                            {ep.baseUrl} · {ep.modelId}
                          </div>
                        </div>
                        <span className={`endpoint-key-badge${ep.hasApiKey ? ' on' : ''}`}>
                          {ep.hasApiKey ? 'key set' : 'no key'}
                        </span>
                        <button type="button" className="btn-mini" onClick={() => openEditForm(ep)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-mini danger"
                          onClick={() => void deleteEndpoint(ep)}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
```

(Behavior identical; the row separator softens from `--rule` to `--rule-soft` to match setting rows — intended per spec.)

- [ ] **Step 3: Group the add/edit form under section headers**

Wrap the existing `form-row` fields (leave each field's JSX untouched) in two sections:

- `<div className="settings-section"><div className="settings-section-header">Endpoint</div> … </div>` around the **Name**, **Base URL**, and **Model ID** rows.
- `<div className="settings-section"><div className="settings-section-header">Options</div> … </div>` around the **Small / fast model ID**, **Context length**, **Notes**, and **API key** rows.

The probe-result hint, error display, and the Test connection / Cancel / Save-Update footer stay exactly where they are, outside the sections.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npm run test:unit && npm run build
git add src/renderer/src/styles.css src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(ui): model-endpoints tab — endpoint rows + form sections match settings idioms (#266)"
```

Expected: all PASS.

---

### Task 5: Full gate, push, PR

**Files:**
- No source changes.

- [ ] **Step 1: Full gate on the final tree**

```bash
npm run typecheck && npm run test:unit && npm run build
```

Expected: all PASS. (Playwright e2e is CI-only here — do not attempt locally; there is no display.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/settings-design-language
```

Create a PR titled `feat(ui): settings modal design-language alignment + Feather gear icon` targeting `main`, body must include:
- `Closes #266` and a link to the spec file on the branch.
- The two mockup images (already on this branch under `docs/superpowers/specs/assets/2026-08-06-settings-design-language/`, referenced by raw URL pinned to a commit SHA).
- The gate that ran (`typecheck + test:unit + build` in-container) and an explicit note that the UI was **not** visually verified in the container — CI runs Playwright, and Troy eyeballs on the host.
- Footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Self-review notes

- Spec coverage: icon (Task 1), settings-tab sections + copy + mono-leak fix (Tasks 2-3), endpoints pass (Task 4), constraints/gates (Tasks 0, 5). SPEC.md intentionally untouched.
- e2e invariants re-verified against `tests/observability.spec.ts`: `.settings-btn` (Task 1 keeps class), first-input = fleet root (Task 3 layout keeps it first), `Save` button by role (Task 3 footer unchanged).
- Class names are consistent across Tasks 2/3/4 (`settings-section`, `settings-section-header`, `setting-row`, `setting-row-text`, `setting-title`, `setting-desc`, `setting-custom-budget`, `endpoint-*`).
