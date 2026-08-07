# Model Picker Form UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workspace form's `Endpoint` auth radio + conditional endpoint `<select>` with a rich Model combobox directly above Auth, with a contextual Auth row.

**Architecture:** Renderer-only. A pure helper (`modelPicker.ts`) maps the form's two controls (Model selection, Claude auth radio) to/from the unchanged wire shape (`authMode` + `endpointId`). A new presentational `ModelCombobox` component renders the two-line listbox. `WorkspaceForm` composes them; `App.tsx` gains a Settings deep-link so "＋ Add endpoint…" opens Settings → Model Endpoints.

**Tech Stack:** React 18 + TypeScript (electron-vite renderer), vitest (unit), Playwright `_electron` (e2e).

**Spec:** `docs/superpowers/specs/2026-08-06-model-picker-form-ux-design.md` · Issue: #256

## Global Constraints

- **No data-model changes:** `AuthMode = 'oauth' | 'apikey' | 'endpoint'`, `WorkspaceFormSubmit`, manifests, IPC channels, and vault contract are untouched. No migration.
- **Working dir:** the worktree `/workspace/claude-fleet/.claude/worktrees/model-picker-ux`. Never `cd /workspace/claude-fleet` (main checkout, different branch).
- **SPEC rule:** `docs/SPEC.md` and `docs/design/workspace-modal.md` must be updated in this same PR (`.claude/rules/spec-maintenance.md`).
- **Copy (exact strings):** combobox first entry `Claude` / subtitle `Anthropic · claude.ai account or API key`; final entry `＋ Add endpoint…`; missing-endpoint label `(deleted endpoint)`; endpoint auth note `key from endpoint registry (none stored → placeholder token)`; dangling submit error `This workspace's model endpoint was deleted — pick another model.`
- **e2e needs a display:** prefix Playwright commands with `xvfb-run -a` (with `ELECTRON_DISABLE_SANDBOX=1`) when no display is present.
- Badges: one glyph for Claude (`✳`), one for all endpoints (`⬢`) — the registry has no local/org type field, so don't invent per-type badges (YAGNI).

---

### Task 0: Worktree dev environment

**Files:** none (environment only)

**Interfaces:**
- Produces: a worktree where `npx vitest run`, `npm run typecheck`, and `npx playwright test` resolve dependencies.

- [ ] **Step 1: Link node_modules from the main checkout**

The worktree has no `node_modules`; the main checkout's is already patched for vitest (prebuilt better-sqlite3 + electron path stub).

```bash
ln -s /workspace/claude-fleet/node_modules node_modules
```

- [ ] **Step 2: Baseline unit tests + typecheck**

Run: `npx vitest run src/renderer/src/components/chipState.test.ts && npm run typecheck`
Expected: PASS / clean. If module resolution fails through the symlink, fall back to `npm ci` in the worktree (slow; requires the postinstall native rebuild).

---

### Task 1: `modelPicker` pure helper (TDD)

**Files:**
- Create: `src/renderer/src/components/modelPicker.ts`
- Test: `src/renderer/src/components/modelPicker.test.ts`

