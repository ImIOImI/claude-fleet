# Git-Synced Shared Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a generic `git-sync` loadout that keeps configured folders under `/shared` in
sync with git remotes on a 5-minute automation, plus the claude-fleet SPEC.md update.

**Architecture:** One bash script (`fleet-git-sync.sh`) does all git work and speaks the
automation script-step protocol (stdout JSON lines `{"todo"}`/`{"notify"}`/`{"state"}`; exit 10 =
nothing to do). It's inlined into a scheduled automation shipped by the `git-sync` loadout in
`claude-fleet-loadouts`. Per-node config is JSON files in `/shared/.git-sync.d/` dropped by
organisation config loadouts. The commit author is `FLEET_NODE_ID`. No claude-fleet app or image code.

**Tech Stack:** bash, git ≥ 2.32, jq ≥ 1.6, util-linux `flock` (all in the base runner image,
`node:22-bookworm-slim` + git/jq); claude-fleet loadouts (OCI via ORAS); GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-git-synced-folders-design.md` (claude-fleet, merged in #441).

## Global Constraints

- **Config is JSON, not YAML** (a correction to the spec, made in Task 4). It's `/shared/.git-sync.d/*.json`,
  loaded sorted; `*.sample` files are never loaded. Reason: the base runner image has `jq` but not `yq`,
  and anything installed under `~` is lost on workspace recreate.
- **Loadout install scripts embed their content.** They run as `sh -lc <command>` in the container
  with cwd `/workspace`, and the loadout's files are **not** present there. Use `file: <path>` (its
  content becomes the command) with heredocs; never `cp ./x` or `cmp ./x`.
- Automation script steps run via `bash -c` in the target workspace container and inherit its env
  (`GH_TOKEN`, `FLEET_NODE_ID`).
- An inlined script must be **< 20,000 characters** (`MAX_SCRIPT_CHARS` in claude-fleet `definition.ts`).
- Folder names: `^[a-z0-9][a-z0-9._-]*$`. Modes: `auto-sync` | `mirror` (default `mirror`). `branch` defaults to `main`. `author_scoped` defaults to `true`.
- Node id: `^[a-z0-9-]+@[a-z0-9-]+$` (people `<name>@<team>`, agents `agent-<name>@<team>`). Commit identity: `<id> <<id>@fleet.invalid>`.
- Todo keys: `git-sync:<name>:{not-a-repo,conflict,outside-edits,local-edits,stale-hold}` and `git-sync:node-id`. Notify key: `git-sync:<name>:failing`, emitted when a folder reaches exactly **3** consecutive failures.
- `.sync-hold` max age: 7200 s (env `GIT_SYNC_HOLD_MAX_AGE` overrides, for tests).
- Exit codes: `10` = nothing to do (also: lock held, no config); `0` = changed or a problem reported; `2` = invalid config.
- `GH_TOKEN` is passed to git only via `GIT_CONFIG_COUNT` env (run-scoped). Never written to disk.
- Repos: work in **worktrees**, never the shared checkouts. `/workspace/claude-fleet-loadouts` is on another branch.

---

### Task 1: Test suite for `fleet-git-sync.sh` (claude-fleet-loadouts)

**Files:**
- Create: `tests/git-sync/run.sh`

**Interfaces:**
- Consumes: nothing (the script doesn't exist yet; every test fails).
- Produces: `tests/git-sync/run.sh` runs the script at
  `loadouts/git-sync/automations/git-sync/fleet-git-sync.sh` with env `GIT_SYNC_ROOT`,
  `GIT_SYNC_CONF`, `FLEET_NODE_ID`, `FLEET_STATE`, `GH_TOKEN`, `GIT_SYNC_HOLD_MAX_AGE`. It exits 0
  only if every test passes. Task 3's `make test` calls it.

- [ ] **Step 1: Create a worktree for the loadouts repo**

```bash
git -C /workspace/claude-fleet-loadouts fetch -q origin
git -C /workspace/claude-fleet-loadouts worktree add -b feat/git-sync-loadout /workspace/claude-fleet-loadouts-git-sync origin/main
cd /workspace/claude-fleet-loadouts-git-sync
```

- [ ] **Step 2: Write the test suite**

Create `tests/git-sync/run.sh`:

```bash
#!/usr/bin/env bash
# Tests for loadouts/git-sync/automations/git-sync/fleet-git-sync.sh, run against
# throwaway bare repos. Needs bash, git (>= 2.32), jq, flock.
# Usage: tests/git-sync/run.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../../loadouts/git-sync/automations/git-sync/fleet-git-sync.sh"
T=""; OUT=""; RC=0

setup() {
  T=$(mktemp -d)
  export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
  git config --global init.defaultBranch main
  git config --global user.name seed
  git config --global user.email seed@example.invalid
  export GIT_SYNC_ROOT="$T/shared" GIT_SYNC_CONF="$T/shared/.git-sync.d"
  mkdir -p "$GIT_SYNC_CONF"
  export FLEET_NODE_ID=alice@team FLEET_STATE='{}'
  unset GH_TOKEN GIT_SYNC_HOLD_MAX_AGE
}

# A bare repo seeded with README and bob@team/r.md; prints its path.
remote() {
  local bare="$T/remotes/$1.git" work="$T/seed/$1"
  mkdir -p "$T/remotes" "$T/seed"
  git init -q --bare "$bare"
  git clone -q "$bare" "$work" 2>/dev/null
  mkdir -p "$work/bob@team"
  echo seed >"$work/README"
  echo review >"$work/bob@team/r.md"
  git -C "$work" add -A
  git -C "$work" commit -qm seed
  git -C "$work" push -q origin main
  echo "$bare"
}

# Commit <path>=<content> to <bare> from another clone.
push_from_other() {
  local w; w=$(mktemp -d "$T/other.XXXX")
  git clone -q "$1" "$w"
  mkdir -p "$w/$(dirname "$2")"
  echo "$3" >"$w/$2"
  git -C "$w" add -A
  git -C "$w" commit -qm "other: $2"
  git -C "$w" push -q origin main
}

# conf <file> <name> <remote> <mode> [extra-json-merged-into-the-folder]
conf() {
  local extra=${5:-}; [ -n "$extra" ] || extra='{}'
  jq -n --arg n "$2" --arg r "$3" --arg m "$4" --argjson x "$extra" \
    '{folders: [{name: $n, remote: $r, mode: $m} + $x]}' >"$GIT_SYNC_CONF/$1"
}

sync() { OUT=$(bash "$SCRIPT" 2>"$T/stderr") && RC=0 || RC=$?; }
json_lines() { grep '^{' <<<"$OUT" || true; }
next_state() {
  FLEET_STATE=$(json_lines | jq -c 'select(has("state")) | .state' | tail -n 1)
  [ -n "$FLEET_STATE" ] || FLEET_STATE='{}'
  export FLEET_STATE
}
fail() { echo "    $*"; return 1; }
expect_rc() { [ "$RC" = "$1" ] || fail "exit $RC, want $1; stdout: $OUT; stderr: $(cat "$T/stderr")"; }
expect_out() { grep -qF -- "$1" <<<"$OUT" || fail "stdout lacks '$1': $OUT"; }
expect_todo() { json_lines | jq -r 'select(has("todo")) | .todo.key' | grep -qx -- "$1" || fail "no todo $1 in: $OUT"; }
notify_keys() { json_lines | jq -r 'select(has("notify")) | .notify.key'; }
remote_file() { git --git-dir="$1" show "main:$2" 2>/dev/null || true; }
local_dir() { echo "$GIT_SYNC_ROOT/$1"; }

# ── config ────────────────────────────────────────────────────────────────
test_no_config_exits_10() {
  sync; expect_rc 10
}
test_sample_files_are_ignored() {
  echo '{"folders":[{"name":"x","remote":"/nope"}]}' >"$GIT_SYNC_CONF/example.json.sample"
  sync; expect_rc 10
  [ ! -e "$(local_dir x)" ]
}
test_bad_mode_exits_2_and_touches_nothing() {
  local r; r=$(remote a)
  conf a.json a "$r" sideways
  sync; expect_rc 2
  grep -q "mode must be auto-sync or mirror" "$T/stderr"
  [ ! -e "$(local_dir a)" ]
}
test_duplicate_name_across_files_exits_2() {
  local r; r=$(remote a)
  conf 1.json dup "$r" mirror
  conf 2.json dup "$r" mirror
  sync; expect_rc 2
  grep -q "duplicate folder name: dup" "$T/stderr"
}
test_invalid_json_exits_2() {
  echo '{' >"$GIT_SYNC_CONF/bad.json"
  sync; expect_rc 2
  grep -q "bad.json" "$T/stderr"
}
test_bad_folder_name_exits_2() {
  local r; r=$(remote a)
  conf a.json ../escape "$r" mirror
  sync; expect_rc 2
  grep -q "bad folder name" "$T/stderr"
}

# ── clone ─────────────────────────────────────────────────────────────────
test_clones_missing_folder() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync; expect_rc 0
  [ -f "$(local_dir a)/README" ]
  [ "$(git -C "$(local_dir a)" config core.autocrlf)" = false ]
  [ "$(git -C "$(local_dir a)" config core.fileMode)" = false ]
  expect_out "a: cloned"
}
test_refuses_non_git_directory() {
  local r; r=$(remote a)
  mkdir -p "$(local_dir a)"; echo keep >"$(local_dir a)/notes"
  conf a.json a "$r" mirror
  sync; expect_rc 0
  expect_todo git-sync:a:not-a-repo
  grep -qx keep "$(local_dir a)/notes"
  [ ! -d "$(local_dir a)/.git" ]
}

# ── mirror ────────────────────────────────────────────────────────────────
test_mirror_fast_forwards() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync
  push_from_other "$r" new.md fresh
  sync; expect_rc 0
  grep -qx fresh "$(local_dir a)/new.md"
  expect_out "a: pulled 1 commit(s)"
}
test_mirror_up_to_date_exits_10() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync
  sync; expect_rc 10
  expect_out "a: up to date"
}
test_mirror_keeps_local_edits() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync
  echo mine >"$(local_dir a)/README"
  push_from_other "$r" new.md fresh
  sync; expect_rc 0
  expect_todo git-sync:a:local-edits
  grep -qx mine "$(local_dir a)/README"
  [ ! -e "$(local_dir a)/new.md" ]
}
test_mirror_skips_divergence() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync
  echo local >"$(local_dir a)/local.md"
  git -C "$(local_dir a)" add -A
  git -C "$(local_dir a)" commit -qm local
  sync; expect_rc 0
  expect_todo git-sync:a:local-edits
}

# ── auto-sync ─────────────────────────────────────────────────────────────
test_autosync_pushes_own_folder_as_author() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  mkdir -p "$(local_dir a)/alice@team"; echo mine >"$(local_dir a)/alice@team/x.md"
  sync; expect_rc 0
  [ "$(remote_file "$r" alice@team/x.md)" = mine ]
  [ "$(git --git-dir="$r" log -1 --format='%an <%ae>' main)" = "alice@team <alice@team@fleet.invalid>" ]
  expect_out "a: pushed 1 commit(s)"
}
test_autosync_up_to_date_exits_10() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  sync; expect_rc 10
  expect_out "a: up to date"
}
test_autosync_pulls_others_work() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  push_from_other "$r" bob@team/new.md fresh
  sync; expect_rc 0
  grep -qx fresh "$(local_dir a)/bob@team/new.md"
}
test_autosync_keeps_outside_edits_local() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  echo changed >"$(local_dir a)/bob@team/r.md"
  sync; expect_rc 0
  expect_todo git-sync:a:outside-edits
  [ "$(remote_file "$r" bob@team/r.md)" = review ]
  grep -qx changed "$(local_dir a)/bob@team/r.md"
}
test_autosync_unscoped_stages_everything() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync '{"author_scoped": false}'
  sync
  echo changed >"$(local_dir a)/README"
  sync; expect_rc 0
  [ "$(remote_file "$r" README)" = changed ]
}
test_autosync_without_node_id_skips_and_asks() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  mkdir -p "$(local_dir a)/alice@team"; echo mine >"$(local_dir a)/alice@team/x.md"
  unset FLEET_NODE_ID
  sync; expect_rc 0
  expect_todo git-sync:node-id
  [ -z "$(remote_file "$r" alice@team/x.md)" ]
}
test_invalid_node_id_counts_as_missing() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  export FLEET_NODE_ID="Alice Smith"
  sync; expect_rc 0
  expect_todo git-sync:node-id
}
test_push_race_is_retried_once() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  cat >"$(local_dir a)/.git/hooks/pre-push" <<EOF
#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
[ -e "$T/raced" ] && exit 0
touch "$T/raced"
git clone -q "$r" "$T/race" && cd "$T/race" && echo racer >racer.md && git add -A && git commit -qm race && git push -q origin main
EOF
  chmod +x "$(local_dir a)/.git/hooks/pre-push"
  mkdir -p "$(local_dir a)/alice@team"; echo mine >"$(local_dir a)/alice@team/x.md"
  sync; expect_rc 0
  [ "$(remote_file "$r" alice@team/x.md)" = mine ]
  [ "$(remote_file "$r" racer.md)" = racer ]
}
test_rebase_conflict_keeps_local_commit() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync '{"author_scoped": false}'
  sync
  push_from_other "$r" README theirs
  echo ours >"$(local_dir a)/README"
  sync; expect_rc 0
  expect_todo git-sync:a:conflict
  [ "$(git -C "$(local_dir a)" log -1 --format=%an)" = alice@team ]
  [ "$(remote_file "$r" README)" = theirs ]
  [ ! -d "$(local_dir a)/.git/rebase-merge" ]
  [ ! -d "$(local_dir a)/.git/rebase-apply" ]
}
test_hold_skips_folder() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  mkdir -p "$(local_dir a)/alice@team"
  touch "$(local_dir a)/alice@team/.sync-hold"
  echo wip >"$(local_dir a)/alice@team/x.md"
  sync; expect_rc 10
  expect_out "held"
  [ -z "$(remote_file "$r" alice@team/x.md)" ]
}
test_stale_hold_is_ignored_and_never_pushed() {
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  mkdir -p "$(local_dir a)/alice@team"
  touch -d '3 hours ago' "$(local_dir a)/alice@team/.sync-hold"
  echo done >"$(local_dir a)/alice@team/x.md"
  sync; expect_rc 0
  expect_todo git-sync:a:stale-hold
  [ "$(remote_file "$r" alice@team/x.md)" = done ]
  [ -z "$(git --git-dir="$r" ls-tree -r --name-only main | grep sync-hold || true)" ]
}

# ── failures, lock, secrets, size ─────────────────────────────────────────
test_failures_notify_on_third_and_reset() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  sync
  mv "$r" "$r.away"
  sync; next_state; [ -z "$(notify_keys)" ]
  sync; next_state; [ -z "$(notify_keys)" ]
  sync; next_state; [ "$(notify_keys)" = git-sync:a:failing ]
  sync; next_state; [ -z "$(notify_keys)" ]
  mv "$r.away" "$r"
  sync; next_state
  [ "$(jq -c '.failures' <<<"$FLEET_STATE")" = '{}' ]
}
test_concurrent_run_exits_10() {
  local r; r=$(remote a)
  conf a.json a "$r" mirror
  flock "$GIT_SYNC_ROOT/.git-sync.lock" sleep 3 &
  sleep 0.5
  sync; expect_rc 10
  [ ! -e "$(local_dir a)" ]
  wait
}
test_gh_token_never_written_to_disk() {
  export GH_TOKEN=tok-must-not-hit-disk
  local r; r=$(remote a)
  conf a.json a "$r" auto-sync
  sync
  mkdir -p "$(local_dir a)/alice@team"; echo mine >"$(local_dir a)/alice@team/x.md"
  sync
  [ -z "$(grep -rl tok-must-not-hit-disk "$GIT_SYNC_ROOT" "$r" || true)" ]
}
test_script_fits_inline_limit() {
  [ "$(wc -c <"$SCRIPT")" -lt 20000 ]
}

# ── runner ────────────────────────────────────────────────────────────────
pass=0; failed=()
for t in $(declare -F | awk '$3 ~ /^test_/ {print $3}'); do
  ( set -e; setup; trap 'rm -rf "$T"' EXIT; "$t" )
  if [ $? -eq 0 ]; then pass=$((pass + 1)); echo "ok   $t"; else failed+=("$t"); echo "FAIL $t"; fi
done
echo "$pass passed, ${#failed[@]} failed"
[ ${#failed[@]} -eq 0 ]
```

- [ ] **Step 3: Run it and confirm every test fails**

```bash
chmod +x tests/git-sync/run.sh
tests/git-sync/run.sh; echo "exit=$?"
```
Expected: every `test_*` prints `FAIL` (the script doesn't exist: `bash: …fleet-git-sync.sh: No such file or directory`), the last line is `0 passed, 27 failed`, and `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add tests/git-sync/run.sh
git commit -m "test(git-sync): failing suite for fleet-git-sync.sh"
```

---

### Task 2: `fleet-git-sync.sh` (claude-fleet-loadouts)

**Files:**
- Create: `loadouts/git-sync/automations/git-sync/fleet-git-sync.sh`

**Interfaces:**
- Consumes: env `GIT_SYNC_ROOT` (default `/shared`), `GIT_SYNC_CONF` (default
  `$GIT_SYNC_ROOT/.git-sync.d`), `FLEET_NODE_ID`, `FLEET_STATE` (JSON from the last run),
  `GH_TOKEN`, `GIT_SYNC_HOLD_MAX_AGE` (default 7200).
- Produces: stdout lines `{"todo":{key,title,body,tags:["git-sync"]}}`,
  `{"notify":{key,title,body}}`, `{"state":{"failures":{"<name>":n}}}`, plus plain
  `<name>: …` summary lines (`cloned …`, `pulled N commit(s)`, `pushed N commit(s)`, `up to date`, `held …`). Exit 10/0/2 as in Global Constraints.

- [ ] **Step 1: Write the script**

Create `loadouts/git-sync/automations/git-sync/fleet-git-sync.sh`:

```bash
#!/usr/bin/env bash
# fleet-git-sync: keep the git-backed folders configured in $GIT_SYNC_CONF/*.json
# in sync under $GIT_SYNC_ROOT. Runs as a claude-fleet automation script step:
# stdout JSON lines {"todo":…} {"notify":…} {"state":…}; exit 10 = nothing to do,
# 0 = something changed or a problem was reported, 2 = invalid config.
set -uo pipefail

ROOT="${GIT_SYNC_ROOT:-/shared}"
CONF="${GIT_SYNC_CONF:-$ROOT/.git-sync.d}"
AUTHOR="${FLEET_NODE_ID:-}"
HOLD_MAX_AGE="${GIT_SYNC_HOLD_MAX_AGE:-7200}"
NOTIFY_AFTER=3
export GIT_TERMINAL_PROMPT=0

changed=0       # something was cloned, pulled or pushed
reported=0      # a todo, notify or failure was recorded
need_node_id=0  # an auto-sync folder was skipped for want of FLEET_NODE_ID
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

say() { printf '%s\n' "$*"; }
config_error() { printf 'git-sync: %s\n' "$*" >&2; exit 2; }
last_err() { tail -n 1 "$ERR" | cut -c1-300; }
todo() { # key title body
  reported=1
  jq -cn --arg key "$1" --arg title "$2" --arg body "$3" \
    '{todo: {key: $key, title: $title, body: $body, tags: ["git-sync"]}}'
}
notify() { # key title body
  reported=1
  jq -cn --arg key "$1" --arg title "$2" --arg body "$3" '{notify: {key: $key, title: $title, body: $body}}'
}
upstream() { git -C "$1" rev-parse -q --verify '@{u}' 2>/dev/null || true; }
count() { git -C "$1" rev-list --count "$2" 2>/dev/null || echo 0; }
rebase_in_progress() { [ -d "$1/.git/rebase-merge" ] || [ -d "$1/.git/rebase-apply" ]; }

# GH_TOKEN reaches git through run-scoped env config only; nothing is written to disk.
if [ -n "${GH_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0='credential.https://github.com.helper' GIT_CONFIG_VALUE_0='' \
    GIT_CONFIG_KEY_1='credential.https://github.com.helper' \
    GIT_CONFIG_VALUE_1='!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'
fi

# One sync per root: several containers may mount the same /shared.
mkdir -p "$ROOT" || config_error "cannot create $ROOT"
exec 9>"$ROOT/.git-sync.lock" || config_error "cannot open $ROOT/.git-sync.lock"
if ! flock -n 9; then say "another git-sync run holds $ROOT/.git-sync.lock; skipping"; exit 10; fi

# ── config ──
shopt -s nullglob
files=("$CONF"/*.json)
if [ ${#files[@]} -eq 0 ]; then say "no git-sync config in $CONF"; exit 10; fi
for f in "${files[@]}"; do
  jq -e 'type == "object" and ((.folders // []) | type == "array")' "$f" >/dev/null 2>&1 \
    || config_error "$f: expected a JSON object with a \"folders\" array"
done
folders=$(jq -cs '[.[] | (.folders // [])[]]' "${files[@]}")
errors=$(jq -r '
  (.[] | select((.name | type) != "string" or (.name | test("^[a-z0-9][a-z0-9._-]*$") | not))
       | "bad folder name: \(.name | tostring)"),
  (.[] | select((.remote | type) != "string" or .remote == "") | "folder \(.name): missing remote"),
  (.[] | select((.mode // "mirror") | IN("auto-sync", "mirror") | not)
       | "folder \(.name): mode must be auto-sync or mirror, got \(.mode | tostring)"),
  (group_by(.name | tostring)[] | select(length > 1) | "duplicate folder name: \(.[0].name)")
' <<<"$folders")
[ -z "$errors" ] || config_error "$errors"

if [ -n "$AUTHOR" ] && ! [[ "$AUTHOR" =~ ^[a-z0-9-]+@[a-z0-9-]+$ ]]; then
  say "FLEET_NODE_ID '$AUTHOR' is not <name>@<team>; auto-sync folders skipped"
  AUTHOR=""
fi

# ── failure counters (state carried between runs) ──
state_in=${FLEET_STATE:-}
[ -n "$state_in" ] || state_in='{}'
failures=$(jq -c 'if type == "object" and (.failures | type) == "object" then .failures else {} end' <<<"$state_in" 2>/dev/null)
[ -n "$failures" ] || failures='{}'

record_failure() { # name message
  local n
  reported=1
  n=$(jq -r --arg k "$1" '(.[$k] // 0) + 1' <<<"$failures")
  failures=$(jq -c --arg k "$1" --argjson n "$n" '.[$k] = $n' <<<"$failures")
  say "$1: failed ($n in a row): $2"
  if [ "$n" -eq "$NOTIFY_AFTER" ]; then
    notify "git-sync:$1:failing" "git-sync can't sync $ROOT/$1" \
      "$NOTIFY_AFTER runs in a row failed. Last error: $2"
  fi
}
record_ok() { failures=$(jq -c --arg k "$1" 'del(.[$k])' <<<"$failures"); }

# ── per-folder operations ──
clone_folder() { # name remote branch
  local name=$1 remote=$2 branch=$3 dir="$ROOT/$1"
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    todo "git-sync:$name:not-a-repo" "git-sync: $dir isn't a git clone" \
      "git-sync won't overwrite it. Move it aside so $remote can be cloned there."
    say "$name: $dir exists and is not a git clone; skipped"
    return
  fi
  if git clone -q --branch "$branch" "$remote" "$dir" 2>"$ERR"; then
    git -C "$dir" config core.autocrlf false
    git -C "$dir" config core.fileMode false
    git -C "$dir" config core.untrackedCache false
    git -C "$dir" config core.preloadIndex true
    record_ok "$name"; changed=1
    say "$name: cloned $remote"
  else
    record_failure "$name" "clone: $(last_err)"
  fi
}

pull_rebase() { # name dir → 0 ok; 1 conflict or failure (already reported)
  if git -C "$2" pull -q --rebase --autostash 2>"$ERR"; then return 0; fi
  if rebase_in_progress "$2"; then
    git -C "$2" rebase --abort 2>/dev/null
    todo "git-sync:$1:conflict" "git-sync: rebase conflict in $1" \
      "Local commits are kept and not pushed. Resolve with: cd $2 && git pull --rebase"
    say "$1: rebase conflict; local commits kept"
    return 1
  fi
  record_failure "$1" "pull: $(last_err)"
  return 1
}

sync_auto() { # name scoped
  local name=$1 scoped=$2 dir="$ROOT/$1" scope hold n up_before up_mid pulled ahead outside
  if [ -z "$AUTHOR" ]; then need_node_id=1; say "$name: skipped (FLEET_NODE_ID is not set)"; return; fi
  if [ "$scoped" = true ]; then scope="$AUTHOR"; hold="$dir/$AUTHOR/.sync-hold"; else scope="."; hold="$dir/.sync-hold"; fi
  if [ -e "$hold" ]; then
    if [ $(( $(date +%s) - $(stat -c %Y "$hold") )) -lt "$HOLD_MAX_AGE" ]; then
      say "$name: held by ${hold#"$ROOT"/}; skipped"
      return
    fi
    todo "git-sync:$name:stale-hold" "git-sync: stale hold in $name" \
      "$hold is older than $((HOLD_MAX_AGE / 3600))h, so git-sync ignored it. Delete it if no writer is running."
  fi
  if [ "$scoped" = true ]; then
    outside=$(git -C "$dir" status --porcelain -- . ":(exclude)$AUTHOR" ':(exclude,glob)**/.sync-hold' | head -n 20)
    if [ -n "$outside" ]; then
      todo "git-sync:$name:outside-edits" "git-sync: edits outside $AUTHOR/ in $name" \
        "These stay local and are never pushed by this node:"$'\n'"$outside"
    fi
  fi
  if [ "$scope" = . ] || [ -e "$dir/$scope" ]; then
    git -C "$dir" add -A -- "$scope" ':(exclude,glob)**/.sync-hold'
  fi
  n=$(git -C "$dir" diff --cached --name-only | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    git -C "$dir" -c user.name="$AUTHOR" -c user.email="$AUTHOR@fleet.invalid" \
      commit -q -m "sync: $n files from $AUTHOR"
  fi
  up_before=$(upstream "$dir")
  pull_rebase "$name" "$dir" || return
  up_mid=$(upstream "$dir")
  pulled=0
  if [ -n "$up_before" ] && [ "$up_before" != "$up_mid" ]; then pulled=$(count "$dir" "$up_before..$up_mid"); fi
  ahead=$(count "$dir" '@{u}..HEAD')
  if [ "$ahead" -gt 0 ]; then
    if ! git -C "$dir" push -q 2>"$ERR"; then
      pull_rebase "$name" "$dir" || return
      ahead=$(count "$dir" '@{u}..HEAD')
      if ! git -C "$dir" push -q 2>"$ERR"; then record_failure "$name" "push: $(last_err)"; return; fi
    fi
    changed=1
  fi
  [ "$pulled" -gt 0 ] && changed=1
  record_ok "$name"
  if [ "$ahead" -gt 0 ] || [ "$pulled" -gt 0 ]; then
    say "$name: pushed $ahead commit(s), pulled $pulled commit(s)"
  else
    say "$name: up to date"
  fi
}

