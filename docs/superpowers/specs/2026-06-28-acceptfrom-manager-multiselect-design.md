# Accept-from manager multiselect

## Problem

In the workspace edit form's **Committee access** section, "Accept from" is a
free-text input where the operator types comma-separated manager workspace **ids**
(`WorkspaceForm.tsx`). Ids are opaque ULIDs — easy to mistype, impossible to
recognize — so the field is error-prone and unfriendly. Replace it with a
checkbox list of the fleet's manager workspaces, selected by name.

## Scope

**Renderer-only.** Only `src/renderer/src/components/WorkspaceForm.tsx` (and a
small pure helper in `committee.tsx`) change. The stored shape is unchanged:
`accessibility.acceptFrom` is still `string[]` of workspace ids. No main / IPC /
data-model / SPEC-data change. The committee **UI** subsection of `docs/SPEC.md`
is updated in the same change (user-facing flow change).

## Design

### Candidate set — current managers only

The list shows every other **manager** container workspace:

```
workspaces.filter(w => w.id !== editedId && w.kind === 'container' && isManager(w))
```

- `editedId` = `initial?.id` (the workspace being edited); a workspace can't
  accept control from itself.
- `kind === 'container'` mirrors the control gate (committee control is
  container-only).
- `isManager(w)` (`committee.tsx` — holds ≥1 outbound grant) is the eligibility
  predicate, matching the user's intent ("manager workspaces are listed").

A pure helper `eligibleAcceptFromManagers(workspaces, selfId)` in `committee.tsx`
(next to `isManager`) encapsulates this filter so it is unit-testable without the
DOM.

### Presentation — always-visible checkbox list

Replaces the `<input>` at `WorkspaceForm.tsx:858-866`. A bordered box; one row per
candidate: a checkbox + the manager's `name` (with `title={w.id}` for
disambiguation — names are fleet-unique, so the name alone is the label). No role
hint is shown (roleHint is an inbound/expert property; managers don't carry one).
Toggling a row adds/removes that id from the selection.

- **Empty state** (no managers): muted hint — *"No manager workspaces yet — grant
  a workspace control over an expert in the Committee rail first."*
- **Helper line** under the box: *"None selected = any granted manager may control
  this workspace."* — surfaces the existing `blank = any granted` semantics so an
  empty selection isn't read as "nobody."

### State + serialization

- `acceptFrom` form state changes from a comma-joined `string` to `string[]`,
  initialized from `initial?.accessibility?.acceptFrom ?? []`.
- On submit, `acceptFromList` = the selected ids. By construction these are only
  current managers, so any previously-saved id that is **not** a current manager
  gets no row and is not re-added — it is **dropped on save** (deliberate: the
  whitelist self-prunes to current managers). The existing serialization is
  otherwise unchanged:

  ```ts
  ...(acceptFromList.length ? { acceptFrom: acceptFromList } : {})
  ```

  so an empty selection clears `acceptFrom` (⇒ "any granted").

### Interaction with the rest of the committee model

`acceptFrom` continues to gate both **control** (`decideControl`) and
**discovery** (`decideRoster`) exactly as today — this change only alters how the
operator edits the list, not its meaning. Empty still means "any granted manager";
a named list still whitelists specific managers.

## Testing

- **Unit (TDD):** `committee.test.ts` (or co-located) for
  `eligibleAcceptFromManagers` — excludes self, excludes non-container, excludes
  non-managers, includes managers; stable across an empty fleet.
- **E2e:** extend `tests/workspace-modal.spec.ts` — in edit mode with a manager
  peer present, the Committee access section renders the manager as a checkbox;
  checking it and saving calls `writeManifest` with `accessibility.acceptFrom`
  containing that manager's id; unchecking + save clears it.

## Non-goals

- Listing non-manager workspaces (rejected — managers only, per decision).
- Preserving stale/non-manager ids already in `acceptFrom` (rejected — dropped on
  save).
- A dropdown/chip presentation (rejected in favor of an always-visible list).
- Any change to the left-rail Committee grant matrix (`CommitteePane.tsx`) — that
  edits the *manager's* outbound grants and is out of scope here.
