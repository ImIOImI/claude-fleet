# Git-synced shared folders

Part of the remote-node direction: several claude-fleet nodes (desktops, and headless nodes
such as an always-on agent) share knowledge and work products as files. This spec covers file
sharing only. Folders under `/shared/<name>` are kept in sync with git remotes by **an
automation**, not an app feature. Everything a node needs ships as **loadouts**:
- a generic `git-sync` loadout holds the script and the automation;
- an organisation's own loadout holds its config.

## Goal

- Several nodes read and write the same files. Each node keeps a full local clone, so reads and
  writes keep working offline and during outages, and catch up when the remote is reachable.
- Any git remote and host works. No new credential storage: sync runs inside a workspace that
  already has credentials (a `GH_TOKEN`-style env var from the vault, `gh auth`, SSH, or a
  token the node's runtime provides).
- All local setup is contained in loadouts: installing them and setting one env var is the whole
  setup. There's no runner-image change and no hand-written files.
- Status, failures and history appear through existing automation surfaces (run detail, inbox
  todos, notifications).

## Non-goals

- A background syncer in the main process, a credential UI, or a status panel.
- Automatic PRs. Proposing changes to a mirrored repo stays an explicit action.
- Sub-minute latency. Changes propagate within one schedule tick (5 min).
- Syncing `/shared` as a whole. Only configured folders are touched.

## Packaging: two loadouts

**`git-sync`** (generic; published in `claude-fleet-loadouts`):

```
loadouts/git-sync/
  loadout.md                  # docs; install scripts (below)
  automations/git-sync/
    automation.yaml           # schedule, runIn: $self
    fleet-git-sync.sh         # the sync script, inlined into the automation at install
  examples/example.yaml       # copied to /shared/.git-sync.d/example.yaml.sample
```

`loadout.md` frontmatter:
- `dependencies.tools`: `git`, `jq`.
- `scripts` (run at install, inside the workspace):
  - **ensure `yq`:** install it if missing (`unless: command -v yq`), as an arch-aware static
    binary into `~/.local/bin`;
  - **write the example:** create `/shared/.git-sync.d/` and copy the example as
    `example.yaml.sample` (`unless:` it exists). The `.sample` suffix means it's never loaded.

The script is inlined through the existing `run: ./file.sh` mechanism (limit 20,000 characters), so
**updating sync is a loadout version bump**, not an image republish and workspace recreate.

**An organisation config loadout** (e.g. `git-sync-acme`, published from the organisation's own,
typically private, loadout source):

```yaml
# loadout.md frontmatter
title: Git sync (Acme)
version: 1.0.0
description: Acme's shared review and knowledge repos for git-sync. Install once per node.
dependencies:
  loadouts:
    - { id: git-sync, version: "^1.0.0" }
scripts:
  - label: write Acme git-sync config
    run: mkdir -p /shared/.git-sync.d && cp ./acme.yaml /shared/.git-sync.d/acme.yaml
    unless: test -f /shared/.git-sync.d/acme.yaml
```

It carries **config only**. The script and automation come from `git-sync` through the
dependency, so there's no copy to drift. An organisation can ship several config loadouts (per team,
per project); each drops its own file into the conf.d directory.

## Config: `/shared/.git-sync.d/*.yaml`

The script loads every `*.yaml` in the directory (sorted). `*.sample` files are ignored. Plain
data, no secrets.

```yaml
folders:
  - name: reviews                  # → /shared/reviews; [a-z0-9._-]+, no slashes
    remote: https://git.example.com/acme/reviews.git
    branch: main                   # default: main
    mode: auto-sync                # auto-sync | mirror (default: mirror)
    author_scoped: true            # default true: commit only <author>/…; false = whole tree
  - name: knowledge
    remote: https://git.example.com/acme/knowledge.git
    mode: mirror
```

