# Pinned loadouts in remote workspaces — design

Status: approved by the owner (Troy) 2026-11-20. Decisions D159–D168 are recorded in the plan (`docs/superpowers/plans/2026-11-20-remote-pinned-loadouts.md`) and summarised here.

## Goal

A remote workspace pod starts with the loadouts platform-ops pinned for it (for example `committee-pr-review`), installed into `/workspace` exactly as the desktop installs a loadout into a container workspace. The pins live in the deployment's values, the loadouts come from the private `SumerSports/claude-fleet-loadouts` git repo, and no new secret is needed.

## Scope

- **Workspace pod** (`fleet-host-entry workspace`): a new one-shot `fleet-host loadouts sync`, run as uid 1000 before `exec broker`.
- **fleet-host bundle**: the sync (pins, GitHub fetch, tar extraction, record file), reusing the desktop's `loadoutCore.ts` for apply, revert and scripts.
- **`SumerSports/claude-fleet-loadouts`**: its publish workflow tags each published loadout `<id>/v<version>`; existing versions are backfilled.
- Out of scope:
  - the desktop (its library, OCI sources and IPC are unchanged);
  - `single` mode (it runs the same entry, but nothing sets `FLEET_LOADOUTS` there);
  - resolving `dependencies.loadouts` (pins are explicit);
  - installing a loadout's `automations/` on the host (host automations are config-only, D125);
  - a kind cluster in CI.

## Today