**Interfaces:**
- Consumes: `AuthMode` type from `src/renderer/src/App.tsx` (type-only import).
- Produces (used by Tasks 2–3):
  - `type ClaudeAuth = 'oauth' | 'apikey'`
  - `type ModelSelection = { kind: 'claude' } | { kind: 'endpoint'; endpointId: string }`
  - `modelFromInitial(authMode?: AuthMode, endpointId?: string): ModelSelection`
  - `claudeAuthFromInitial(authMode?: AuthMode): ClaudeAuth`
  - `deriveAuthFields(model: ModelSelection, claudeAuth: ClaudeAuth): { authMode: AuthMode; endpointId: string | undefined }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/components/modelPicker.test.ts
import { describe, expect, it } from 'vitest';
import {
  claudeAuthFromInitial,
  deriveAuthFields,
  modelFromInitial
} from './modelPicker';

describe('modelFromInitial', () => {
  it('defaults to claude when authMode is undefined', () => {
    expect(modelFromInitial(undefined, undefined)).toEqual({ kind: 'claude' });
  });
  it('maps oauth and apikey to claude', () => {
    expect(modelFromInitial('oauth', undefined)).toEqual({ kind: 'claude' });
    expect(modelFromInitial('apikey', undefined)).toEqual({ kind: 'claude' });
  });
  it('maps endpoint + id to an endpoint selection', () => {
    expect(modelFromInitial('endpoint', 'ep1')).toEqual({ kind: 'endpoint', endpointId: 'ep1' });
  });
  it('degrades endpoint WITHOUT id to claude (defensive)', () => {
    expect(modelFromInitial('endpoint', undefined)).toEqual({ kind: 'claude' });
  });
});

describe('claudeAuthFromInitial', () => {
  it('defaults to oauth (undefined, oauth, and endpoint all → oauth)', () => {
    expect(claudeAuthFromInitial(undefined)).toBe('oauth');
    expect(claudeAuthFromInitial('oauth')).toBe('oauth');
    expect(claudeAuthFromInitial('endpoint')).toBe('oauth');
  });
  it('preserves apikey', () => {
    expect(claudeAuthFromInitial('apikey')).toBe('apikey');
  });
});

describe('deriveAuthFields', () => {
  it('claude + oauth', () => {
    expect(deriveAuthFields({ kind: 'claude' }, 'oauth')).toEqual({
      authMode: 'oauth',
      endpointId: undefined
    });
  });
  it('claude + apikey', () => {
    expect(deriveAuthFields({ kind: 'claude' }, 'apikey')).toEqual({
      authMode: 'apikey',
      endpointId: undefined
    });
  });
  it('endpoint ignores the claude radio', () => {
    expect(deriveAuthFields({ kind: 'endpoint', endpointId: 'ep1' }, 'apikey')).toEqual({
      authMode: 'endpoint',
      endpointId: 'ep1'
    });
  });
});

describe('round-trips', () => {
  const cases: Array<['oauth' | 'apikey' | 'endpoint', string | undefined]> = [
    ['oauth', undefined],
    ['apikey', undefined],
    ['endpoint', 'ep1']
  ];
  it.each(cases)('%s/%s survives load → derive', (authMode, endpointId) => {
    const model = modelFromInitial(authMode, endpointId);
    const claudeAuth = claudeAuthFromInitial(authMode);
    expect(deriveAuthFields(model, claudeAuth)).toEqual({ authMode, endpointId });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/components/modelPicker.test.ts`
Expected: FAIL — `Cannot find module './modelPicker'`

- [ ] **Step 3: Write the implementation**

```ts
// src/renderer/src/components/modelPicker.ts
// Pure mapping between the workspace form's Model/Auth controls and the
// unchanged wire shape (authMode + endpointId) — spec
// docs/superpowers/specs/2026-08-06-model-picker-form-ux-design.md (#256).
// Kept free of React so every WorkspaceForm consumer derives identically
// and the mapping is unit-testable.

import type { AuthMode } from '../App';

export type ClaudeAuth = 'oauth' | 'apikey';

export type ModelSelection =
  | { kind: 'claude' }
  | { kind: 'endpoint'; endpointId: string };

export function modelFromInitial(
  authMode?: AuthMode,
  endpointId?: string
): ModelSelection {
  // 'endpoint' without an id can only come from a hand-edited manifest —
  // degrade to claude rather than carrying an unusable selection.
  if (authMode === 'endpoint' && endpointId) return { kind: 'endpoint', endpointId };
  return { kind: 'claude' };
}

export function claudeAuthFromInitial(authMode?: AuthMode): ClaudeAuth {
  return authMode === 'apikey' ? 'apikey' : 'oauth';
}

export function deriveAuthFields(
  model: ModelSelection,
  claudeAuth: ClaudeAuth
): { authMode: AuthMode; endpointId: string | undefined } {
  if (model.kind === 'endpoint') {
    return { authMode: 'endpoint', endpointId: model.endpointId };
  }
  return { authMode: claudeAuth, endpointId: undefined };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/modelPicker.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/modelPicker.ts src/renderer/src/components/modelPicker.test.ts
git commit -m "feat(form): pure model-picker derivation helper (#256)"
```

---

### Task 2: `ModelCombobox` component + styles

**Files:**
- Create: `src/renderer/src/components/ModelCombobox.tsx`
- Modify: `src/renderer/src/styles.css` (append after the `.kind-radio` block, ~line 1588)

**Interfaces:**
- Consumes: `ModelSelection` from `./modelPicker` (Task 1).
- Produces (used by Task 3):
  - `interface EndpointEntry { id: string; name: string; modelId: string; baseUrl: string }`
  - `<ModelCombobox value endpoints endpointsLoaded disabled? onChange onAddEndpoint? onOpen? />`

No unit test — the repo has no React DOM test rig; behavior is pinned by e2e in Task 5. Verification here is typecheck.

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/src/components/ModelCombobox.tsx
// Rich "Model" picker for the workspace form (#256). Options carry two
// lines (name + modelId · baseUrl) and a badge, which a native <select>
// can't render — hence a hand-rolled listbox. Presentational: the parent
// owns the registry list and the selection; this component owns only
// open/close + active-option state and the listbox ARIA contract.

