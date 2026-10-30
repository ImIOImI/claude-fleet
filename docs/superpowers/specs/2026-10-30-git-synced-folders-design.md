# Git-synced shared folders

Sub-project 2 of the remote-agent design (`/shared/remote-agent-design/design-state.md`).
Expertise libraries and review records are shared between nodes (desktops and the EKS
agent) through git repos synced into `/shared/<name>`. Sync is **an automation**, not an
app feature. A script in the runner image does the git work; a scheduled automation runs it
in a workspace that already has git credentials.

## Goal

- Several nodes read and write the same files (`fleet-reviews`, `fleet-expertise`). Each
  node keeps a full local copy, so reads and writes keep working offline and during outages.
- Any git remote works. No new credential storage: the script runs where workspaces already
  have `GH_TOKEN` / `gh auth` (desktop) or the GitHub App token (agent).
- Status, failures and history appear through the existing automation surfaces (run detail,
  inbox todos, notifications).

## Non-goals

- A background syncer in the main process, a credential UI, or a status panel.
- Automatic PRs. Proposing changes to a mirrored repo stays an explicit action (`gh pr create`,
  `curate-experts`).
- Sub-minute latency. Changes propagate within one schedule tick (5 min).
- Syncing `/shared` as a whole. Only folders listed in the config are touched.

## Config: `/shared/.git-sync.yaml`

