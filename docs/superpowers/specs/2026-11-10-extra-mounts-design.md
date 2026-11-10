# Extra mounts for container workspaces — design

## Goal

Let the user bind additional host folders into a container workspace when creating or editing it.

## Scope

- `kind: 'container'` only. Local (native/WSL/custom) and remote workspaces are unchanged; the form hides the section for them.
- Any number of mounts per workspace.

## Data model

New optional manifest field on `WorkspaceSpec`:

```ts
mounts?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
```

Absent or empty means no extra mounts. Manifests on other kinds drop the field on read (same sanitize pattern as `launcher`).

## Validation (`src/main/extraMounts.ts`, pure + unit-tested)

Run in main on `workspace:create` and `workspace:writeManifest`; a failure rejects the call with a message naming the offending row.

Host path:
- exists and is a directory;
- its realpath is not inside `<userData>` (state, vault, DB, loadout library, MCP sockets);
- its realpath is not inside another workspace's private folder `<fleetRoot>/<otherId>`.

Container path:
- absolute, normalized (`path.posix.normalize`, no trailing slash, no `..`);
- not `/` and not exactly `/workspace`;
- not equal to or under any reserved prefix: `/shared`, `/home/fleet/.claude`, `/home/fleet/.claude.json`, `/run/broker`, `/fleet/mcp`, `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`;
- unique across the workspace's mounts.

`/workspace/<sub>` and `/mnt/...` are allowed.

## Container create (`docker.ts:createWorkspace`)

Each mount becomes `HostConfig.Mounts` entry `{ Type: 'bind', Source: hostPath, Target: containerPath, ReadOnly: readOnly }`. Mounts are used instead of `Binds` strings because Windows drive-letter paths make `host:ctr:ro` ambiguous and `Binds` silently creates missing host dirs as root, whereas `Mounts` errors.

Before creating, re-check each host path exists; if one is missing, fail the create with `extra mount <hostPath> no longer exists` rather than dropping the mount.

## Form (`WorkspaceForm`)

"Extra mounts" disclosure, container kind only. Row: host path (Browse button via `dialog:pickDirectory` + typed fallback), container path (prefilled `/mnt/<basename>` when empty, editable), `read-only` checkbox, remove button. "+ Add mount" appends a row. Client-side checks (absolute path, reserved prefix, duplicate) show inline; main remains authoritative. Clone prefill copies mounts.

Editing mounts on a running/paused workspace marks it changed for the existing restart-to-apply banner (mounts are a container-level field, like env/image/resources). On the Saved-tab edit path mounts follow whatever env/image edits do today — no separate apply mechanism.

## Observability rail

The Workspace card lists each extra mount below private/shared: `hostPath → containerPath` with `ro` when read-only; clicking reveals the host folder via `fs:openPath`.

## Security (SPEC §9)

Extra mounts are user-chosen host folders exposed to one container. The host-private zone (userData) and other workspaces' private folders are refused after realpath resolution, preserving the invariant that no container sees another's transcripts, secrets, DB, or private folder.

## SPEC.md updates

§*Docker container shape* binds, the `WorkspaceSpec` model, the create/edit form flow, `workspace:writeManifest` container-level field list, and §9.

## Testing

- Unit: validator (each rule, realpath symlink escape into userData, Windows-style host path), `createWorkspace` mount assembly, manifest sanitize, form helpers (default container path, change detection for restart banner).
- Gate: `npm run typecheck` (node and web configs separately), unit tests, build. UI checked on host by Troy — no display in the container.