- `docs/SPEC.md` §7 *Private sources (#444)* says there is no headless pin mechanism: `FLEET_LOADOUTS` isn't implemented.
- A remote workspace gets skills only from what a session writes into `/workspace` by hand.
- The workspace pod already has a GitHub App path: `fleet-host-cred` posts to the host pod's credential server (`FLEET_HOST_CRED_ADDR`, :8081), which mints installation tokens scoped to named repositories within `github.repositories` and the `github.permissions` ceiling.
- `src/host` already imports pure `src/main` modules (the `importGraph.test.ts` allowlist: `mcpCore.ts`, `broker.ts`, `automations/*`, …). `loadoutCore.ts` (fs + `yaml`) and `ociCore.ts` (`node:path`) are pure in the same sense.

## Source and auth (D159, D160)

- **Source:** the GitHub REST API on the git repo `FLEET_LOADOUTS_REPO` (default `SumerSports/claude-fleet-loadouts`; PRIVATE; default branch `main`; loadouts at `loadouts/<id>/`).
- **Why not GHCR:** GHCR accepts only classic PATs. App installation tokens get no `packages` scope within our ceiling, so GHCR would need a long-lived classic PAT. The git path needs no new secret.
- **Token:** one GitHub App installation token per sync, from the existing credential server, requested with
  `{ "owner": "<owner>", "repositories": ["<repo>"], "permissions": { "contents": "read" } }`.
  - The minter already refuses an owner other than the installation's account (403), a repository outside `github.repositories` (403) and permissions above `github.permissions` (403). `contents: read` is within `DEFAULT_PERMISSIONS`.
  - It is requested only when at least one pin must be fetched. A start where every pin is unchanged makes no token request and no GitHub call.
  - The token lives in the sync process's memory only. It is never logged, never written to disk, never put in an environment variable and never passed to loadout scripts. Errors name the stage, the host and an HTTP status, never a header.
- **API base:** `FLEET_LOADOUTS_API`, default `https://api.github.com`. It is an operator setting with the same trust as `FLEET_HOST_CRED_ADDR`: an absolute `http(s)` URL with no credentials, query or fragment. A non-default value is logged at `warn`. The image tests point it at a fake.

## Tags and provenance (D161)

- Each pin `id@version` resolves to the tag `<id>/v<version>`:
  1. `GET /repos/{owner}/{repo}` → `default_branch` (once per sync).
  2. `GET /repos/{owner}/{repo}/git/ref/tags/<id>/v<version>` → a commit, or an annotated tag dereferenced through `GET …/git/tags/{sha}`.
  3. `GET /repos/{owner}/{repo}/compare/{commit}...{default_branch}` must answer `status` `ahead` or `identical`: the tagged commit is on the default branch. A tag on an unmerged commit is refused (`resolve`).
  4. `GET /repos/{owner}/{repo}/tarball/{commit}` → a redirect to `codeload.github.com`, followed once without `Authorization`.
- After extraction, `loadout.md`'s frontmatter `version` must equal the pin exactly, or the install is refused (`verify`).
- The record stores the commit, so a rollback refetches exactly what was installed.
- **Publishing:** the loadouts repo's publish workflow runs `scripts/tag-loadouts.sh --check` before it publishes and `scripts/tag-loadouts.sh` after it:
  - It tags `HEAD` `<id>/v<version>` for every loadout whose tag doesn't exist yet.
  - An existing tag whose `loadouts/<id>` tree equals HEAD's is a no-op (idempotent).
  - An existing tag whose tree differs fails the workflow: the loadout changed without a version bump. Tags never move.
  - `--backfill` (a `workflow_dispatch` input, run once) tags every version in history at the newest commit that carried it.
  - Tags are lightweight and pushed with the workflow's `GITHUB_TOKEN` (`contents: write`).

## Pins (D162)

| Var (workspace pod) | Default | Meaning |
|---|---|---|
| `FLEET_LOADOUTS` | unset | `id@version` pins, separated by whitespace or commas; `id` is `^[a-z0-9][a-z0-9-]{0,62}$`, `version` is `MAJOR.MINOR.PATCH` with an optional `-prerelease` (no `+build`, no leading `v`); each id at most once |
| `FLEET_LOADOUTS_REPO` | `SumerSports/claude-fleet-loadouts` | `owner/repo` the pins come from |
| `FLEET_LOADOUTS_API` | `https://api.github.com` | GitHub REST API base |
| `FLEET_LOADOUTS_TIMEOUT_S` | `60` | the whole sync's cap, 1–600; an invalid value is logged and 60 is used |

- Platform-ops sets them in the workspace Deployment's values (Appendix A).
- **A malformed `FLEET_LOADOUTS`, `FLEET_LOADOUTS_REPO` or `FLEET_LOADOUTS_API` makes the whole sync a no-op:** nothing is installed or reverted, and `loadout sync failed` is logged with `stage: "config"`. A typo must not revert every installed loadout.
- **Empty or unset `FLEET_LOADOUTS` means nothing is pinned:** every loadout the record lists is reverted, because pins are authoritative.

## The sync (D163)

- `fleet-host loadouts sync` (a lazy `import()` in `cli.ts`, so the host's own start path is unchanged) runs `syncLoadouts`:
  1. Parse the pins and settings; read the record.
  2. Plan against the record:
     - a pin whose id is recorded with the same version and repo: **unchanged**, skipped;
     - a pin with no record, or a different version or repo: **install** (the recorded one is the "previous");
     - a recorded id not pinned: **revert**.
  3. Revert the unpinned ones, writing the record after each.
  4. If anything must be installed: request the token, read the default branch, then for each pin in order:
     - resolve, download and extract into a fresh staging directory under `os.tmpdir()`;
     - parse `loadout.md` and check the version;
     - revert the previous version (if any);
     - apply files, the `CLAUDE.md` block and the `settings.json`/`.mcp.json`/hooks merges with `loadoutCore`;
     - write the record;
     - run the loadout's `scripts:` (`loadoutCore.runLoadoutScripts`) with `sh -lc` in `/workspace`, as uid 1000, bounded by the remaining budget.
  5. Log `loadout sync done` with `installed`, `reverted`, `unchanged`, `failed` and `ms`. Exit 0.
- **Target:** `/workspace`, the EFS project root, where the desktop installs container loadouts (`fleetPrivateDir` → `/workspace`).
- **Record:** `/workspace/.claude/fleet-loadouts.json`, written atomically (temp file + rename, 0644):

  ```json
  { "version": 1, "loadouts": [
    { "id": "committee-pr-review", "version": "2.2.0", "repo": "SumerSports/claude-fleet-loadouts",
      "commit": "<40 hex>", "files": [".claude/skills/review-pr/SKILL.md"], "claudeMd": false,
      "settingsKeys": [], "mcpServers": [], "hooks": [], "installedAt": 1763600000000 } ] }
  ```

  The desktop never reads it. On read, every entry is validated: every `files` path must stay inside `/workspace` (`ociCore.safeLayerPath`), and ids must be unique.
- **`loadoutCore.ts` stays in `src/main`.** `src/host` already imports pure `src/main` modules; the sync adds `loadoutCore.ts` and `ociCore.ts` to the host import-graph allowlist, `.dockerignore` and the image workflows' path filters, which `importGraph.test.ts` enforces. Moving them would churn every desktop import for no gain.
- **Behaviour that matches the desktop:** files never clobber an existing file (skipped and logged); the `CLAUDE.md` block is replaced on reinstall; merges add only absent keys and servers; scripts aren't reverted.
- **Behaviour that differs:**
  - Scripts run when a version is applied, not on a start where the pin is unchanged. A script whose effect lives outside `/workspace` and isn't on a persistent volume isn't redone on a new pod (§11).
  - `dependencies.loadouts` aren't resolved: a dependency that isn't pinned logs `loadout dependency not pinned` (`warn`).
  - A loadout's `automations/` aren't installed: `loadout automations not installed` (`info`). Remote automations come from the host config (D125).
- **Concurrency:** the workspace Deployment is `strategy: Recreate` and the host pod mounts the EFS read-only, so only one sync runs against `/workspace` at a time, and it runs before any session exists.

## Entry script (D164)

- `run_workspace` calls `sync_loadouts` just before `exec "$broker_bin"`.
- It runs the sync only when `FLEET_LOADOUTS` is non-empty or the record exists (`FLEET_LOADOUTS_RECORD`, default `/workspace/.claude/fleet-loadouts.json`; only this check honours it, and only tests set it), so a workspace that has never pinned anything doesn't start Node.
- `timeout -k 5 <FLEET_LOADOUTS_TIMEOUT_S> node "$host_js" loadouts sync`. The sync's own budget is the cap minus 5 s (at least 1 s), so it normally logs and exits before `timeout` fires.
- Exit 124 or 137 (137 can also be an OOM kill) logs `loadout sync timed out or was killed; starting the broker`; any other non-zero status logs `loadout sync exited; starting the broker`. **The broker starts in every case.**
- The workspace pod still runs no long-lived fleet-host process: the sync has exited before the broker starts.

## Failure (D165)

- **Never block the pod.** The sync exits 0 except on a usage error (2), and the entry script starts the broker whatever happens.
- **Per loadout, keep the previous version:**
  - resolve, download, extract and verify happen in staging, before `/workspace` is touched, so a failure there leaves the previous version installed;
  - a failed revert of the previous version stops that pin (the previous version stays recorded);
  - a failed apply removes the new version's files that weren't there before (and its `CLAUDE.md` block), then **rolls back**: refetches the previous version by its recorded commit and re-applies it (`loadout rolled back`). If the rollback fails too, the entry is dropped from the record and `loadout rollback failed` is logged; the next start retries the pin.
- **Log shape:** `{"level":"error","msg":"loadout sync failed","stage":…,"id":…,"version":…,"error":…}`, with `stage` one of `config`, `record`, `token`, `resolve`, `download`, `extract`, `verify`, `revert`, `apply`, `timeout`. `id`/`version` are absent for `config`.
- **An unreadable or malformed record makes the sync a no-op** (`stage: "record"`): without it, nothing can be reverted exactly.
- **The 60 s cap:** one `AbortSignal` with the budget covers the token request, every GitHub call and every download. A pin not started when it fires logs `stage: "timeout"`. Scripts get the remaining budget and are killed (process group, SIGKILL) at the deadline.
- A failing script logs `loadout script failed` (`warn`, label, exit code, the last 500 characters of output, redacted by the logger) and the install stands, as on the desktop.

## Safety (D166)

- **Extraction** (`loadoutTar.ts`):
  - The tarball is a `git archive` (pax) gzip. Only entries under `<root>/loadouts/<id>/` are extracted; every entry must share one top-level directory, and pax global headers are skipped.
  - In scope, only regular files and directories are accepted. A symlink, hardlink or any other type fails the loadout (`extract`). Links elsewhere in the repo are ignored.
  - GNU long-name entries (`L`/`K`) and base-256 sizes are refused; header checksums are verified.
  - Every path goes through `ociCore.safeLayerPath` (no `..`, no absolute path, no escape). Duplicates are refused.
  - Caps: compressed tarball 25 MiB; decompressed archive 100 MiB (`gunzipSync` `maxOutputLength`); one file `MAX_BLOB_BYTES` (5 MiB, the desktop's per-layer cap, moved to `ociCore.ts` so both share it); the loadout 20 MiB in total and 1000 files.
  - The whole archive is checked before anything is written. Files are written `0644`, or `0755` if the header had any exec bit, with `wx` (never through an existing path).
- **Token:** `Authorization: Bearer` only on `api.github.com` (`FLEET_LOADOUTS_API`) requests. The tarball redirect is followed manually (`redirect: "manual"`), exactly once, with no `Authorization`, and only to an `https:` URL or the API's own origin. The redirect URL (which carries codeload's own short-lived token) is never logged. The token is shape-checked (`ociCore.isTokenShaped`) before use. Transport errors are rethrown as `<stage>: timed out|unreachable (<host>)`.
- **Scripts** run as uid 1000, the sessions' uid, so they can do nothing a session couldn't. Their environment is the entry script's: no GitHub token.
- **The record is session-writable** (same uid), so a session can make the next start delete files it could delete anyway. Record paths are still confined to `/workspace`.
- **Loadouts repo write access:** if the host config's `github.repositories` lists the loadouts repo and `github.permissions` includes `contents: write` (the default ceiling), any session can mint a write token for it. The design relies on:
  - the default-branch check (step 3): a tag on an unmerged commit is refused;
  - branch protection on `main` (PRs with review);
  - a tag ruleset on `*/v*` that only the publish workflow bypasses;
  - the publish workflow failing on an existing tag with a different tree.
  Appendix A lists these for platform-ops.
- **D168, per-repo read-only clamp:** the loadouts repo has no branch protection, so without the clamp any session could mint a write token and push a tampered loadout that the next pod start installs. Every token naming the loadouts repo is clamped to read (an explicit write is refused with 403). The host always adds `SumerSports/claude-fleet-loadouts` (`DEFAULT_LOADOUTS_REPO`) to `github.readOnlyRepositories`, whether or not the config lists it or `github.repositories` names it; there is no opt-out, so platform-ops needn't list it. A non-default `FLEET_LOADOUTS_REPO` must be listed explicitly. Adding a repository on reload doesn't revoke write tokens already minted; they stay valid for up to 1 h.

## Testing (D166)

- **Unit** (vitest, no network):
  - `loadoutPins.test.ts`: grammar, settings, plan;
  - `loadoutRecord.test.ts`: read, write, validation;
  - `loadoutTar.test.ts`: archives built by `testTar.ts` (symlink, hardlink, traversal, caps, pax long paths, checksum);
  - `loadoutFetch.test.ts`: against `testGithubRepo.ts`, a fake GitHub API (repository, refs, annotated tags, compare, tarball → codeload redirect that rejects `Authorization`);
  - `loadoutSync.test.ts`: install, unchanged, upgrade, revert, keep-previous on fetch failure, verify, rollback on apply failure, config and record no-ops, token failure, timeout, scripts, notices;
  - `loadoutsCli.test.ts`: the real credential client against a fake credential server (asserts the `contents: read` request), `runScript`, usage.
- **Entry** (`fleet-host-entry.test.sh`): the sync runs before the broker; is skipped with nothing pinned and no record; runs with no pins and a record; a hung sync is cut at the cap and the broker starts; a failing sync still starts the broker.
- **Images:**
  - `split.test.sh` adds `docker/host/testdata/fake-github.mjs`, a fake credential server plus GitHub API that serves `git archive` tarballs from a real git repo built at start. It checks that a pinned loadout lands before the broker listens, that a failed fetch keeps the previous version with the broker still serving, and that an empty pin list reverts it.
  - `smoke.test.sh` checks that `fleet-host loadouts sync` with nothing pinned exits 0 and that a bad subcommand exits 2.
- No kind cluster. The live check is Appendix B.

## Deployment answers (D167)

- **gh as the App:** the host images put the `gh` shim first on `PATH`, and it mints a repo-scoped token per invocation. It needs the real `gh` at `/usr/local/bin/gh`, which only the devops runner has. The workspace pod running review-pr must use **`runner-devops-host`**; on `runner-host` the shim exits 127 (`gh is not installed in this image`).
- **App permissions for review-pr:** Contents read (the loadouts repo and the reviewed repos), Pull requests write, Issues write, Checks read, Statuses read, Metadata read. No Packages.
- **Host config** (platform-ops):
  - `github.repositories`, when set, must list `claude-fleet-loadouts` (names, no owner) next to the reviewed repos; otherwise the sync's token request is 403 `not in github.repositories`.
  - `github.permissions`, when set, must include `contents` (`read` is enough for the sync and review-pr). `DEFAULT_PERMISSIONS` already does. Set it to the App's granted set, since a ceiling above what the App holds makes GitHub refuse every mint with 422: `{contents: read, pull_requests: write, issues: write, checks: read, statuses: read, metadata: read}` for a review-only host, plus `contents: write` only if sessions must push (git-sync to `fleet-reviews`).
  - The App installation must include `claude-fleet-loadouts`.
  - `FLEET_LOADOUTS_REPO`'s owner must be the installation's account (`SumerSports`).

## SPEC.md sections to update (in the implementation PR)

- §4 *Host images*: the `workspace` supervision bullet (the sync before `exec broker`, `timeout`, the skip rule); the `fleet-host` wrapper's subcommands (`loadouts sync`); the import-graph allowlist sentence (`loadoutCore.ts`, `ociCore.ts`).
- §7 *Loadout library v2 — Private sources (#444)*: replace "There is no headless pin mechanism yet (`FLEET_LOADOUTS` isn't implemented). The env steps are its hook." with a pointer to *Pinned loadouts*.
- §7 *Remote host*:
  - *Env contract*, workspace pod table: `FLEET_LOADOUTS`, `FLEET_LOADOUTS_REPO`, `FLEET_LOADOUTS_API`, `FLEET_LOADOUTS_TIMEOUT_S`, `FLEET_LOADOUTS_RECORD`;
  - *GitHub App credentials*: the sync is a client (`contents: read`, one repo);
  - a new *Pinned loadouts* subsection: source, tags, pins, reconcile, record, failure, logs.
- §9: the sync's token handling, extraction rules and the loadouts-repo write-access note.
- §10: `src/host/loadout{Pins,Record,Tar,Fetch,Sync,sCli}.ts`, `docker/host/testdata/fake-github.mjs`.
- §11 *Remote host: what remains*: the host checklist for pinned loadouts (Appendix B), unresolved dependencies, scripts only on apply, the per-repo permission ceiling.

---

## Appendix A: platform-ops values and host config

Workspace pod (Deployment `fleet-agent-workspace`) — env additions. Use the current versions; `committee-pr-review` is at 2.2.0 on `main` as of 2026-11-20.

```yaml
containers:
  - name: workspace
    image: <registry>/claude-fleet/runner-devops-host@<digest>   # real gh for the shim (D167)
    env:
      - { name: FLEET_LOADOUTS, value: "committee-pr-review@2.2.0" }
      - { name: FLEET_LOADOUTS_REPO, value: "SumerSports/claude-fleet-loadouts" }   # the default; explicit is clearer
      # FLEET_LOADOUTS_TIMEOUT_S defaults to 60
```

Host pod ConfigMap (`config.yaml`). The loadouts repo is read-only without any setting (D168); `repositories` and `permissions` only if they are already set:

```yaml
github:
  appId: "<id>"
  installationId: "<id>"
  keyFile: /var/run/secrets/github-app/key.pem
  repositories: [claude-fleet-loadouts, <reviewed repos…>]          # only if the allowlist is in use
  permissions: { contents: read, pull_requests: write, issues: write, checks: read, statuses: read, metadata: read }
```

`SumerSports/claude-fleet-loadouts` settings:
- the App installation includes the repo;
- branch protection on `main`: pull request with at least one approval, no force push;
- a tag ruleset targeting `*/v*`: restrict creations, updates and deletions; bypass list = repository admins and GitHub Actions (the publish workflow); the fleet GitHub App is **not** a bypass actor.

## Appendix B: live check on green (Troy's test agent and Work)

1. Run the loadouts repo's publish workflow once with `backfill: true`; `git ls-remote --tags origin '*/v*'` lists `committee-pr-review/v2.2.0` and `git-sync-sumer/v1.0.0`.
2. Roll the workspace pod with Appendix A's env.
   - `kubectl logs <workspace>` shows `loadout installed` `{"id":"committee-pr-review","version":"2.2.0",…}` and `loadout sync done` before the broker's `listening on`.
   - The host pod's log shows `app token issued` with `repositories: ["claude-fleet-loadouts"]`.
   - `kubectl exec <workspace> -- ls /workspace/.claude/skills/review-pr` lists `SKILL.md`; `/workspace/.claude/fleet-loadouts.json` records the commit.
   - In a remote tab, `/review-pr` is offered.
3. Restart the pod without changes: the log shows `unchanged`, and the host pod logs no new `app token issued` for the loadouts repo.
4. Pin a version that has no tag (`committee-pr-review@9.9.9`): `loadout sync failed` `stage: "resolve"`, `HTTP 404`; the pod turns Ready; 2.2.0 is still installed.
5. Unset `FLEET_LOADOUTS`: the next start logs `loadout reverted`, and `.claude/skills/review-pr` is gone.
6. In a session: `command -v gh` is `/usr/local/lib/fleet-host/bin/gh`; `gh pr view <n> -R SumerSports/<reviewed repo>` works with no `GH_TOKEN` set; `printenv GH_TOKEN` in the session is empty.
7. The write-access exposure (D166), from a session: `git clone https://github.com/SumerSports/claude-fleet-loadouts /tmp/l && cd /tmp/l && git tag x/v0.0.1 && git push origin x/v0.0.1` (the git credential helper supplies the App token). With `contents: write` in `github.permissions` the token is minted, and the push must be refused by the tag ruleset. With `contents: read` the push is refused by GitHub. Delete `/tmp/l` afterwards.
