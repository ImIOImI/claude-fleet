# Declared port exposure — design

Date: 2026-11-05
Status: approved (design), pending implementation plan

## Problem

Dev-server preview is driven entirely by the broker port scan (`LISTPORTS` every 3s → HTTP probe → sticky `ports:detected` toast). The scan has no intent signal: any short-lived HTTP listener toasts. Unit tests that `listen(0, '127.0.0.1')` (`src/host/server.test.ts`, `remoteAttach.test.ts`, `remoteClient.test.ts`, `ociRedirect.test.ts`, `endpoints.test.ts`, `pgSsl.test.ts`, …) bind kernel-ephemeral ports (32768–60999), answer the probe, and leave a stack of sticky toasts that never point at anything.

## Goal

Make exposure intentional: an agent declares the port it wants the user to see, and only declared ports raise the preview popup. Scanned ports stay previewable from the Serving rail but are silent. Record every port's lifecycle so we can measure how often agents fail to declare and tune the fallback from data.

## Non-goals (v1)

- A container-side CLI / broker frame for declaring (scripts, the user's own terminal). The `source` column leaves room for it.
- Remote (fleet-host) workspaces.
- An allow/deny permission gate — the preview path is already loopback-only and created on click.
- A UI panel for the evaluation metrics; analysis is SQL via fleet-state `query`.

## Design

### 1. `expose_port` MCP tool (fleet-state)

`expose_port({ port, label, reason? })` → `{ status: 'shown' | 'waiting' }`

- Caller workspace is ambient (socket identity), like every fleet-state tool. Works for container and local/WSL workspaces.
- Validation: integer 1–65535, not in the ephemeral range 32768–60999 (rejected with an error explaining why); `label` required, ≤80 chars; `reason` ≤200 chars.
- If the port is already in the workspace's Serving snapshot (probe passed) → popup now, returns `shown`.
- Otherwise returns `waiting`; the host holds the declaration for 30s and raises the popup the moment the port passes the probe. If it never does, the record's `outcome` becomes `not_serving` and no popup is shown.
- Re-declaring a port whose popup is already showing is a no-op (still `shown`); re-declaring updates `label`/`reason`.
- Rate limit: 10 calls/min per workspace (shares nothing with the inbox post limit).
- Local workspaces have no broker scan; the host probes `127.0.0.1:<port>` directly for them and the preview opens the port directly (no forward needed).

### 2. Popup

Reuses the existing sticky toast keyed `port:<workspaceId>:<port>` (so a restart replaces it):

> **Preview** · *Work* wants to show you **Vite dev server** on :5173
> reason line (if given) · `cmdline` (if known)
> [Open preview] [✕]

- **Open preview** → existing `ports:open` path; outcome `opened`, `opened_via='popup'`.
- **✕** → outcome `dismissed`. The port stays in the rail.
- Never acted on before the port stops listening → outcome `ignored`.

`ports:detected` is now fired only for declared ports (and the fallback below). Its payload gains `{ label, reason, declared: boolean }`.

### 3. Scanned (undeclared) ports

- Still enter the Serving snapshot and the rail with ↗ / ✕, unchanged.
- Rail rows for declared ports show `label` in place of the cmdline (cmdline moves to the tooltip).
- No toast by default.
- **Fallback knob:** `ports.undeclaredToastAfterSec` in `config.json` (default `0` = never). When > 0, an undeclared, non-ephemeral port still serving after N seconds gets the toast, tagged "undeclared". Ephemeral-range ports never trigger it.

### 4. Agent guidance

- The tool description says when to call it: "after starting a server the user should look at (dev server, docs preview, report) — not for test fixtures or internal tools".
- One line added to the injected workspace instructions: *"When you start a server for the user to view, call `expose_port`."* This is the first lever to strengthen if adoption is low.

### 5. Evaluation record — `port_exposures`

New state-store table (both SQLite and Postgres dialects via the async Kysely layer; schema-parity test updated). One row per port *appearance* (a port that stops listening and comes back gets a new row).

| column | type | notes |
|---|---|---|
| `id` | text (ULID) | |
| `workspace_id` | text | |
| `session_id` | text null | broker session that owns the listener, when attributed |
| `port` | integer | |
| `cmdline` | text null | |
| `label` | text null | from `expose_port` |
| `reason` | text null | |
| `source` | text | `declared` \| `scanned` \| `both` |
| `first_scanned_at` | integer null | epoch ms, first probe-pass |
| `declared_at` | integer null | epoch ms |
| `popup_shown_at` | integer null | |
| `outcome` | text null | `opened` \| `dismissed` \| `ignored` \| `not_serving`; null while open |
| `opened_via` | text null | `popup` \| `rail` \| `fallback` (first open) |
| `open_count` | integer | default 0 |
| `ended_at` | integer null | port stopped listening / workspace stopped |

Lifecycle: a row opens on whichever of probe-pass or declaration comes first; the other fills in when it arrives (`source` → `both`). Rail ↗ and popup opens increment `open_count`. The row closes at `ended_at`; an unset outcome becomes `ignored` (or `not_serving` if it was declared and never passed the probe). Ephemeral-range scanned ports are not recorded (they are noise by construction and would swamp the table).

Exposure through fleet-state: added to the `query` snapshot tables, filtered to the caller's allowed workspaces like `events`; listed in the `query` tool description.

Key metric — missed declarations (scanned, wanted, never declared):

```sql
SELECT count(*) FILTER (WHERE declared_at IS NULL AND open_count > 0) AS missed,
       count(*) FILTER (WHERE declared_at IS NOT NULL)                AS declared,
       count(*) FILTER (WHERE declared_at IS NOT NULL AND open_count > 0) AS declared_opened
FROM port_exposures
WHERE ended_at IS NOT NULL AND first_scanned_at > :since;
```

Weaker signal: undeclared rows with `ended_at - first_scanned_at > 60000`.

Retention: rows older than 90 days are pruned with the existing state-db housekeeping.

## Error handling

- Unknown/stopped workspace, invalid port, ephemeral port, rate limit → tool error with a plain message.
- Declaration for a port that never serves within 30s → `not_serving` row, no popup, no error to the agent (the call already returned).
- Workspace stops with pending declarations → rows closed, pending waits cancelled, toasts cleared (existing `onChanged(ws, [])` path).
- Pre-existing runner images are unaffected: everything is host-side; no broker change.

## Spec impact (SPEC.md)

- §2 Non-goals: drop "no manual port pinning" for declared exposure; keep "no LAN exposure / no arbitrary host:port".
- §6 *Ports*: `ports:detected` payload + firing rule; `port_exposures` schema.
- §8 *Dev-server preview*: declared flow, fallback knob.
- §11 fleet-state: `expose_port`; `query` table list.
- Settings: `ports.undeclaredToastAfterSec`.

## Testing

- Unit: lifecycle state machine (scan-first, declare-first, both, re-appearance → new row, ignored/not_serving closure); 30s wait with fake timers; ephemeral rejection; rate limit; fallback knob on/off.
- MCP contract tests: `mcpServer.test.ts` + `tests/mcp-*.spec.ts` for the new tool and `query` table.
- Schema parity (SQLite ↔ Postgres) for `port_exposures`.
- Mock mode: a fake declared port so the popup is exercisable under `CLAUDE_FLEET_MOCK=1`; e2e drives it via the existing `__test:setServingPorts` hook plus a declare hook.
- Host eyeball (Troy): run a vitest suite with HTTP fixtures → no toasts; have an agent start Vite and declare → one labeled popup.