import { useEffect, useRef, useState } from 'react';
import type { ModelSelection } from './modelPicker';

export interface EndpointEntry {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
}

interface Props {
  value: ModelSelection;
  endpoints: EndpointEntry[];
  /** False until the first registry fetch resolves — suppresses the
   *  "(deleted endpoint)" state while the list is still loading. */
  endpointsLoaded: boolean;
  disabled?: boolean;
  onChange: (next: ModelSelection) => void;
  /** "＋ Add endpoint…" — parent opens Settings → Model Endpoints. */
  onAddEndpoint?: () => void;
  /** Fired on every open — parent refetches the registry. */
  onOpen?: () => void;
}

interface Option {
  /** 'claude' | endpoint id | '__add' */
  key: string;
  label: string;
  sub: string;
  badge: string;
}

export function ModelCombobox({
  value,
  endpoints,
  endpointsLoaded,
  disabled,
  onChange,
  onAddEndpoint,
  onOpen
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const options: Option[] = [
    { key: 'claude', label: 'Claude', sub: 'Anthropic · claude.ai account or API key', badge: '✳' },
    ...endpoints.map((e) => ({
      key: e.id,
      label: e.name,
      sub: `${e.modelId} · ${e.baseUrl}`,
      badge: '⬢'
    })),
    ...(onAddEndpoint ? [{ key: '__add', label: '＋ Add endpoint…', sub: 'opens Settings → Model Endpoints', badge: '' }] : [])
  ];

  const selectedKey = value.kind === 'claude' ? 'claude' : value.endpointId;
  const selected = options.find((o) => o.key === selectedKey);
  // Selected endpoint no longer in the registry: dangling. Only claim
  // "deleted" once the registry has actually loaded.
  const danglingLabel = endpointsLoaded ? '(deleted endpoint)' : '…';

  const openList = (): void => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.key === selectedKey)));
    setOpen(true);
    onOpen?.();
  };
  const closeList = (): void => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const pick = (key: string): void => {
    if (key === '__add') {
      setOpen(false);
      onAddEndpoint?.();
      return;
    }
    onChange(key === 'claude' ? { kind: 'claude' } : { kind: 'endpoint', endpointId: key });
    closeList();
  };

  // Click-outside closes without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent): void => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (!open) {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openList();
      }
      return;
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Home':
        ev.preventDefault();
        setActive(0);
        break;
      case 'End':
        ev.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        pick(options[active].key);
        break;
      case 'Escape':
      case 'Tab':
        closeList();
        break;
    }
  };

  return (
    <div className="model-combo" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={btnRef}
        className="model-combo-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className={`model-badge ${value.kind === 'claude' ? 'claude' : 'endpoint'}`}>
          {selected?.badge ?? '⬢'}
        </span>
        <span className="model-combo-meta">
          <b>{selected?.label ?? danglingLabel}</b>
          {selected && <small>{selected.sub}</small>}
        </span>
        <span className="model-combo-caret">▾</span>
      </button>
      {open && (
        <div className="model-combo-list" role="listbox" aria-label="Model options" aria-activedescendant={`model-opt-${active}`}>
          {options.map((o, i) => (
            <div
              key={o.key}
              id={`model-opt-${i}`}
              role="option"
              aria-selected={o.key === selectedKey}
              className={`model-combo-item${o.key === selectedKey ? ' sel' : ''}${i === active ? ' hover' : ''}${o.key === '__add' ? ' add' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.key)}
            >
              {o.badge && (
                <span className={`model-badge ${o.key === 'claude' ? 'claude' : 'endpoint'}`}>{o.badge}</span>
              )}
              <span className="model-combo-meta">
                <b>{o.label}</b>
                {o.sub && <small>{o.sub}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Append styles**

Append to `src/renderer/src/styles.css` directly after the `.kind-radio.disabled` rules (search for `/* ── Image library picker`; insert above that comment):

```css
/* ── Model combobox (workspace form, #256) ─────────────────────────── */
.model-combo { position: relative; }
.model-combo-btn {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: var(--bg-canvas); border: 1px solid var(--rule);
  border-radius: var(--r-md); padding: 6px 10px; cursor: pointer;
  color: var(--ink); font-size: 13px; text-align: left; font-family: var(--font-sans);
}
.model-combo-btn:focus-visible { outline: none; border-color: var(--ok); }
.model-combo-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.model-combo-caret { margin-left: auto; color: var(--ink-3); font-size: 11px; }
.model-combo-list {
  position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0;
  background: var(--bg-2); border: 1px solid var(--rule); border-radius: var(--r-md);
  box-shadow: var(--shadow-lg); overflow: hidden;
}
.model-combo-item { display: flex; gap: 10px; padding: 8px 10px; cursor: pointer; align-items: center; }
.model-combo-item.hover { background: var(--bg-hover); }
.model-combo-item.sel { box-shadow: inset 2px 0 0 var(--ok); background: var(--bg-hover); }
.model-combo-item.add { border-top: 1px solid var(--rule-soft); color: var(--ink-1); }
.model-combo-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.model-combo-meta b { font-weight: 500; font-size: 13px; }
.model-combo-meta small {
  font-family: var(--font-mono); font-size: 11px; color: var(--ink-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.model-badge {
  flex: none; width: 26px; height: 26px; border-radius: 6px; display: flex;
  align-items: center; justify-content: center; font-size: 13px; background: var(--bg-3);
}
.model-badge.claude { background: oklch(30% 0.06 45); }
.model-badge.endpoint { background: oklch(28% 0.06 240); }
.auth-note {
  display: flex; align-items: center; gap: 8px;
  border: 1px dashed var(--rule); border-radius: var(--r-md);
  padding: 8px 10px; font-size: 12px; color: var(--ink-2); background: var(--bg);
}
.auth-note b { color: var(--ink-1); font-weight: 500; }
.auth-note .auth-note-edit {
  color: var(--ink-1); text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ModelCombobox.tsx src/renderer/src/styles.css
git commit -m "feat(form): ModelCombobox listbox component + styles (#256)"
```

---

### Task 3: Wire `WorkspaceForm` to the Model picker

**Files:**
- Modify: `src/renderer/src/components/WorkspaceForm.tsx` (state ~lines 152–154, mount effect ~line 224, `buildPayload` ~lines 300–303 and 373–374, JSX ~lines 650–720)

**Interfaces:**
- Consumes: `modelPicker` helpers (Task 1), `ModelCombobox` + `EndpointEntry` (Task 2).
- Produces: new optional prop `onOpenSettings?: (tab: 'endpoints') => void` on `WorkspaceForm` (threaded by Task 4). Submit wire shape unchanged.

- [ ] **Step 1: Replace auth state with model + claudeAuth**

Replace lines 152–154:

```ts
const [authMode, setAuthMode] = useState<AuthMode>(initial?.authMode ?? 'oauth');
const [endpointId, setEndpointId] = useState<string | undefined>(initial?.endpointId);
const [endpoints, setEndpoints] = useState<Array<{ id: string; name: string; modelId: string; baseUrl: string }>>([]);
```

with:

```ts
const [model, setModel] = useState<ModelSelection>(() =>
  modelFromInitial(initial?.authMode, initial?.endpointId)
);
const [claudeAuth, setClaudeAuth] = useState<ClaudeAuth>(() =>
  claudeAuthFromInitial(initial?.authMode)
);
const [endpoints, setEndpoints] = useState<EndpointEntry[]>([]);
const [endpointsLoaded, setEndpointsLoaded] = useState(false);
```

Imports to add at the top of the file:

```ts
import { ModelCombobox, type EndpointEntry } from './ModelCombobox';
import {
  claudeAuthFromInitial,
  deriveAuthFields,
  modelFromInitial,
  type ClaudeAuth,
  type ModelSelection
} from './modelPicker';
```

Add to `interface Props` (after `extraFooterLeft`):

```ts
  /** Opens the app Settings modal on a tab — used by "＋ Add endpoint…" and
   *  the endpoint auth note's "edit" link. Threaded from App.tsx. */
  onOpenSettings?: (tab: 'endpoints') => void;
```

and destructure `onOpenSettings` in the component signature.

- [ ] **Step 2: Registry refetch callback**

Replace the endpoint fetch line inside the mount `useEffect` (line 224):

```ts
(window.api.endpoints.list() as Promise<Array<{ id: string; name: string; modelId: string; baseUrl: string }>>).then(setEndpoints);
```

with a named callback defined above the effect and reused by the combobox's `onOpen`:

```ts
const refreshEndpoints = (): void => {
  (window.api.endpoints.list() as Promise<EndpointEntry[]>).then((list) => {
    setEndpoints(list);
    setEndpointsLoaded(true);
  });
};
```

and call `refreshEndpoints();` in the mount effect where the old line was.

- [ ] **Step 3: Derive + validate in buildPayload**

Replace lines 300–303:

```ts
if (authMode === 'endpoint' && !endpointId) {
  setError('Pick a model endpoint.');
  return null;
}
```

with:

```ts
const { authMode, endpointId } = deriveAuthFields(model, claudeAuth);
if (
  model.kind === 'endpoint' &&
  endpointsLoaded &&
  !endpoints.some((e) => e.id === model.endpointId)
) {
  setError("This workspace's model endpoint was deleted — pick another model.");
  return null;
}
```

and simplify the return-object fields (lines 373–374) to:

```ts
authMode,
endpointId,
```

- [ ] **Step 4: Replace the Auth JSX**

Delete the whole `Auth mode` form-row (lines 650–701) **and** the conditional `Model endpoint` select row (lines 703–720). In their place:

```tsx
<div className="form-row" aria-label="Model">
  <label>Model</label>
  <ModelCombobox
    value={model}
    endpoints={endpoints}
    endpointsLoaded={endpointsLoaded}
    disabled={busy}
    onChange={setModel}
    onOpen={refreshEndpoints}
    onAddEndpoint={onOpenSettings ? () => onOpenSettings('endpoints') : undefined}
  />
</div>

{model.kind === 'claude' ? (
  <div className="form-row" aria-label="Auth mode">
    <label>Auth</label>
    <div className="kind-radios" role="radiogroup">
      <label className={`kind-radio ${claudeAuth === 'oauth' ? 'active' : ''}`}>
        <input
          type="radio"
          name="auth-mode"
          value="oauth"
          checked={claudeAuth === 'oauth'}
          onChange={() => setClaudeAuth('oauth')}
          disabled={busy}
        />
        <span>OAuth</span>
        <span className="kind-help">log in via Claude.ai</span>
      </label>
      <label
        className={`kind-radio ${claudeAuth === 'apikey' ? 'active' : ''} ${apiKeyAvailable ? '' : 'disabled'}`}
        title={apiKeyAvailable ? '' : 'Add ANTHROPIC_API_KEY in Env vars to enable'}
      >
        <input
          type="radio"
          name="auth-mode"
          value="apikey"
          checked={claudeAuth === 'apikey'}
          onChange={() => setClaudeAuth('apikey')}
          disabled={busy || !apiKeyAvailable}
        />
        <span>API key {!apiKeyAvailable && '🔒'}</span>
        <span className="kind-help">
          {apiKeyAvailable ? 'ANTHROPIC_API_KEY in env' : 'set ANTHROPIC_API_KEY below'}
        </span>
      </label>
    </div>
  </div>
) : (
  <div className="form-row" aria-label="Auth mode">
    <label>Auth</label>
    <div className="auth-note">
      🔑{' '}
      <span>
        <b>{endpoints.find((e) => e.id === model.endpointId)?.name ?? '(deleted endpoint)'}</b>{' '}
        — key from endpoint registry (none stored → placeholder token)
        {onOpenSettings && (
          <>
            {' · '}
            <a className="auth-note-edit" onClick={() => onOpenSettings('endpoints')}>
              edit
            </a>
          </>
        )}
      </span>
    </div>
  </div>
)}
```

Note: `AuthMode` stays imported from `'../App'` (still used by `WorkspaceFormSubmit`). Radio memory ("switch away and back keeps the radio") is free — `claudeAuth` state is never reset by model changes.

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: clean / all pass

- [ ] **Step 6: e2e sanity on the untouched flows**

Run: `npm run build && xvfb-run -a npx playwright test tests/create-flow.spec.ts tests/endpoint-workspace.spec.ts` (with `ELECTRON_DISABLE_SANDBOX=1`)
Expected: PASS — default create still submits `authMode: 'oauth'`; the seeded endpoint resume flow is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/WorkspaceForm.tsx
git commit -m "feat(form): Model combobox row + contextual Auth, drop Endpoint radio (#256)"
```

---

### Task 4: Settings deep-link plumbing

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx` (~lines 57–66)
- Modify: `src/renderer/src/App.tsx` (state line 169, render ~1251, WorkspaceModal/EditWorkspaceModal render sites)
- Modify: `src/renderer/src/components/WorkspaceModal.tsx`, `src/renderer/src/components/EditWorkspaceModal.tsx` (thread one prop)

**Interfaces:**
- Consumes: `onOpenSettings?: (tab: 'endpoints') => void` prop on `WorkspaceForm` (Task 3).
- Produces: `SettingsModal` prop `initialTab?: 'settings' | 'endpoints'`; `WorkspaceModal`/`EditWorkspaceModal` prop `onOpenSettings?: (tab: 'endpoints') => void`.

- [ ] **Step 1: SettingsModal initialTab**

In `SettingsModal.tsx`, extend `interface Props` with `initialTab?: ActiveTab;` and change line 66:

```ts
const [activeTab, setActiveTab] = useState<ActiveTab>('settings');
```

to:

```ts
const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab ?? 'settings');
```

(destructure `initialTab` in the component signature; move `type ActiveTab` above `interface Props` and export it: `export type ActiveTab = 'settings' | 'endpoints';`).

- [ ] **Step 2: App.tsx state + threading**

Replace line 169 `const [settingsOpen, setSettingsOpen] = useState(false);` with:

```ts
const [settingsTab, setSettingsTab] = useState<null | 'settings' | 'endpoints'>(null);
```

Update every `setSettingsOpen(true)` call site to `setSettingsTab('settings')`, every `setSettingsOpen(false)` to `setSettingsTab(null)` (grep `settingsOpen` — gear button + modal onClose). Update the render at ~1251:

```tsx
{settingsTab && (
  <SettingsModal
    initialTab={settingsTab}
    ...existing props unchanged...
  />
)}
```

Pass `onOpenSettings={(tab) => setSettingsTab(tab)}` to `<WorkspaceModal …>` and `<EditWorkspaceModal …>`; in both components add the prop to their `Props` interface and forward it to every `<WorkspaceForm …>` they render (two sites in WorkspaceModal — Saved-row expanded form at ~line 343 and New tab at ~line 379 — one site in EditWorkspaceModal at ~line 87).

**Stacking check:** `SettingsModal` must render *after* (below in JSX) the workspace modals in App's return so it stacks on top; both use the same `.modal-backdrop` pattern. If it currently renders earlier, move the block.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `npm run typecheck`
Expected: clean

Run: `CLAUDE_FLEET_MOCK=1 npm run dev` (if a display is available) — open Add workspace → Model → "＋ Add endpoint…" → Settings opens on the Model Endpoints tab over the workspace modal; close Settings → the form state (typed name etc.) is intact.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/SettingsModal.tsx src/renderer/src/components/WorkspaceModal.tsx src/renderer/src/components/EditWorkspaceModal.tsx
git commit -m "feat(form): deep-link Settings → Model Endpoints from the Model picker (#256)"
```

---

### Task 5: e2e coverage

**Files:**
- Modify: `tests/_helpers.ts` (MockOpts + `endpoints:list` handler, ~lines 196–260)
- Create: `tests/model-picker.spec.ts`

**Interfaces:**
- Consumes: `launch`, `mockMainIpc`, `getCalls` from `tests/_helpers.ts`; UI from Tasks 2–4.
- Produces: `MockOpts.endpoints?: Array<{ id: string; name: string; modelId: string; baseUrl: string }>`.

- [ ] **Step 1: Mock the endpoints registry in _helpers**

In `mockMainIpc`: add `'endpoints:list'` to the `channels` array (so any real handler is removed), add to `MockOpts`:

```ts
endpoints?: Array<{ id: string; name: string; modelId: string; baseUrl: string }>;
```

and register next to the other handlers inside the same `app.evaluate`:

```ts
ipcMain.handle('endpoints:list', () => opts.endpoints ?? []);
```

- [ ] **Step 2: Write the spec**

```ts
// tests/model-picker.spec.ts
// Model combobox in the workspace form (#256): endpoint selection derives
// authMode/endpointId on the wire; Auth morphs; dangling endpoints block
// submit; saved-tab resume keeps endpointId (the #252 savedToInitial bug).
import { expect, test } from '@playwright/test';
import { getCalls, launch, mockMainIpc } from './_helpers';

const EP = { id: 'ep1', name: 'ollama-local', modelId: 'qwen3:4b', baseUrl: 'http://host.docker.internal:11434' };

test('picking an endpoint morphs Auth and submits authMode=endpoint', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('ep-ws');

    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /ollama-local/ }).click();

    // Auth radios are gone; the passive note names the endpoint.
    await expect(window.getByRole('radio', { name: 'OAuth' })).toBeHidden();
    await expect(window.locator('.auth-note')).toContainText('ollama-local');
    await expect(window.locator('.auth-note')).toContainText('key from endpoint registry');

    await window.getByRole('button', { name: 'Create & start' }).click();
    const calls = await getCalls(app);
    expect(calls.create[0]).toMatchObject({ name: 'ep-ws', authMode: 'endpoint', endpointId: 'ep1' });
  } finally {
    await app.close();
  }
});

test('empty registry: combobox lists Claude + Add endpoint only; default submit stays oauth', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    const options = window.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText('Claude');
    await expect(options.last()).toContainText('Add endpoint');
    await window.keyboard.press('Escape');

    await window.getByLabel('Workspace name').fill('plain-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    const calls = await getCalls(app);
    expect(calls.create[0]).toMatchObject({ authMode: 'oauth' });
    expect((calls.create[0] as { endpointId?: string }).endpointId).toBeUndefined();
  } finally {
    await app.close();
  }
});

test('radio memory: model switch away and back keeps the Claude auth choice', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    // Enable the API-key radio by adding the env var, then select it.
    await window.getByText('Env vars').click();
    await window.getByRole('button', { name: '+ Add env var' }).click();
    await window.getByLabel('Env key 1').fill('ANTHROPIC_API_KEY');
    await window.getByLabel('Env value 1').fill('sk-test');
    await window.getByRole('radio', { name: /API key/ }).check();

    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /ollama-local/ }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /Claude/ }).click();
    await expect(window.getByRole('radio', { name: /API key/ })).toBeChecked();
  } finally {
    await app.close();
  }
});

test('dangling endpoint: edit form shows (deleted endpoint) and blocks submit', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      endpoints: [], // registry no longer has ep-gone
      workspaceList: [
        { name: 'stale-ep-ws', state: 'stopped', authMode: 'endpoint', endpointId: 'ep-gone', kind: 'container', image: 'x' }
      ]
    });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    const row = window.locator('.saved-row', { hasText: 'stale-ep-ws' });
    await row.click();
    await expect(row.getByRole('button', { name: 'Model' })).toContainText('(deleted endpoint)');
    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(row.getByText(/model endpoint was deleted/)).toBeVisible();
    const calls = await getCalls(app);
    expect(calls.writeManifest).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('saved-tab resume keeps endpointId (#252 regression class)', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      endpoints: [EP],
      workspaceList: [
        { name: 'ep-resume-ws', state: 'stopped', authMode: 'endpoint', endpointId: 'ep1', kind: 'container', image: 'x' }
      ]
    });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    const row = window.locator('.saved-row', { hasText: 'ep-resume-ws' });
    await row.click();
    await expect(row.getByRole('button', { name: 'Model' })).toContainText('ollama-local');
    await row.getByRole('button', { name: 'Resume' }).click();
    const calls = await getCalls(app);
    expect(calls.writeManifest[0]).toMatchObject({ authMode: 'endpoint', endpointId: 'ep1' });
  } finally {
    await app.close();
  }
});

test('＋ Add endpoint… opens Settings on the Model Endpoints tab', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /Add endpoint/ }).click();
    await expect(window.getByRole('button', { name: /Model Endpoints/ })).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});
```

Selector note: the Settings tab button copy/roles must be checked against `SettingsModal.tsx` (~line 278) when implementing — adjust the last assertion's locator to the real tab markup.

- [ ] **Step 3: Build + run the new spec**

Run: `npm run build && ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test tests/model-picker.spec.ts`
Expected: 6/6 PASS (iterate on selectors as needed — the combobox is `getByRole('button', { name: 'Model' })` via its `aria-label`)

- [ ] **Step 4: Run the adjacent suites**

Run: `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test tests/create-flow.spec.ts tests/endpoint-workspace.spec.ts tests/shared-oauth.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/_helpers.ts tests/model-picker.spec.ts
git commit -m "test(e2e): model combobox flows — endpoint submit, dangling, resume round-trip (#256)"
```

---

### Task 6: SPEC.md + design doc + screenshots

**Files:**
- Modify: `docs/SPEC.md` (workspace-form / endpoint-UX wording — grep `Endpoint` / `auth mode` / `#250` to find the form-flow sentences)
- Modify: `docs/design/workspace-modal.md` (state §2 prose + new states section)
- Create: `tests/design-screenshots.spec.ts` (env-gated capture harness)
- Create: `assets/design/workspace-modal/06-model-combobox-open.png`, `07-endpoint-selected-auth-note.png`; refresh `02-empty-oauth-api-key-option-disabled.png`

**Interfaces:**
- Consumes: the finished UI (Tasks 2–4) and `mockMainIpc` endpoints support (Task 5).

- [ ] **Step 1: SPEC.md**

Find the sentences describing the form's auth selection (grep `docs/SPEC.md` for `Endpoint` and `endpoint` around the §2/UI and §11/#250 sections). Rewrite to describe current state (edit in place, no changelog prose), conveying exactly:

> The workspace form has a **Model** row (rich combobox: Claude first and default; one entry per registry endpoint showing `name`, `modelId · baseUrl`; a final "＋ Add endpoint…" entry that deep-links to Settings → Model Endpoints) directly above **Auth**. Auth is contextual: Model = Claude shows the OAuth/API-key radios; Model = endpoint replaces them with a passive note naming the endpoint's stored key. `authMode`/`endpointId` are derived in the renderer (`modelPicker.ts`) — the manifest and IPC shape are unchanged. A manifest `endpointId` missing from the registry renders "(deleted endpoint)" and blocks submit until re-picked.

- [ ] **Step 2: Screenshot harness**

```ts
// tests/design-screenshots.spec.ts
// Regenerates docs/design/workspace-modal.md captures. NOT part of the
// gate: skipped unless CF_SHOOT=1. Run:
//   npm run build && CF_SHOOT=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a \
//     npx playwright test tests/design-screenshots.spec.ts
import { test } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers';

test.skip(!process.env.CF_SHOOT, 'screenshot regen only (CF_SHOOT=1)');

const EP = { id: 'ep1', name: 'ollama-local', modelId: 'qwen3:4b', baseUrl: 'http://host.docker.internal:11434' };
const OUT = 'assets/design/workspace-modal';

test('capture workspace-modal states', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('tab', { name: 'New' }).click();
    const modal = window.locator('.modal-tabbed');

    // 02 — empty create form, Model=Claude, OAuth selected, API key locked
    await modal.screenshot({ path: `${OUT}/02-empty-oauth-api-key-option-disabled.png` });

    // 06 — Model combobox open
    await window.getByRole('button', { name: 'Model' }).click();
    await modal.screenshot({ path: `${OUT}/06-model-combobox-open.png` });

    // 07 — endpoint selected, Auth morphed to the registry-key note
    await window.getByRole('option', { name: /ollama-local/ }).click();
    await modal.screenshot({ path: `${OUT}/07-endpoint-selected-auth-note.png` });
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 3: Generate the captures**

Run: `npm run build && CF_SHOOT=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test tests/design-screenshots.spec.ts`
Expected: PASS; three PNGs written/updated under `assets/design/workspace-modal/`. (If no display/Xvfb is available in this environment, commit the harness and note in the PR that captures need one local run — do not hand-edit PNGs.)

- [ ] **Step 4: Update workspace-modal.md**

Rewrite state §2's paragraph: same screenshot filename, but describe the Model row (combobox, Claude default) above the Auth radios; API-key lock explanation stays. Append two new state sections:

```markdown
### 6. Model combobox open
![model combobox open](../../assets/design/workspace-modal/06-model-combobox-open.png)

The **Model** row sits directly above Auth. Claude is first and default; each
registry endpoint renders two lines (name, `modelId · baseUrl`) with a badge;
the final "＋ Add endpoint…" entry deep-links to Settings → Model Endpoints.
With an empty registry the list is just Claude + Add endpoint — there is no
locked dead-end state.

### 7. Endpoint selected — Auth morphs
![endpoint selected](../../assets/design/workspace-modal/07-endpoint-selected-auth-note.png)

With an endpoint selected there is nothing to choose under Auth: the radios
are replaced by a passive note naming the endpoint's stored key ("key from
endpoint registry (none stored → placeholder token) · edit"). Switching back
to Claude restores the radios with the previous selection intact. A workspace
whose endpoint was deleted shows "(deleted endpoint)" here and blocks submit
until re-picked.
```

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md docs/design/workspace-modal.md tests/design-screenshots.spec.ts assets/design/workspace-modal/
git commit -m "docs: SPEC + workspace-modal design doc for the Model picker; screenshot harness (#256)"
```

---

### Task 7: Full gate + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: clean / all pass / build succeeds

Run: `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npm run test:e2e`
Expected: PASS (full Playwright suite against the fresh build)

- [ ] **Step 2: Push + PR**

```bash
git push -u origin worktree-model-picker-ux
gh pr create --base main --title "feat(form): Model picker row replaces the Endpoint auth radio (#256)" --body "$(cat <<'EOF'
Closes #256. Spec: docs/superpowers/specs/2026-08-06-model-picker-form-ux-design.md

Renderer-only: a Model combobox (Claude + registry endpoints + "＋ Add endpoint…" deep-link) directly above a contextual Auth row. authMode/endpointId derived via a pure, unit-tested helper — no manifest/IPC changes, no migration. Fixes the empty-registry dead-end and the dangling-endpointId blank select (#252 follow-ups). SPEC.md + workspace-modal design doc updated; screenshot regen harness included.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens against `main`; the `build-app` PR workflow (build ×3 + e2e) goes green.