Plain data, no secrets, one per node (the agent's is rendered from platform-ops values).

```yaml
folders:
  - name: fleet-reviews            # → /shared/fleet-reviews; [a-z0-9._-]+, no slashes
    remote: https://github.com/SumerSports/fleet-reviews.git
    branch: main                   # default: main
    mode: auto-sync                # auto-sync | mirror (default: mirror)
    author: troy@platform          # required for auto-sync: commit name; email <author>@fleet.invalid
  - name: fleet-expertise
    remote: https://github.com/SumerSports/fleet-expertise.git
    mode: mirror
```

Validation errors (unknown mode, bad name, `auto-sync` without `author`, duplicate names)
fail the whole run (exit 2) with the error on stderr. Nothing is touched.

## Script: `fleet-git-sync`

`docker/runner/fleet-git-sync` → `/usr/local/bin/fleet-git-sync` in the base runner image,
so devops, agent and downstream (Sumer) images inherit it. It needs bash, git, jq and yq. yq is
already in devops; the base image gains `yq` via `docker/scripts/yq.sh`.

Usage: `fleet-git-sync [--config PATH] [--root PATH]` (defaults `/shared/.git-sync.yaml`,
`/shared`). Credentials come from the environment: when `GH_TOKEN` is set, the script configures
git's credential helper for `github.com` with it for the run, never in `.git/config` or on disk.
Otherwise it uses whatever git/gh already provide.

For each folder, independently (one folder's failure never blocks another):

1. **Missing** → `git clone --branch <branch> <remote> <root>/<name>`, then set
   `core.autocrlf=false` and `core.fileMode=false` (Windows bind mounts).
   A non-empty, non-git directory at that path is an error for that folder (never clobbered).
2. **auto-sync**
   - Local changes → `git add -A`, then commit with author/committer `<author> <<author>@fleet.invalid>`
     and the message `sync: <n> files from <author>`.
   - `git pull --rebase`. On a rebase conflict: `git rebase --abort` (local commits kept), emit a
     todo keyed `git-sync:<name>:conflict`, and move to the next folder.
   - `git push`. On a non-fast-forward rejection, pull --rebase and push once more. A second
     failure counts as a failure for this folder.
3. **mirror**
   - Local edits (tracked changes or untracked files) → **not discarded**. Emit a todo keyed
     `git-sync:<name>:local-edits` ("local edits in mirror <name>: propose them via PR or
     discard them") and skip the pull for this folder.
   - Otherwise `git pull --ff-only`. Divergence (local commits) gets the same todo and a skip.

**Failures and outages.** Network and auth errors are counted per folder in the script's
`state` (`{"failures": {"<name>": n}}`). A success resets the counter. The script emits a
`notify` (keyed `git-sync:<name>:failing`) only when a folder reaches **3 consecutive
failures**, so a short outage stays quiet. Conflict and local-edit todos deduplicate by key, so a
persistent condition shows as one todo with a rising seen count, not a flood.

**Exit codes** (the script-step protocol): `10` (nothing to do) when every folder was already
current and nothing was pushed; `0` when anything was cloned, pulled or pushed, or a per-folder
failure was reported through todo/notify/state; `2` for a broken config. Plain stdout lines
summarise each folder (`fleet-reviews: pushed 2 files, pulled 3 commits`) for the run detail.

## Automation: the `git-sync` loadout

A new loadout in `claude-fleet-loadouts`: `loadouts/git-sync/`, with `loadout.md` plus
`automations/git-sync/automation.yaml`, installed into the workspace that should run sync
(normally the automations workspace):

```yaml
name: git-sync
description: Sync the git-backed folders listed in /shared/.git-sync.yaml
triggers:
  - schedule: { cron: "*/5 * * * *" }
  - manual: {}
concurrency: skip
steps:
  - id: sync
    script: { run: fleet-git-sync, runIn: $self, timeout: 4m }
```

Every 5 minutes is the low-risk floor, so it is not an approval-gated schedule. `runIn: $self`
binds to the installing workspace, whose env and `gh auth` provide credentials. On the agent the
same loadout is pinned in `FLEET_LOADOUTS`, and fleet-node exports the GitHub App installation token
as `GH_TOKEN` to script steps.

The loadout's `loadout.md` documents the config file and points to this spec. The loadout
carries no script: it calls the image's `fleet-git-sync`, so the script version follows the
image, not the loadout.

## Who writes what (conventions this enables)

- `fleet-reviews`: **auto-sync** on every node. Each node writes only `<author>/…`, its own
  author folder (people `<name>@<team>`, agents `agent-<name>@<team>`). Single writer per folder,
  so rebase only ever replays non-overlapping paths.
- `fleet-expertise`: **mirror** on nodes that aren't a library's maintainer, including the agent.
  Maintainers run **auto-sync** only if the repo allows direct pushes for them; otherwise they use
  mirror plus PRs. CODEOWNERS decides; the script doesn't.

## Testing

- `src/main/automations/fleetGitSync.test.ts` (vitest, the `fleetEmit.test.ts` pattern; skipped on
  Windows or without git/jq/yq) runs the real script against throwaway bare repos in a temp dir.
  - **Clone:** a missing folder is cloned, and a non-git directory is refused.
  - **auto-sync:** a commit carries the right author; a push race resolves with one retry; a rebase
    conflict leaves local commits intact and emits a conflict todo.
  - **mirror:** fast-forward; local edits are kept and emit a local-edits todo; divergence is skipped.
  - **Failures:** an unreachable remote increments state, notifies on the 3rd consecutive
    failure, and a success resets the counter.
  - **Exit codes:** 10 when current, 0 when changed, 2 on a bad config.
  - **GH_TOKEN:** the token is never written to `.git/config`.
- The loadout's `automation.yaml` validates through `loadoutAutomations` (an existing test pattern),
  run in the loadouts repo's `make dry-run`.

## SPEC.md changes (same PR as the implementation)

- §4 *Runner image*: `fleet-git-sync` and `yq` in the base image; the script contract.
- §7 *Data model*: `/shared/.git-sync.yaml`.
- §8 *Automations*: the git-sync loadout as the way to share folders between nodes.
- §1/§3: rewrite "not a remote orchestrator / no remote daemons" to reflect the remote-agent
  direction. The app still never drives remote Docker. A headless node (sub-project 3) syncs
  through fleet-sync (sub-project 4).