sync_mirror() { # name
  local name=$1 dir="$ROOT/$1" dirty ahead behind
  dirty=$(git -C "$dir" status --porcelain | head -n 20)
  if [ -n "$dirty" ]; then
    todo "git-sync:$name:local-edits" "git-sync: local edits in mirror $name" \
      "Pulls into $dir are paused until these are proposed upstream or discarded:"$'\n'"$dirty"
    say "$name: local edits in a mirror; skipped"
    return
  fi
  if ! git -C "$dir" fetch -q 2>"$ERR"; then record_failure "$name" "fetch: $(last_err)"; return; fi
  ahead=$(count "$dir" '@{u}..HEAD')
  if [ "$ahead" -gt 0 ]; then
    todo "git-sync:$name:local-edits" "git-sync: local commits in mirror $name" \
      "$dir has $ahead local commit(s) that aren't on the remote. Pulls are paused until they're proposed upstream or dropped."
    say "$name: local commits in a mirror; skipped"
    return
  fi
  behind=$(count "$dir" 'HEAD..@{u}')
  if [ "$behind" -gt 0 ]; then
    if ! git -C "$dir" merge -q --ff-only '@{u}' 2>"$ERR"; then record_failure "$name" "merge: $(last_err)"; return; fi
    changed=1
    say "$name: pulled $behind commit(s)"
  else
    say "$name: up to date"
  fi
  record_ok "$name"
}

