# Committee manager discovery — roster + enriched status

## Problem

A committee manager's Claude agent can only act on expert workspace ids the
operator hands it, and the only descriptive signal it ever sees over MCP is
`roleHint` (free text), surfaced solely in the host's Committee rail UI — not to
the manager agent. The agent cannot enumerate the experts available to it, and
the per-id `committee_status` tool returns liveness only (`paused`/`busy`/
`stalled`/`lastActiveAt`) with no descriptive metadata. So a manager driving a
committee is effectively blind to who its experts are and what they specialize
in.

This adds the missing discovery + metadata surface, without widening the
*control* surface (no new way to act on an expert).

## Decisions

### 1. New `committee_roster` MCP tool (discovery)

Input: none. Returns an array, one entry per **discoverable** expert:

```
{
  id, name, description, labels, roleHint,
  installedLoadouts: [{ id, title }],            // capability signal, titles only — no file bodies
  status: { paused, busy, stalled, lastActiveAt },
  grant:  { controllable: boolean, verbs: CommitteeVerb[] }
}
```

`grant.controllable` is whether *this* caller currently holds any grant over the
entry; `verbs` lists which. An entry with `controllable: false` is visible for
discovery but not yet actionable — the manager asks the operator to grant
control in the Committee rail.

### 2. Discoverability gate — `acceptFrom` only

An expert is listed in a caller's roster iff a pure `decideRoster` decision
passes, mirroring `decideControl` minus the outbound-grant check:

- both caller and target are containers (identity is only unspoofable for
  containers — same constraint as control);
- target is not itself a manager (no manager-of-managers visibility);
- not a self-entry;
- target `accessibility.reachable === true`;
- **`accessibility.acceptFrom` is non-empty AND names the caller.**

The last rule is the deliberate choice: an expert with an **open/empty
`acceptFrom`** is *controllable-if-granted* but **NOT roster-visible**.
Discovery requires the operator to explicitly name the manager in the expert's
`acceptFrom`. This keeps `reachable` from silently becoming a fleet-wide
advertisement and reuses an existing field rather than adding a new
`discoverable` flag.

Note the resulting asymmetry (documented in SPEC): empty `acceptFrom` permits
control (when a grant exists) but not discovery. `acceptFrom` ≠ grant, so the
"discover → ask operator for a grant" flow still works — the expert lists the
manager in `acceptFrom` before any grant exists, appearing with
`grant.controllable: false`.

No grant is required to appear in the roster — that is the intended discovery
widening.

### 3. Enriched `committee_status`

Keeps its `read`-grant gate (`assertControl(caller, target, 'read')`). Adds
`name`, `description`, `labels`, `roleHint`, `installedLoadouts: [{ id, title }]`
to the existing liveness fields. No new exposure: a `read` grant already
authorizes reading the target.

### 4. Freshness

Both roster and enriched status read manifests **fresh per call** (the existing
committee invariant — no cached authority), so an opt-out / `acceptFrom` edit /
de-reachability takes effect on the very next call.

## Security implications

Roster is the one piece that widens what a manager *agent* (an LLM in a
container) can see. Implications and mitigations:

- **Metadata disclosure / enumeration.** A discoverable expert's
  `description`/`labels`/`roleHint` (operator-authored) and loadout titles enter
  the manager agent's context. Bounded by the `acceptFrom` gate — the operator
  explicitly names which managers may see each expert.
- **Loadout titles as capability fingerprint.** Only `id` + `title` are exposed,
  never file bodies/scripts.
- **Injection vector.** Loadout titles originate from OCI artifacts (externally
  authored). All roster string fields are treated as **data, not instructions**,
  and titles are length-capped. Documented in the tool description and SPEC.
- **No new action surface.** Roster is read-only; `pause`/`post`/`collect` still
  pass `assertControl`. Discovery never implies control.
- **Timing side-channel.** Inline liveness for discoverable-but-ungranted experts
  leaks activity patterns — accepted, bounded by the `acceptFrom` gate.

## Scope

`claude-fleet` only. The built-in `committee-manager` loadout (generated in
`loadouts.ts:committeeStarters`) and `docs/SPEC.md` (committee + security
sections) are updated in the same change. No `claude-fleet-loadouts` /
loadout-format contract change.

## Implementation surface

- `src/main/control.ts` — pure `decideRoster` + `buildRoster` (status injected →
  unit-testable with no I/O).
- `src/main/ipc.ts` — `committeeRoster(callerId)` handler (fresh manifest scan),
  `committee:roster` IPC channel, enriched `committeeStatus`.
- `src/main/mcpServer.ts` — `committee_roster` tool, `roster` on
  `CommitteeHandlers`, enriched `committee_status` description.
- `src/main/loadouts.ts` — teach the `run-committee` skill + manager CLAUDE.md
  block the new tool.
- `src/main/control.test.ts` — `decideRoster` truth table + `buildRoster` shaping.
- `docs/SPEC.md` — committee tools + security model.