**Author = the node id.** It's not in the config, because config files are shared across an
organisation. The script reads `FLEET_NODE_ID` (format `<name>@<team>` for people,
`agent-<name>@<team>` for agents). A headless node's runtime sets it; on a desktop it's set
once as an env var on the workspace the loadout is installed into. Without it, **auto-sync
folders are skipped** and a todo keyed `git-sync:node-id` explains how to set it. Mirror folders
still sync.

**Validation:** an unknown mode, a bad name or a duplicate name across files fails the run (exit 2)
with the file and error on stderr, and nothing is touched. No config files at all (or only
`.sample` files) exits `10`, quietly.

## Script: `fleet-git-sync.sh`

Needs bash, git, jq and yq. Credentials come from the environment: when `GH_TOKEN` is set, it
configures a run-scoped credential helper for `github.com`, never written to `.git/config` or to
disk. Otherwise it uses whatever git/gh/SSH already provide. `GIT_SYNC_ROOT` (default `/shared`)
and `GIT_SYNC_CONF` (default `$GIT_SYNC_ROOT/.git-sync.d`) can be overridden for tests.

**One sync per root.** Several workspace containers on a desktop bind-mount the same `/shared`.
The script takes an exclusive `flock` on `<root>/.git-sync.lock` and exits `10` if it's already
held, so a second install of the automation (or an overlapping manual run) is a no-op instead of
a race on `.git/index.lock`.

