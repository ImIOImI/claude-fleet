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
  install/write-example.sh    # writes /shared/.git-sync.d/example.json.sample
```

`loadout.md` frontmatter:
- `dependencies.tools`: `git`, `jq`, `flock`.
- `scripts` (run at install, inside the workspace):
  - **write the example:** create `/shared/.git-sync.d/` and write the example as
    `example.json.sample` (`unless:` it exists). The `.sample` suffix means it's never loaded.

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
    file: install/write-config.sh
```

```sh
# install/write-config.sh: rewrites the managed file on every install, so new versions apply.
set -e
mkdir -p /shared/.git-sync.d
cat >/shared/.git-sync.d/acme.json.tmp <<'EOF'
{ "folders": [ { "name": "reviews", "remote": "https://git.example.com/acme/reviews.git", "mode": "auto-sync" } ] }
EOF
mv /shared/.git-sync.d/acme.json.tmp /shared/.git-sync.d/acme.json
```

Install scripts run in the container with cwd `/workspace` and without the loadout's files, so
config content is embedded in the script. The script rewrites the managed file on every install,
so a new loadout version applies.

A new `remote` or `branch` for a folder that's already cloned isn't applied silently: the run
raises `git-sync:<name>:remote-changed` and skips the folder until someone moves it aside to
re-clone.

It carries **config only**. The script and automation come from `git-sync` through the
dependency, so there's no copy to drift. An organisation can ship several config loadouts (per team,
per project); each drops its own file into the conf.d directory.

## Config: `/shared/.git-sync.d/*.json`

The script loads every `*.json` in the directory (sorted). `*.sample` files are ignored. Plain
data, no secrets.

```json
{
  "folders": [
    { "name": "reviews", "remote": "https://git.example.com/acme/reviews.git",
      "branch": "main", "mode": "auto-sync", "author_scoped": true },
    { "name": "knowledge", "remote": "https://git.example.com/acme/knowledge.git", "mode": "mirror" }
  ]
}
```

**Author = the node id.** It's not in the config, because config files are shared across an
organisation. The script reads `FLEET_NODE_ID` (format `<name>@<team>` for people,
`agent-<name>@<team>` for agents). It must be **unique per node**: the same person on two
machines uses two ids (e.g. `troy-laptop@platform`), since each node is the single writer of its
own folder. A headless node's runtime sets it; on a desktop it's set
once as an env var on the workspace the loadout is installed into. Without it, **auto-sync
folders are skipped** and a todo keyed `git-sync:node-id` explains how to set it. Mirror folders
still sync.

**Validation:** an unknown mode, a bad name, a missing remote, an empty or non-string `branch`, a
non-boolean `author_scoped`, a non-object entry or a duplicate name across files fails the run
(exit 2) with the file, folder and error on stderr, and nothing is touched. A folder removed from
the config is no longer synced; its clone stays on disk. No config files at all (or only
`.sample` files) exits `10`, quietly.

## Script: `fleet-git-sync.sh`

Needs bash, git, jq and flock. Credentials come from the environment: when `GH_TOKEN` is set, it
configures a run-scoped credential helper for `github.com`, never written to `.git/config` or to
disk. Otherwise it uses whatever git/gh/SSH already provide. `GIT_SYNC_ROOT` (default `/shared`)
and `GIT_SYNC_CONF` (default `$GIT_SYNC_ROOT/.git-sync.d`) can be overridden for tests.

**One sync per root.** Several workspace containers on a desktop bind-mount the same `/shared`.
The script takes an exclusive `flock -n -E 75` on `<root>/.git-sync.lock` and exits `10` if it's
already held (any other lock error exits 1), so an overlapping run is a no-op instead of a race on
`.git/index.lock`. Holding that lock, it removes a `.git/index.lock` older than 10 minutes (left by
a killed git). A second install still runs with its own workspace's env, so a different
`FLEET_NODE_ID` or credentials there makes results flip between runs.

