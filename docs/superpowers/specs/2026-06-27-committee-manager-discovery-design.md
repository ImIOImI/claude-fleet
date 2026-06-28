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

### 2. Discoverability gate — honors the same `acceptFrom` contract as control

An expert is listed in a caller's roster iff a pure `decideRoster` decision
passes, mirroring `decideControl`'s container-only + no-manager-target + reachable
rules and interpreting `acceptFrom` **the same way control does** (so the two
never disagree about who "blank" admits):

- both caller and target are containers; target is not itself a manager; not a
  self-entry; target `accessibility.reachable === true`; and:
- `acceptFrom` **names the caller** → discoverable **without a grant** (pre-grant
  discovery — the operator explicitly advertised to this manager);
- `acceptFrom` **blank/empty** → *"any granted"*: discoverable **iff the caller
  already holds a grant** over the target;
- `acceptFrom` **non-empty but omits the caller** → never discoverable (explicit
  whitelist; a grant cannot override it).

The blank case is gated by an existing grant so the roster never reveals more
than control already allows, and a `reachable` expert with open `acceptFrom` is
never advertised to *ungranted* managers — while staying consistent with
`decideControl` and the UI's *"blank = any granted"* copy (the original
"acceptFrom must be non-empty AND name the caller" rule contradicted that copy and
was reconciled).

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