For each folder, independently (one folder's failure never blocks another):

1. **Missing** → `git clone --branch <branch> <remote> <root>/<name>`, then set
   `core.autocrlf=false` and `core.fileMode=false` (Windows bind mounts), plus
   `core.untrackedCache=false` and `core.preloadIndex=true` (slow `lstat` on the Windows 9p mount).
   A non-empty, non-git directory at that path is an error for that folder (never clobbered).
2. **auto-sync** (requires `FLEET_NODE_ID`; called `<author>` below)
   - **Hold:** if `<name>/<author>/.sync-hold` exists, the whole folder is skipped this tick (no
     commit, pull or push). A long writer creates the hold when it starts and deletes it when its
     output is complete, so other nodes never read a half-written result. A hold older than 2 h is
     ignored and raises a todo keyed `git-sync:<name>:stale-hold`, so a crashed writer can't block
     sync forever. `.sync-hold` belongs in the repo's `.gitignore`.
   - **Only the node's own folder is committed:** `git add -A -- <author>/`, then commit with
     author/committer `<author> <<author>@fleet.invalid>` and the message `sync: <n> files from <author>`.
     Changes **outside** `<author>/` are never staged. They raise a todo keyed
     `git-sync:<name>:outside-edits` (listing the paths) and stay local, which enforces the
     single-writer convention. With `author_scoped: false` the whole tree is staged.
   - `git pull --rebase`. On a conflict: `git rebase --abort` (local commits kept), a todo keyed
     `git-sync:<name>:conflict`, then the next folder.
   - `git push`. On a non-fast-forward rejection, pull --rebase and push once more. A second
     failure counts as a failure for this folder.
3. **mirror**
   - Local edits (tracked changes or untracked files) are **not discarded**. They raise a todo keyed
     `git-sync:<name>:local-edits` ("local edits in mirror <name>: propose them upstream or
     discard them") and the pull is skipped.
   - Otherwise `git pull --ff-only`. Divergence (local commits) gets the same todo and a skip.

**Failures and outages.** Network and auth errors are counted per folder in the step's `state`
(`{"failures": {"<name>": n}}`). A success resets the counter. A `notify` (keyed
`git-sync:<name>:failing`) is emitted only at **3 consecutive failures**, so short outages stay
quiet. Todos deduplicate by key, so a persistent condition is one todo with a rising seen count.

**Exit codes** (the script-step protocol): `10` when every folder was current and nothing was
pushed; `0` when anything was cloned, pulled or pushed, or a per-folder problem was reported
through todo/notify/state; `2` for invalid config. Plain stdout lines summarise each folder
(`reviews: pushed 2 files, pulled 3 commits`).

## Automation

`automations/git-sync/automation.yaml` in the generic loadout:

```yaml
name: git-sync
description: Sync the git-backed folders configured in /shared/.git-sync.d
triggers:
  - schedule: { cron: "*/5 * * * *" }
  - manual: {}
concurrency: skip
steps:
  - id: sync
    script: { run: ./fleet-git-sync.sh, runIn: $self, timeout: 4m }
```

Every 5 minutes is the low-risk floor, so the schedule isn't approval-gated. `runIn: $self` binds to
the installing workspace, whose env and git auth provide credentials. **Install once per node**,
normally in the automations workspace. On a headless node, the runtime installs the same
loadouts and supplies `FLEET_NODE_ID` and a token as `GH_TOKEN`. Grant that token write access only
on repos the node auto-syncs and read access on mirrored ones.

## Conventions this enables

- **Work products** (e.g. reviews): **auto-sync** on every node, with each node writing only
  `<author>/…`. Single writer per folder, so a rebase only ever replays non-overlapping paths, and
  provenance is the path.
- **Curated knowledge:** **mirror** on nodes that aren't its maintainer. Maintainers auto-sync only
  if the remote allows their direct pushes; otherwise mirror plus PRs. The remote's branch
  protection decides; the script doesn't.
- **Moving existing folders** into a synced repo is a one-time cutover. The Windows 9p mount
  can't symlink old paths to new ones, so update every reader and writer together, and stop any
  writer that edits a folder that's about to become a mirror *first*. Otherwise its edits stall
  the mirror's pulls.

## Where the work lands

- **`claude-fleet-loadouts`:** `loadouts/git-sync/` (the loadout), plus
  `tests/git-sync/run.sh` (outside the loadout folder, so it isn't published), wired into the
  repo's CI and `make test`.
- **`claude-fleet`:** SPEC.md only (below). No app or image code.
- **Organisation config loadouts** live in each organisation's own loadout source.

## Testing

`tests/git-sync/run.sh` (bash; needs git, jq and yq) runs the real script against throwaway
bare repos in a temp dir, with `GIT_SYNC_ROOT` / `GIT_SYNC_CONF` pointing into it, and checks
stdout with the script-step protocol's line shapes:
- **Config:** several conf.d files merge; `.sample` is ignored; a duplicate name or bad mode exits 2
  untouched; no config exits 10.
- **Clone:** a missing folder is cloned; a non-git directory is refused.
- **auto-sync:** a commit carries `FLEET_NODE_ID` as author; a push race resolves with one retry; a
  rebase conflict keeps local commits and emits a conflict todo; no `FLEET_NODE_ID` skips the folder
  and emits the node-id todo.
- **Author scope:** edits outside `<author>/` are never pushed and emit an outside-edits todo;
  `author_scoped: false` stages everything.
- **Hold:** a held folder is untouched; a hold older than 2 h is ignored and emits a stale-hold todo.
- **mirror:** fast-forward; local edits are kept and emit a todo; divergence is skipped.
- **Failures:** an unreachable remote increments state, notifies on the 3rd consecutive failure,
  and a success resets the counter.
- **Lock:** a concurrent run exits 10 and touches nothing.
- **GH_TOKEN:** never appears in `.git/config` or anywhere under the root.
- **Exit codes:** 10 when current, 0 when changed, 2 on invalid config.

The loadout itself goes through `make dry-run` (frontmatter, and `automation.yaml` validity
through the inlined-script size limit). Host verification times a no-op tick on a repo of about
300 files on a Windows bind mount.

## SPEC.md changes (in claude-fleet, alongside the loadout release)

- §8 *Automations*: sharing folders between nodes is done with the `git-sync` loadout plus an
  organisation config loadout. The conf.d config, `FLEET_NODE_ID` as the commit author,
  `.sync-hold`, and the per-root lock.
- §9 *Security*: synced repos live under `/shared`, so the existing "no secrets in `/shared`" rule
  applies to them. Tokens never touch disk.
- §1/§3: rewrite "not a remote orchestrator / no remote daemons" to reflect the remote-node
  direction. The app still never drives remote Docker.