# ── main ──
while IFS=$'\t' read -r -u 3 name remote branch mode scoped; do
  if [ ! -d "$ROOT/$name/.git" ]; then clone_folder "$name" "$remote" "$branch"; continue; fi
  if [ "$mode" = auto-sync ]; then sync_auto "$name" "$scoped"; else sync_mirror "$name"; fi
done 3< <(jq -r '.[] | [.name, .remote, (.branch // "main"), (.mode // "mirror"),
                        ((.author_scoped // true) | tostring)] | @tsv' <<<"$folders")

if [ "$need_node_id" = 1 ]; then
  todo "git-sync:node-id" "git-sync: set FLEET_NODE_ID to sync auto-sync folders" \
    "Auto-sync folders commit as the node id (<name>@<team>, or agent-<name>@<team> for agents). Set FLEET_NODE_ID as an env var on the workspace that runs the git-sync automation. Mirror folders still sync."
fi
jq -cn --argjson f "$failures" '{state: {failures: $f}}'
if [ "$changed" = 1 ] || [ "$reported" = 1 ]; then exit 0; fi
exit 10
```

- [ ] **Step 2: Run the suite**

```bash
chmod +x loadouts/git-sync/automations/git-sync/fleet-git-sync.sh
tests/git-sync/run.sh; echo "exit=$?"
```
Expected: every line `ok   test_…`, then `27 passed, 0 failed`, `exit=0`.
If a test fails, read its `stdout:`/`stderr:` detail line, fix the **script** (not the test) unless
the test contradicts the Global Constraints, and re-run. Lint with `shellcheck -S warning` on
both files if available; fix any warnings.

- [ ] **Step 3: Commit**

```bash
git add loadouts/git-sync/automations/git-sync/fleet-git-sync.sh
git commit -m "feat(git-sync): fleet-git-sync.sh sync script"
```

---

### Task 3: Loadout packaging + CI (claude-fleet-loadouts)

**Files:**
- Create: `loadouts/git-sync/loadout.md`
- Create: `loadouts/git-sync/automations/git-sync/automation.yaml`
- Create: `loadouts/git-sync/install/write-example.sh`
- Modify: `Makefile` (add `test` target)
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `fleet-git-sync.sh` (Task 2), `tests/git-sync/run.sh` (Task 1).
- Produces: a loadout with id `git-sync` and version `1.0.0`. Its automation is named `git-sync`, and the example lands at
  `/shared/.git-sync.d/example.json.sample`. Organisation config loadouts depend on `{id: git-sync, version: "^1.0.0"}`.

- [ ] **Step 1: Write the automation**

Create `loadouts/git-sync/automations/git-sync/automation.yaml`:

```yaml
name: git-sync
description: Sync the git-backed folders configured in /shared/.git-sync.d
tags: [git-sync]
triggers:
  - schedule: { cron: "*/5 * * * *" }
  - manual: {}
concurrency: skip
steps:
  - id: sync
    script: { run: ./fleet-git-sync.sh, runIn: $self, timeout: 4m }
```

- [ ] **Step 2: Write the example-config install script**

Create `loadouts/git-sync/install/write-example.sh` (its *content* is run with `sh -lc` in
the container at install, so it must be self-contained):

```sh
# git-sync loadout install step: write an example config. *.sample is never loaded.
set -e
mkdir -p /shared/.git-sync.d
cat >/shared/.git-sync.d/example.json.sample <<'EOF'
{
  "folders": [
    { "name": "reviews", "remote": "https://git.example.com/acme/reviews.git",
      "branch": "main", "mode": "auto-sync", "author_scoped": true },
    { "name": "knowledge", "remote": "https://git.example.com/acme/knowledge.git",
      "mode": "mirror" }
  ]
}
EOF
```

- [ ] **Step 3: Write `loadout.md`**

Create `loadouts/git-sync/loadout.md`:

````markdown
---
title: Git Sync
version: 1.0.0
description: >-
  Keeps folders under /shared in sync with git remotes on a 5-minute automation, so several
  claude-fleet nodes share files and keep working offline. Install once per node (normally in
  the automations workspace), then add folders with an organisation config loadout or a JSON
  file in /shared/.git-sync.d/. Auto-sync folders need FLEET_NODE_ID set on that workspace.
tags: [automation, git, sync, shared]
dependencies:
  tools:
    - { cmd: git }
    - { cmd: jq }
scripts:
  - label: write the example config
    file: install/write-example.sh
    unless: test -f /shared/.git-sync.d/example.json.sample
---

# Git Sync

Adds a **`git-sync` automation** (every 5 minutes, plus Run now) that clones and syncs the
folders listed in `/shared/.git-sync.d/*.json`, using the git credentials of the workspace it's
installed in (`GH_TOKEN`, `gh auth`, or SSH). **Install it once per node.** A second install is
harmless (a lock makes it a no-op) but pointless.

## Config

Every `*.json` file in `/shared/.git-sync.d/` is loaded. `*.sample` files are ignored (the install
drops `example.json.sample`). No secrets here.

```json
{
  "folders": [
    { "name": "reviews", "remote": "https://git.example.com/acme/reviews.git",
      "branch": "main", "mode": "auto-sync", "author_scoped": true },
    { "name": "knowledge", "remote": "https://git.example.com/acme/knowledge.git", "mode": "mirror" }
  ]
}
```

- `name`: the folder under `/shared` (`[a-z0-9][a-z0-9._-]*`).
- `mode`:
  - `mirror` (the default) pulls fast-forward only and never discards local edits.
  - `auto-sync` commits, rebases and pushes.
- `author_scoped` (auto-sync, default `true`): commit only `<node id>/…`. Edits elsewhere raise
  a todo and stay local.

## Node id

Auto-sync commits as **`FLEET_NODE_ID`**: `<name>@<team>` for people, `agent-<name>@<team>` for
agents. Set it as an env var on the workspace that runs the automation. Without it, auto-sync
folders are skipped with a todo; mirrors still sync.

## Long writers: `.sync-hold`

A tool that writes for minutes creates `<folder>/<node id>/.sync-hold` (or `<folder>/.sync-hold`
when unscoped) and deletes it when done. git-sync skips that folder meanwhile, so nobody sees a
half-written result. Holds older than 2 h are ignored, with a todo. Add `.sync-hold` to the
repo's `.gitignore`.

## What you'll see

| Situation | Result |
|---|---|
| Rebase conflict | todo `git-sync:<name>:conflict`; local commits kept |
| Edits in a mirror, or outside your folder | todo `…:local-edits` / `…:outside-edits` |
| Non-git directory in the way | todo `…:not-a-repo`; never overwritten |
| Network or auth failure | quiet; notify `…:failing` on the 3rd in a row |
| Stale hold | todo `…:stale-hold` |

## Organisation config loadouts

Ship your folder list as a separate loadout that depends on this one. Install scripts run in
the container **without** the loadout's files, so embed the config in the script:

```yaml
# loadout.md frontmatter
title: Git Sync (Acme)
version: 1.0.0
description: Acme's shared repos for git-sync. Install once per node.
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
````

- [ ] **Step 4: Add `make test` and a PR workflow**

In `Makefile`, change the `.PHONY` line and append a target:

```make
.PHONY: dry-run publish publish-one test

# Run every repo test (no registry access needed).
test:
	./scripts/build-index.test.sh
	./tests/git-sync/run.sh
```

Create `.github/workflows/test.yml`:

```yaml
name: Test

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ubuntu-latest ships git, jq, flock and mikefarah yq (build-index.test.sh needs yq).
      - name: Run tests
        run: make test
```

- [ ] **Step 5: Verify locally**

```bash
make test; echo "exit=$?"
./scripts/publish-loadout.sh loadouts/git-sync --dry-run
```
Expected: `build-index.test.sh` passes (it counts loadout folders, and `git-sync` is now one of them), `27 passed, 0 failed`,
`exit=0`. The dry-run prints `title: Git Sync`, version `1.0.0`, and lists four files: `loadout.md`,
`install/write-example.sh`, `automations/git-sync/automation.yaml` and `automations/git-sync/fleet-git-sync.sh`.
If `build-index.test.sh` needs `yq` locally and it's missing, install it (`docker/scripts/yq.sh` in claude-fleet) or run only `./tests/git-sync/run.sh`, and note that in the PR.

- [ ] **Step 6: Validate the automation against claude-fleet's parser**

From a claude-fleet worktree that has `node_modules` (see memory "Run unit tests env"), add a
temporary test file inside the tree (vitest only collects files under the project), run it, then delete it:

```bash
cat >src/main/automations/gitsyncLoadout.tmp.test.ts <<'EOF'
import { it, expect } from 'vitest';
import { readLoadoutAutomations } from './loadoutAutomations.js';
it('git-sync automation is found with its script beside it', async () => {
  const [a] = await readLoadoutAutomations('/workspace/claude-fleet-loadouts-git-sync/loadouts/git-sync');
  expect(a.folder).toBe('git-sync');
  expect(a.text).toContain('run: ./fleet-git-sync.sh');
  expect(Object.keys(a.files)).toContain('fleet-git-sync.sh');
});
EOF
npx vitest run src/main/automations/gitsyncLoadout.tmp.test.ts
rm src/main/automations/gitsyncLoadout.tmp.test.ts
```
Expected: 1 passed. This is a one-off check; never commit the file. If the vitest env is broken, say
so in the PR and rely on the install check in Task 5.

- [ ] **Step 7: Commit, push and open the PR**

```bash
git add loadouts/git-sync Makefile .github/workflows/test.yml
git commit -m "feat(git-sync): git-sync loadout 1.0.0 + make test + PR test workflow"
git push -u origin feat/git-sync-loadout
gh pr create --repo ImIOImI/claude-fleet-loadouts --title "feat: git-sync loadout (1.0.0)" --body "Generic git-sync loadout: a 5-minute automation that syncs /shared folders listed in /shared/.git-sync.d/*.json. Spec: ImIOImI/claude-fleet docs/superpowers/specs/2026-10-30-git-synced-folders-design.md (#441). Adds \`make test\` and a PR test workflow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: the PR URL is printed, and the `Test` workflow goes green.

---

### Task 4: claude-fleet SPEC.md + spec corrections

**Files:**
- Modify: `docs/SPEC.md` (§1 line 13, §3 line 34, §8 *Automations* after the `**UI:**` bullet, §9 after line 1124)
- Modify: `docs/superpowers/specs/2026-10-30-git-synced-folders-design.md`

**Interfaces:**
- Consumes: the facts shipped in Tasks 2–3 (JSON config, install-script embedding).
- Produces: documentation only.

- [ ] **Step 1: Create a worktree from origin/main**

```bash
git -C /workspace/claude-fleet fetch -q origin
git -C /workspace/claude-fleet worktree add -b docs/spec-shared-folder-sync /workspace/claude-fleet/.claude/worktrees/spec-shared-folder-sync origin/main
cd /workspace/claude-fleet/.claude/worktrees/spec-shared-folder-sync
```

- [ ] **Step 2: Update §1 and §3**

In `docs/SPEC.md`, replace the §1 sentence
`It is a local-only operator console — not a remote orchestrator, not a multi-user service, not a cloud product. Everything runs on the user's machine, against the user's local Docker daemon.`
with:
`It is an operator console that runs on the user's machine against the user's local Docker daemon. It is not a multi-user service or a cloud product. Several nodes (desktops, and headless nodes) can share files through git-synced folders (§8 *Sharing folders between nodes*); the app never drives a remote Docker daemon.`

Replace the §3 bullet
`- **Not a remote orchestrator.** No SSH, no Kubernetes, no remote daemons. Local Docker only.`
with:
`- **Not a remote orchestrator.** The app never drives remote Docker, SSH or Kubernetes. Cross-node sharing is limited to git-synced folders, run as an ordinary automation.`

- [ ] **Step 3: Add the §8 subsection**

In `docs/SPEC.md`, directly after the `### Automations` section's `- **UI:** …` bullet (before
`### Proposals`), insert:

```markdown
### Sharing folders between nodes (git-sync loadout)
- **What:** folders under `/shared/<name>` mirrored to git remotes so several nodes share files and keep working offline. It's not an app feature. It's the generic **`git-sync` loadout** (claude-fleet-loadouts): a 5-minute `git-sync` automation (`concurrency: skip`, `runIn: $self`) whose script step is `fleet-git-sync.sh`, inlined at install. Install it **once per node**, normally in the automations workspace. Credentials are that workspace's own (`GH_TOKEN` env, `gh auth`, SSH); `GH_TOKEN` is passed to git through run-scoped `GIT_CONFIG_*` env and never written to disk.
- **Config:** every `/shared/.git-sync.d/*.json` (`{"folders":[{name, remote, branch?="main", mode?="mirror", author_scoped?=true}]}`), loaded sorted; `*.sample` is ignored. Organisation **config loadouts** depend on `git-sync` and write their own file from an install script. Install scripts run in the container with cwd `/workspace` and **without** the loadout's files, so the content is embedded (`file:` script + heredoc). Invalid config → exit 2, nothing touched.
- **Modes:**
  - **mirror:** fetch + fast-forward only. Local edits or local commits are kept and raise todo `git-sync:<name>:local-edits`, and pulls pause.
  - **auto-sync:** commits as `FLEET_NODE_ID` (`<name>@<team>` / `agent-<name>@<team>`; email `<id>@fleet.invalid`), only under `<id>/` unless `author_scoped:false`. Edits elsewhere → todo `…:outside-edits`, never pushed. Then `pull --rebase --autostash` and push, retried once after a race. A conflict aborts the rebase, keeps the local commits and raises todo `…:conflict`. No/invalid `FLEET_NODE_ID` skips auto-sync folders with todo `git-sync:node-id`.
- **Hold:** `<name>/<id>/.sync-hold` (or `<name>/.sync-hold` unscoped) skips the folder while a long writer works. Older than 2 h → ignored + todo `…:stale-hold`. Never committed.
- **Safety:**
  - One run per root (`flock` on `/shared/.git-sync.lock`; a held lock → exit 10).
  - An existing non-git directory is never overwritten (todo `…:not-a-repo`).
  - Network/auth failures are counted per folder in step `state` (`{"failures":{name:n}}`), with a notify `…:failing` only at the 3rd in a row.
  - Exit 10 = nothing to do, 0 = changed or reported.
```

- [ ] **Step 4: Add the §9 note**

In `docs/SPEC.md`, directly after the bullet starting `- **The one deliberate cross-container surface is`, insert:

```markdown
- **Git-synced folders live under `/shared`**, so the no-secrets rule applies to their repos too. A synced repo is readable by every workspace on the node and by everyone with access to the remote. Sync credentials stay in the syncing workspace's env and are never written into `/shared`.
```

- [ ] **Step 5: Correct the design spec**

In `docs/superpowers/specs/2026-10-30-git-synced-folders-design.md`:
- Replace every `*.yaml` config reference (`/shared/.git-sync.d/*.yaml`, `example.yaml.sample`, `acme.yaml`) with `*.json` / `example.json.sample` / `acme.json`. Convert the YAML config example to the JSON example from Task 3 Step 3.
- Remove the `ensure yq` install step and the `yq` mentions (the script needs only bash, git, jq and flock).
- Replace the config-loadout `scripts:` example (`cp ./acme.yaml … unless: test -f …`) with the `file: install/write-config.sh` example from Task 3 Step 3, and add one sentence: "Install scripts run in the container with cwd `/workspace` and without the loadout's files, so config content is embedded in the script. The script rewrites the managed file on every install, so a new loadout version applies."

- [ ] **Step 6: Verify and commit**

```bash
grep -n "git-sync" docs/SPEC.md | head
grep -n "yaml\|yq" docs/superpowers/specs/2026-10-30-git-synced-folders-design.md
```
Expected: the first shows the new §8 subsection and the §1/§9 lines. The second lists only the
`automation.yaml` filename (no config YAML, no yq).

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-10-30-git-synced-folders-design.md
git commit -m "docs(spec): git-sync loadout for sharing folders between nodes"
git push -u origin docs/spec-shared-folder-sync
gh pr create --repo ImIOImI/claude-fleet --title "docs(spec): git-sync loadout for sharing folders between nodes" --body "SPEC.md for the git-sync loadout (claude-fleet-loadouts PR), plus corrections to the #441 design spec: JSON config (no yq in the base image) and self-contained install scripts (they run without the loadout's files).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 5: Release and hand-off

**Files:** none (release + coordination).

- [ ] **Step 1: Merge the two PRs once green and approved by Troy.** Merging the loadouts PR runs
  `publish-loadouts.yml`, which publishes `git-sync:1.0.0` to `ghcr.io/imioimi/claude-fleet-loadouts`.
  Confirm: `oras manifest fetch ghcr.io/imioimi/claude-fleet-loadouts/git-sync:1.0.0 >/dev/null && echo published`.

- [ ] **Step 2: Tell the work workspace.** Append to `/shared/remote-agent-design/threads/001-kickoff.md`
  (through the `append_entry.py` helper, `### <UTC> — claude-fleet dev workspace` header) that
  `git-sync` 1.0.0 is published, and that `git-sync-sumer` (SumerSports/claude-fleet-loadouts#2) must change before undrafting:
  - (a) config is `sumer.json`, not YAML;
  - (b) the install step must be a `file: install/write-config.sh` heredoc with an atomic `mv` and **no `unless`**, because `./sumer.yaml` doesn't exist in the container, so both `cp ./…` and `cmp -s ./…` fail.

- [ ] **Step 3: Host verification (Troy, on the desktop).**
  - Install `git-sync-sumer` into the automations workspace and set `FLEET_NODE_ID=troy@platform` on it.
  - Click **Run now** on `git-sync`. Confirm `/shared/fleet-reviews` and `/shared/fleet-expertise` are cloned.
  - Time a second (no-op) run from the run detail. It should be a few seconds on the Windows mount.
  - Record the time in the loadouts PR.