**Clones are untrusted.** Every workspace on the node can write `/shared`, so anyone could plant
a hook, `core.fsmonitor`, `include.path`, filter, `sshCommand` or `pushurl` in a clone and run code
in (or steal the token of) the syncing workspace. So:
- The script unsets `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`/
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` on entry, so no inherited env can redirect its own git calls.
- Every git call passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- Before touching an existing clone: a detached HEAD (no branch checked out) gets its own todo
  `git-sync:<name>:detached` ("check out `<branch>` to resume syncing") and is skipped — distinct
  from, and checked before, the remote/branch-mismatch check below, so it doesn't read as tampering.
- Otherwise its `remote.origin.url` and branch must match the config, else todo
  `git-sync:<name>:remote-changed` and skip.
- Its `git config --local --no-includes` keys must be on an allowlist: `core.{repositoryformatversion,
  filemode,bare,logallrefupdates,autocrlf,untrackedcache,preloadindex,ignorecase,symlinks,
  precomposeunicode}`, `user.{name,email}`, `remote.origin.{url,fetch}`, `branch.<branch>.{remote,merge}`.
  Anything else (including `include.*`/`includeIf.*`) gets todo `git-sync:<name>:unsafe-config`,
  listing key names but never values, and the folder is skipped.

None of the above counts as a failure.

**Scoped auto-sync never pushes someone else's commit.** `ahead=@{u}..HEAD` can include a commit
nobody here made — e.g. another workspace committing directly into the shared clone outside its
own `<author>/` folder. So, with `author_scoped:true`, before every push attempt (the initial one
and the race retry) the script checks `git diff --name-only @{u} HEAD -- . ":(exclude)<author>"`;
anything outside `<author>/` raises todo `git-sync:<name>:outside-commits` (the paths, and
`git reset --soft @{u}` as the way to drop them) and **holds the whole push**, not just the
offending commit. Not counted as a failure. `author_scoped:false` has no such guard — it pushes
any local commit by design, so it's only safe where every writer in the folder is trusted.

**Bounded runs.** The step timeout is 4 min, and a killed script saves no state. So:
- `fetch`/`pull`/`push` run under `timeout` (60 s at most, less near the deadline; exit 124 counts
  as a "timed out" failure), with `http.lowSpeedLimit=1000`/`lowSpeedTime=30`.
- A first **clone** isn't capped at 60 s: it gets the full remaining budget
  (`DEADLINE+30-SECONDS`), since it can't be chunked like a later fetch. It only starts with at
  least 90 s of that budget left; otherwise it's deferred to the next run exactly like a folder
  past the deadline (named in stdout, its state carried over).
- `GIT_SSH_COMMAND`, when unset, is the workspace's `core.sshCommand` (or `ssh`) plus
  `-o BatchMode=yes -o ConnectTimeout=20`.
- After 200 s no new folder starts; the deferred ones are named in stdout, and the state is
  always printed.
- The start folder rotates (`state.next`), so a slow folder can't starve the ones after it.

For each folder, independently (one folder's failure never blocks another):

1. **Missing** → `git clone --branch <branch> -- <remote> <root>/<name>`, then set
   `core.autocrlf=false` and `core.fileMode=false` (Windows bind mounts), plus
   `core.untrackedCache=false` and `core.preloadIndex=true` (slow `lstat` on the Windows 9p mount).
   A non-empty, non-git directory at that path is an error for that folder (never clobbered).
2. **auto-sync** (requires `FLEET_NODE_ID`; called `<author>` below)
   - **Hold:** if `<name>/<author>/.sync-hold` exists, the whole folder is skipped this tick (no
     commit, pull or push). A long writer creates the hold when it starts and deletes it when its
     output is complete, so other nodes never read a half-written result. A hold older than 2 h is
     ignored and raises a todo keyed `git-sync:<name>:stale-hold`, so a crashed writer can't block
     sync forever. `.sync-hold` belongs in the repo's `.gitignore`, and is never committed.
   - **Only the node's own folder is committed:** `git add -A -- <author>/` (also when the folder
     was deleted), then a path-limited `git commit -- <author>/` with author/committer
     `<author> <<author>@fleet.invalid>` and the message `sync: <n> files from <author>`.
     Changes **outside** `<author>/` are never committed, even if pre-staged. They raise a todo
     keyed `git-sync:<name>:outside-edits` (listing the paths) and stay local, which enforces the
     single-writer convention. With `author_scoped: false` the whole tree is staged.
   - **Large files:** a changed file over 50 MB stays local and unstaged, with a todo keyed
     `git-sync:<name>:large-file` listing it, so one oversized file can't wedge the folder on a
     rejected push.
   - `git pull --rebase --autostash` (the autostash carries uncommitted outside edits). On a rebase
     conflict: `git rebase --abort` (local commits kept, not pushed), a todo keyed
     `git-sync:<name>:conflict`, then the next folder. If reapplying the autostash conflicts, the
     edits stay in `git stash list` with the same todo, which explains how to recover them. A
     folder that already has unmerged paths when a run starts is skipped with that todo. A rebase
     stuck for any other reason is aborted and counted as a failure.
   - Before each push attempt (scoped folders only; see "Scoped auto-sync never pushes someone
     else's commit" above): if HEAD carries a commit outside `<author>/`, hold the push and todo
     `…:outside-commits` instead.
   - `git push`. On a rejection, pull --rebase and push once more (re-checking outside-commits
     first). A second failure counts as a failure for this folder.
3. **mirror**
   - Local edits (tracked changes or untracked files) are **not discarded**. They raise a todo keyed
     `git-sync:<name>:local-edits` ("local edits in mirror <name>: propose them upstream or
     discard them") and the pull is skipped.
   - Otherwise `git fetch`, then `git merge --ff-only @{u}`. Divergence (local commits) gets the
     same todo and a skip.

**Failures and outages.** Any failure (network, auth, timeout, no upstream, push rejected…) is
counted per folder in the step's `state` (`{"failures": {"<name>": n}}`), with the last
`fatal:`/`error:` line as the message. A success resets the counter. A `notify` (keyed
`git-sync:<name>:failing`) is emitted at **3 consecutive failures** and then every 288th (about
daily), so short outages stay quiet.

**Todos are emitted once.** The app reopens a closed todo whenever its key is posted again, so
the script keeps `state.seen` (`{"<todo key>": <body fingerprint>}`) and posts a todo only when
its key is new or its body changed. A key whose condition is gone is dropped, so a recurrence
posts again. Held and deferred folders keep their entries. `failures` and `seen` are pruned to
the configured folders.

**Exit codes** (the script-step protocol): `10` when nothing was cloned, pulled or pushed and
nothing new was reported; `0` when anything was cloned, pulled or pushed, or a todo, notify or
failure was emitted; `2` for invalid config; `1` for a lock error. State is saved on 0 and 10.
Plain stdout lines summarise each folder (`reviews: pushed 2 commit(s), pulled 3 commit(s)`).

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

`tests/git-sync/run.sh` (bash; needs git, jq and flock) runs the real script against throwaway
bare repos in a temp dir, with `GIT_SYNC_ROOT` / `GIT_SYNC_CONF` pointing into it. The script
itself always runs with an empty `GIT_CONFIG_GLOBAL` (no `user.name`/`user.email`), matching a
runner container with no global git identity, so the suite catches any `git commit` or `rebase`
that relies on one. It checks stdout with the script-step protocol's line shapes:
- **Config:** several conf.d files merge; `.sample` is ignored; a duplicate name, bad mode, empty
  branch or string `author_scoped` exits 2 untouched, naming the file; no config exits 10.
- **Clone:** a missing folder is cloned; a non-git directory is refused.
- **auto-sync:** a commit carries `FLEET_NODE_ID` as author; a push race (a PATH-shim `git` that
  lets another clone push first) resolves with one retry; a rebase conflict keeps local commits and
  an autostash conflict keeps the edits in the stash, both with a conflict todo; no
  `FLEET_NODE_ID` skips the folder and emits the node-id todo; deleting the node's folder is
  pushed; a file over the size limit stays local with a large-file todo.
- **Untrusted clones:** a planted `core.fsmonitor`, `include.path` or hooks never run; a changed
  origin URL, config remote or config branch raises remote-changed; a detached HEAD raises its own
  todo, not remote-changed; a locally-set `user.name`/`user.email` is allowed, not unsafe-config.
- **Runs:** a todo is posted once and again after its body changes or it recurs; state is pruned
  to configured folders; a tiny deadline defers and rotates folders; a small deadline also defers a
  folder that still needs its first clone, once less than 90 s of budget remains; a hung remote
  times out and the state is still printed; the failure message is the error line, not prose.
- **Author scope:** edits outside `<author>/` are never pushed and emit an outside-edits todo;
  a local commit someone else made outside `<author>/` holds the whole push and emits an
  outside-commits todo instead of being pushed; `author_scoped: false` stages everything.
- **Hold:** a held folder is untouched; a hold older than 2 h is ignored and emits a stale-hold todo.
- **mirror:** fast-forward; local edits are kept and emit a todo; divergence is skipped.
- **Failures:** an unreachable remote increments state, notifies on the 3rd consecutive failure
  and again on the 291st, and a success resets the counter.
- **Lock:** a concurrent run exits 10 and touches nothing; an unopenable lock exits 1; a stale
  `index.lock` is removed.
- **GH_TOKEN:** `git credential fill` returns it for `https://github.com` only; it never appears in
  `.git/config` or anywhere under the root.
- **Exit codes:** 10 when current, 0 when changed, 2 on invalid config.

The loadout itself goes through `make dry-run` (frontmatter, and `automation.yaml` validity
through the inlined-script size limit). Host verification times a no-op tick on a repo of about
300 files on a Windows bind mount.

## SPEC.md changes (in claude-fleet, alongside the loadout release)

- §8 *Automations*: sharing folders between nodes is done with the `git-sync` loadout plus an
  organisation config loadout. The conf.d config, `FLEET_NODE_ID` as the commit author,
  `.sync-hold`, and the per-root lock.
- §9 *Security*: synced repos live under `/shared`, so the existing "no secrets in `/shared`" rule
  applies to them. Tokens never touch disk. Clones are untrusted (allowlisted config, no hooks or
  fsmonitor).
- §1/§3: rewrite "not a remote orchestrator / no remote daemons" to reflect the remote-node
  direction. The app still never drives remote Docker.
