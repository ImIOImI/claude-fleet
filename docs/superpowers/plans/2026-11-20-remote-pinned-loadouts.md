# Pinned loadouts in remote workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote workspace pod installs the loadouts pinned in `FLEET_LOADOUTS` from the private `SumerSports/claude-fleet-loadouts` git repo into `/workspace` before its broker starts, with the desktop's apply/revert/scripts semantics, a GitHub App token from the existing credential server, and no new secret.

**Architecture:**
- **fleet-host bundle.** A one-shot `fleet-host loadouts sync` (`loadoutsCli.ts` → `loadoutSync.ts`):
  - parses the pins (`loadoutPins.ts`) and the record file (`loadoutRecord.ts`);
  - plans unchanged / install / revert;
  - for each install, gets one `contents: read` token from the credential server, resolves `<id>/v<version>` to a commit on the default branch, downloads the tarball (`loadoutFetch.ts`) and extracts one loadout safely (`loadoutTar.ts`) into staging;
  - then reverts the previous version and applies the new one with the desktop's `src/main/loadoutCore.ts`, writes the record, and runs the loadout's scripts.
- **Entry script.** `fleet-host-entry workspace` runs the sync under `timeout -k 5 60` before `exec broker`, and starts the broker whatever happens.
- **Loadouts repo.** The publish workflow tags each published loadout `<id>/v<version>` (idempotent; fails on an unbumped change); `--backfill` tags history.

**Tech Stack:** TypeScript on plain Node 22 (the fleet-host Vite bundle), `node:zlib` + a small ustar/pax reader (no new dependency), `fetch` (undici), vitest, Bash (entry script, image tests, tag script), Docker (CI image tests), GitHub Actions (`yq`, `git`).

**Spec:** `docs/superpowers/specs/2026-11-20-remote-pinned-loadouts-design.md` (approved by the owner 2026-11-20).

## Global Constraints

Every task's requirements include this section.

**Binding design (owner-approved)**
- Source: the git repo `FLEET_LOADOUTS_REPO` (default `SumerSports/claude-fleet-loadouts`, default branch `main`, loadouts at `loadouts/<id>/`) through the GitHub REST API. Never GHCR.
- Token: a GitHub App installation token from the existing credential server (`FLEET_HOST_CRED_ADDR`), scoped to that one repo with `permissions: { contents: "read" }`.
- Pins: `FLEET_LOADOUTS="committee-pr-review@2.2.0 git-sync-sumer@1.0.0"`: whitespace- or comma-separated `id@version`, strict id and semver. Each resolves to the tag `<id>/v<version>`. Refuse the install if `loadout.md`'s `version` differs from the pin.
- Install: `fleet-host loadouts sync`, run by `fleet-host-entry workspace` as uid 1000 before `exec broker`; reuses `loadoutCore` apply/revert/scripts; target `/workspace`; record `/workspace/.claude/fleet-loadouts.json`; unchanged pin skipped, changed version reverted then applied, unpinned loadout reverted.
- Failure: never block the pod. Per loadout keep the previous version and log `loadout sync failed` (structured). The whole step is capped at 60 s, after which the broker starts anyway. Empty or unset `FLEET_LOADOUTS` reverts everything recorded.
- Safety: traversal-safe paths (`ociCore.safeLayerPath`), no symlinks or hardlinks, the desktop's per-file cap (`MAX_BLOB_BYTES`, 5 MiB) plus total caps. The token is never logged and never written to disk. Scripts run as uid 1000.
- Tests: unit tests against a fake GitHub API; `split.test.sh`/`smoke.test.sh` gain a fake GitHub endpoint; no kind cluster.

**Security**
- The token exists only in the sync process's memory: never in a log line, an error message, a file, an environment variable or a script's environment.
- `Authorization` goes only to `FLEET_LOADOUTS_API`. The tarball redirect is followed manually, once, without it, and only to `https:` or the API's own origin.
- Extraction checks the whole archive before writing a byte.

**Process**
- **SPEC.md is updated in the implementation PR (Task 9)** (`.claude/rules/spec-maintenance.md`).
- **Comments are terse and necessary** (`.claude/rules/review-conventions.md`).
- **The environment has no Docker, no Kubernetes and no display.**
  - TS: `npx vitest run <file>`.
  - Shell: `bash docker/host/fleet-host-entry.test.sh` runs locally; `split.test.sh` and `smoke.test.sh` run in CI (`test-runner-images.yml`); check them locally with `bash -n`.
  - Cluster behaviour is checked by Work and Troy's test agent (spec Appendix B).
- **Run all three typecheck configs separately:** `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npx tsc -p tsconfig.host.json`.
- Work in a git worktree; never `cd` into the shared `/workspace/claude-fleet` checkout. Task 10 works in a clone of `SumerSports/claude-fleet-loadouts`.

---

## Decisions (continuing from D158)

**D159. The source is the git repo through the GitHub REST API, not GHCR.**
- GHCR accepts only classic PATs, and App installation tokens get no `packages` scope within our ceiling. GHCR would need a long-lived classic PAT; git needs no new secret.
- `FLEET_LOADOUTS_REPO` (default `SumerSports/claude-fleet-loadouts`) and `FLEET_LOADOUTS_API` (default `https://api.github.com`; an operator setting like `FLEET_HOST_CRED_ADDR`; a non-default value logs `warn`).

**D160. One `contents: read` installation token per sync, from the credential server.**
- Body `{ owner, repositories: [repo], permissions: { contents: "read" } }`, posted with `credCli.requestToken` to `FLEET_HOST_CRED_ADDR` (else `FLEET_HOST_CRED_SOCKET`, else the default socket).
- Requested only when at least one pin must be fetched. Kept in memory only.

**D161. Tags, provenance and the default-branch check.**
- Pin `id@version` → tag `<id>/v<version>` → `git/ref/tags/…` (an annotated tag is dereferenced through `git/tags/{sha}`) → `compare/{commit}...{default_branch}` must be `ahead` or `identical` → `tarball/{commit}`.
- `loadout.md`'s `version` must equal the pin. The record stores the commit.
- The loadouts repo's publish workflow tags `HEAD` per loadout after publishing (`scripts/tag-loadouts.sh`). An existing tag with the same `loadouts/<id>` tree is a no-op; with a different tree the workflow fails. `--check` runs before publishing; `--backfill` tags history once. Tags never move.

**D162. Pin grammar and settings; a bad setting is a no-op.**
- `id` `^[a-z0-9][a-z0-9-]{0,62}$`; `version` `MAJOR.MINOR.PATCH[-prerelease]`; separators whitespace or commas; an id at most once.
- A malformed `FLEET_LOADOUTS`, `FLEET_LOADOUTS_REPO` or `FLEET_LOADOUTS_API` changes nothing (`stage: "config"`), so a typo can't revert every loadout.
- `FLEET_LOADOUTS_TIMEOUT_S` 1–600, default 60; an invalid value is logged and 60 is used.

**D163. The sync engine.**
- `fleet-host loadouts sync` lives in the fleet-host bundle (a lazy `import()` in `cli.ts`).
- `loadoutCore.ts` and `ociCore.ts` stay in `src/main`. `src/host` already imports pure `src/main` modules; they join the import-graph allowlist, `.dockerignore` and the image workflows' path filters.
- Target `/workspace`; record `/workspace/.claude/fleet-loadouts.json` (version 1; per entry `id`, `version`, `repo`, `commit`, `files`, `claudeMd`, `settingsKeys`, `mcpServers`, `hooks`, `installedAt`), written atomically.
- Plan: same id + version + repo (case-insensitive) → unchanged; otherwise install with the recorded entry as previous; recorded but unpinned → revert. Reverts run first, then installs in pin order.
- Scripts run `sh -lc` in `/workspace` with the remaining budget, only when a version is applied.
- `dependencies.loadouts` aren't resolved (`loadout dependency not pinned`, `warn`). `automations/` aren't installed (`loadout automations not installed`, `info`; D125).

**D164. The entry script runs the sync before the broker and never waits past the cap.**
- `sync_loadouts` runs only when `FLEET_LOADOUTS` is non-empty or the record (`FLEET_LOADOUTS_RECORD`, default `/workspace/.claude/fleet-loadouts.json`) exists.
- `timeout -k 5 <FLEET_LOADOUTS_TIMEOUT_S> node "$host_js" loadouts sync`. The sync's own budget is the cap minus 5 s, at least 1 s. 124/137 logs `loadout sync timed out; starting the broker`; another non-zero status logs `loadout sync exited; starting the broker`. Then `exec broker`.

**D165. Failure model.**
- Resolve, download, extract and verify run in staging before `/workspace` is touched. A failed revert of the previous version stops that pin.
- A failed apply removes what it added, then rolls back by refetching the previous version's recorded commit (`loadout rolled back`). If that fails too, the entry is dropped (`loadout rollback failed`).
- `loadout sync failed` carries `stage` (`config`, `record`, `token`, `resolve`, `download`, `extract`, `verify`, `revert`, `apply`, `timeout`), `id`, `version` and `error`.
- An unreadable record is a no-op. The sync exits 0 except on a usage error (2).

**D166. Extraction and transport safety.**
- Only `<root>/loadouts/<id>/` entries; one top-level directory; pax `g` skipped, pax `x` paths honoured; GNU `L`/`K` and base-256 refused; checksums verified.
- In scope: regular files and directories only (symlink, hardlink, anything else refused). `safeLayerPath` on every path; duplicates refused.
- Caps (`TAR_LIMITS`): tarball 25 MiB, archive 100 MiB, file `MAX_BLOB_BYTES` (moved to `ociCore.ts`), loadout 20 MiB and 1000 files.
- Modes 0644, or 0755 when any exec bit is set; written with `wx` only after the whole archive passed.
- Record paths are re-validated with `safeLayerPath`.
- If `github.repositories` lists the loadouts repo and the ceiling includes `contents: write`, any session can mint a write token for it. Mitigations: the default-branch check, branch protection on `main`, a `*/v*` tag ruleset, and the publish workflow's moved-tree failure.

**D167. Deployment answers (recorded, no code).**
- The workspace pod that runs review-pr uses `runner-devops-host`: the `gh` shim needs the real `gh`.
- App permissions for review-pr: Contents read (the loadouts repo and the reviewed repos), Pull requests write, Issues write, Checks read, Statuses read, Metadata read. No Packages.
- Host config: `github.repositories` (when set) lists `claude-fleet-loadouts`; `github.permissions` (when set) includes `contents` and matches what the App holds; the installation includes the repo; the pin repo's owner is the installation's account.

**D168. Per-repo read-only clamp (controller, 2026-11-21).**
- The loadouts repo has no branch protection, so without the clamp any session could mint a write token and push a tampered loadout that the next pod start installs.
- Host config `github.readOnlyRepositories` (`owner/repo`, each in `github.repositories` when that is set). A token request naming one of them is clamped to read as a whole: explicit `permissions` must all be `read` (else 403 before GitHub); omitted `permissions` become the ceiling's keys at `read` (write-only `workflows` dropped). Platform-ops lists `SumerSports/claude-fleet-loadouts`.

## File structure

| File | Responsibility |
|---|---|
| `src/host/loadoutPins.ts` (new) | Pin grammar, `FLEET_LOADOUTS_REPO`/`_API`/`_TIMEOUT_S` parsing, `pinTag`, `planSync` (pure) |
| `src/host/loadoutRecord.ts` (new) | `/workspace/.claude/fleet-loadouts.json` read (validated) and atomic write |
| `src/host/loadoutTar.ts` (new) | gzip + ustar/pax reader; extract one loadout with the safety rules and caps |
| `src/host/loadoutFetch.ts` (new) | GitHub API: default branch, tag → commit on the branch, tarball through the redirect |
| `src/host/loadoutSync.ts` (new) | The reconcile loop: revert, fetch, verify, apply, rollback, record, scripts, logs |
| `src/host/loadoutsCli.ts` (new) | `fleet-host loadouts sync`: env, credential client, `runScript` |
| `src/host/testTar.ts` (new, test only) | Builds `git archive`-shaped tar.gz buffers |
| `src/host/testGithubRepo.ts` (new, test only) | Fake GitHub REST API (refs, annotated tags, compare, tarball → codeload) |
| `src/host/cli.ts` | `loadouts` subcommand |
| `src/main/ociCore.ts`, `src/main/ociClient.ts` | `MAX_BLOB_BYTES` moves to `ociCore.ts`; `ociClient.ts` re-exports it |
| `src/host/importGraph.test.ts`, `.dockerignore`, `.github/workflows/publish-runner.yml`, `.github/workflows/test-runner-images.yml` | Admit `loadoutCore.ts` and `ociCore.ts` to the host bundle; exclude the two test helpers |
| `docker/host/fleet-host-entry`, `docker/host/fleet-host-entry.test.sh` | `sync_loadouts` before `exec broker` |
| `docker/host/testdata/fake-github.mjs` (new), `docker/host/split.test.sh`, `docker/host/smoke.test.sh` | Image tests |
| `docs/SPEC.md` | §4, §7, §9, §10, §11 |
| `SumerSports/claude-fleet-loadouts`: `scripts/tag-loadouts.sh`, `scripts/tag-loadouts.test.sh`, `.github/workflows/publish-loadouts.yml`, `README.md`, `Makefile` | Version tags |

---

### Task 1: Pins, settings and the sync plan

**Files:**
- Create: `src/host/loadoutPins.ts`
- Create: `src/host/loadoutRecord.ts` (types only in this task; Task 2 adds the functions)
- Test: `src/host/loadoutPins.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Pin { id: string; version: string }`, `interface RepoRef { owner: string; repo: string }`
  - `interface SyncPlan { unchanged: PinnedRecord[]; revert: PinnedRecord[]; install: { pin: Pin; previous: PinnedRecord | null }[] }`
  - `DEFAULT_LOADOUTS_REPO`, `DEFAULT_LOADOUTS_API`, `DEFAULT_SYNC_TIMEOUT_S` (60)
  - `class PinError extends Error`
  - `parsePins(text: string | undefined): Pin[]`, `parseRepo(text: string | undefined): RepoRef`, `parseApiBase(text: string | undefined): string`, `parseTimeoutS(text: string | undefined): number`, `pinTag(p: Pin): string`, `planSync(pins: Pin[], repo: RepoRef, installed: PinnedRecord[]): SyncPlan`
  - from `loadoutRecord.ts`: `interface PinnedRecord`, `interface RecordFile`

- [ ] **Step 1: Write the record types**

Create `src/host/loadoutRecord.ts`:

```ts
// /workspace/.claude/fleet-loadouts.json: what the pinned-loadout sync installed, for an exact revert.

export interface PinnedRecord {
  id: string;
  version: string;
  /** owner/repo the pin came from. */
  repo: string;
  commit: string;
  /** Workspace-relative paths applyLoadoutFiles wrote. */
  files: string[];
  claudeMd: boolean;
  settingsKeys: string[];
  mcpServers: string[];
  hooks: { event: string; entry: unknown }[];
  installedAt: number;
}

export interface RecordFile {
  version: 1;
  loadouts: PinnedRecord[];
}
```

- [ ] **Step 2: Write the failing test**

Create `src/host/loadoutPins.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADOUTS_API,
  DEFAULT_SYNC_TIMEOUT_S,
  parseApiBase,
  parsePins,
  parseRepo,
  parseTimeoutS,
  pinTag,
  planSync
} from './loadoutPins.js';
import type { PinnedRecord } from './loadoutRecord.js';

describe('parsePins', () => {
  it('reads whitespace- and comma-separated id@version pins', () => {
    expect(parsePins('committee-pr-review@2.1.1 git-sync-sumer@1.0.0')).toEqual([
      { id: 'committee-pr-review', version: '2.1.1' },
      { id: 'git-sync-sumer', version: '1.0.0' }
    ]);
    expect(parsePins(' a@1.0.0,b@2.0.0-rc.1\n')).toEqual([
      { id: 'a', version: '1.0.0' },
      { id: 'b', version: '2.0.0-rc.1' }
    ]);
  });

  it('reads nothing pinned as an empty list', () => {
    expect(parsePins(undefined)).toEqual([]);
    expect(parsePins('  ,  ')).toEqual([]);
  });

  it.each(['a', 'a@', '@1.0.0', 'A@1.0.0', 'a@1.0', 'a@v1.0.0', 'a@01.0.0', 'a@1.0.0+build', 'a/b@1.0.0', '../x@1.0.0', '-a@1.0.0'])(
    'refuses %s',
    (text) => {
      expect(() => parsePins(text)).toThrow(`FLEET_LOADOUTS: "${text}" is not <id>@<semver>`);
    }
  );

  it('refuses an id pinned twice', () => {
    expect(() => parsePins('a@1.0.0 a@2.0.0')).toThrow('FLEET_LOADOUTS: a is pinned twice');
  });
});

describe('settings', () => {
  it('defaults and validates the repo', () => {
    expect(parseRepo(undefined)).toEqual({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
    expect(parseRepo('acme/loadouts')).toEqual({ owner: 'acme', repo: 'loadouts' });
    for (const bad of ['acme', 'acme/x/y', 'acme/..', 'ac me/x', '/x']) {
      expect(() => parseRepo(bad)).toThrow(`FLEET_LOADOUTS_REPO: "${bad}" is not <owner>/<repo>`);
    }
  });

  it('defaults and validates the API base', () => {
    expect(parseApiBase(undefined)).toBe(DEFAULT_LOADOUTS_API);
    expect(parseApiBase('http://gh-fake:8090/')).toBe('http://gh-fake:8090');
    for (const bad of ['nope', 'ftp://x', 'https://u:p@x', 'https://x/?q=1', 'https://x/#f']) {
      expect(() => parseApiBase(bad)).toThrow(/^FLEET_LOADOUTS_API /);
    }
  });

  it('reads the timeout', () => {
    expect(parseTimeoutS(undefined)).toBe(DEFAULT_SYNC_TIMEOUT_S);
    expect(parseTimeoutS('5')).toBe(5);
    for (const bad of ['0', '601', '1.5', 'x', '']) {
      if (bad === '') expect(parseTimeoutS(bad)).toBe(60);
      else expect(() => parseTimeoutS(bad)).toThrow('FLEET_LOADOUTS_TIMEOUT_S must be 1 to 600');
    }
  });

  it('names the tag', () => {
    expect(pinTag({ id: 'committee-pr-review', version: '2.1.1' })).toBe('committee-pr-review/v2.1.1');
  });
});

describe('planSync', () => {
  const repo = { owner: 'SumerSports', repo: 'claude-fleet-loadouts' };
  const r = (id: string, version: string, from = 'SumerSports/claude-fleet-loadouts'): PinnedRecord => ({
    id,
    version,
    repo: from,
    commit: 'a'.repeat(40),
    files: [],
    claudeMd: false,
    settingsKeys: [],
    mcpServers: [],
    hooks: [],
    installedAt: 1
  });

  it('plans unchanged, install and revert', () => {
    const plan = planSync(
      [{ id: 'a', version: '1.0.0' }, { id: 'b', version: '2.0.0' }, { id: 'c', version: '1.0.0' }],
      repo,
      [r('a', '1.0.0'), r('b', '1.0.0'), r('d', '1.0.0')]
    );
    expect(plan.unchanged.map((x) => x.id)).toEqual(['a']);
    expect(plan.install).toEqual([
      { pin: { id: 'b', version: '2.0.0' }, previous: r('b', '1.0.0') },
      { pin: { id: 'c', version: '1.0.0' }, previous: null }
    ]);
    expect(plan.revert.map((x) => x.id)).toEqual(['d']);
  });

  it('treats another repo as a change and matches the repo case-insensitively', () => {
    expect(planSync([{ id: 'a', version: '1.0.0' }], repo, [r('a', '1.0.0', 'acme/loadouts')]).install).toHaveLength(1);
    expect(planSync([{ id: 'a', version: '1.0.0' }], repo, [r('a', '1.0.0', 'sumersports/Claude-Fleet-Loadouts')]).unchanged).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutPins.test.ts`
Expected: FAIL with `Failed to load url ./loadoutPins.js` (or "Cannot find module").

- [ ] **Step 4: Implement**

Create `src/host/loadoutPins.ts`:

```ts
// FLEET_LOADOUTS pins, the sync's settings and its plan (pure).
import type { PinnedRecord } from './loadoutRecord.js';

export interface Pin {
  id: string;
  version: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface SyncPlan {
  unchanged: PinnedRecord[];
  revert: PinnedRecord[];
  install: { pin: Pin; previous: PinnedRecord | null }[];
}

export const DEFAULT_LOADOUTS_REPO = 'SumerSports/claude-fleet-loadouts';
export const DEFAULT_LOADOUTS_API = 'https://api.github.com';
export const DEFAULT_SYNC_TIMEOUT_S = 60;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;

export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinError';
  }
}

export function parsePins(text: string | undefined): Pin[] {
  const seen = new Set<string>();
  return (text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const at = token.indexOf('@');
      const id = at > 0 ? token.slice(0, at) : '';
      const version = at > 0 ? token.slice(at + 1) : '';
      if (!ID.test(id) || !SEMVER.test(version)) throw new PinError(`FLEET_LOADOUTS: "${token.slice(0, 120)}" is not <id>@<semver>`);
      if (seen.has(id)) throw new PinError(`FLEET_LOADOUTS: ${id} is pinned twice`);
      seen.add(id);
      return { id, version };
    });
}

export function parseRepo(text: string | undefined): RepoRef {
  const s = (text ?? '').trim() || DEFAULT_LOADOUTS_REPO;
  const parts = s.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new PinError(`FLEET_LOADOUTS_REPO: "${s.slice(0, 160)}" is not <owner>/<repo>`);
  }
  return { owner, repo };
}

export function parseApiBase(text: string | undefined): string {
  const s = (text ?? '').trim() || DEFAULT_LOADOUTS_API;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new PinError('FLEET_LOADOUTS_API is not a URL');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new PinError('FLEET_LOADOUTS_API must be an http(s) URL without credentials, query or fragment');
  }
  return u.href.replace(/\/+$/, '');
}

export function parseTimeoutS(text: string | undefined): number {
  if (!text) return DEFAULT_SYNC_TIMEOUT_S;
  const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 600)) throw new PinError('FLEET_LOADOUTS_TIMEOUT_S must be 1 to 600');
  return n;
}

export function pinTag(p: Pin): string {
  return `${p.id}/v${p.version}`;
}

export function planSync(pins: Pin[], repo: RepoRef, installed: PinnedRecord[]): SyncPlan {
  const full = `${repo.owner}/${repo.repo}`.toLowerCase();
  const byId = new Map(installed.map((r) => [r.id, r]));
  const pinned = new Set(pins.map((p) => p.id));
  const plan: SyncPlan = { unchanged: [], revert: installed.filter((r) => !pinned.has(r.id)), install: [] };
  for (const pin of pins) {
    const previous = byId.get(pin.id) ?? null;
    if (previous && previous.version === pin.version && previous.repo.toLowerCase() === full) plan.unchanged.push(previous);
    else plan.install.push({ pin, previous });
  }
  return plan;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutPins.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/host/loadoutPins.ts src/host/loadoutPins.test.ts src/host/loadoutRecord.ts
git commit -m "feat(host): FLEET_LOADOUTS pins, settings and sync plan"
```

---

### Task 2: The record file

**Files:**
- Modify: `src/host/loadoutRecord.ts`
- Test: `src/host/loadoutRecord.test.ts`

**Interfaces:**
- Consumes: `PinnedRecord`, `RecordFile` (Task 1); `safeLayerPath(destDir, title)` from `src/main/ociCore.ts`.
- Produces: `RECORD_PATH` (`'.claude/fleet-loadouts.json'`), `class RecordError extends Error`, `readRecord(target: string): Promise<RecordFile>`, `writeRecord(target: string, file: RecordFile): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/host/loadoutRecord.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD_PATH, readRecord, writeRecord, type PinnedRecord } from './loadoutRecord.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lrecord-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (over: Partial<PinnedRecord> = {}): PinnedRecord => ({
  id: 'demo',
  version: '1.0.0',
  repo: 'SumerSports/claude-fleet-loadouts',
  commit: 'a'.repeat(40),
  files: ['.claude/skills/demo/SKILL.md'],
  claudeMd: false,
  settingsKeys: [],
  mcpServers: [],
  hooks: [{ event: 'Stop', entry: { command: 'x' } }],
  installedAt: 1,
  ...over
});

describe('record file', () => {
  it('reads a missing record as empty', async () => {
    expect(await readRecord(dir)).toEqual({ version: 1, loadouts: [] });
  });

  it('round-trips, leaves no temp file and is 0644', async () => {
    await writeRecord(dir, { version: 1, loadouts: [rec()] });
    expect(await readRecord(dir)).toEqual({ version: 1, loadouts: [rec()] });
    expect(await readdir(join(dir, '.claude'))).toEqual(['fleet-loadouts.json']);
    expect((await stat(join(dir, RECORD_PATH))).mode & 0o777).toBe(0o644);
  });

  it.each([
    ['not JSON', '{', `${RECORD_PATH} is not JSON`],
    ['another version', JSON.stringify({ version: 2, loadouts: [] }), `${RECORD_PATH} is malformed`],
    ['a path outside the target', JSON.stringify({ version: 1, loadouts: [rec({ files: ['../../etc/passwd'] })] }), `${RECORD_PATH} is malformed`],
    ['a duplicate id', JSON.stringify({ version: 1, loadouts: [rec(), rec()] }), `${RECORD_PATH} is malformed`],
    ['a missing field', JSON.stringify({ version: 1, loadouts: [{ id: 'demo' }] }), `${RECORD_PATH} is malformed`]
  ])('refuses %s', async (_what, body, message) => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, RECORD_PATH), body);
    await expect(readRecord(dir)).rejects.toThrow(message);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutRecord.test.ts`
Expected: FAIL with `readRecord is not a function` (or a missing export error).

- [ ] **Step 3: Implement**

Append to `src/host/loadoutRecord.ts`, and add the imports at the top of the file below the header comment:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeLayerPath } from '../main/ociCore.js';
```

```ts
export const RECORD_PATH = join('.claude', 'fleet-loadouts.json');

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validEntry(e: unknown, target: string): e is PinnedRecord {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.version !== 'string' || typeof r.repo !== 'string' || typeof r.commit !== 'string') return false;
  if (!strings(r.files) || typeof r.claudeMd !== 'boolean' || !strings(r.settingsKeys) || !strings(r.mcpServers)) return false;
  if (typeof r.installedAt !== 'number') return false;
  if (!Array.isArray(r.hooks) || !r.hooks.every((h) => !!h && typeof h === 'object' && typeof (h as { event?: unknown }).event === 'string')) return false;
  try {
    for (const f of r.files) safeLayerPath(target, f);
  } catch {
    return false;
  }
  return true;
}

export async function readRecord(target: string): Promise<RecordFile> {
  let raw: string;
  try {
    raw = await readFile(join(target, RECORD_PATH), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, loadouts: [] };
    throw new RecordError(`cannot read ${RECORD_PATH}: ${code ?? 'error'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecordError(`${RECORD_PATH} is not JSON`);
  }
  const f = parsed as { version?: unknown; loadouts?: unknown } | null;
  const entries = f && f.version === 1 && Array.isArray(f.loadouts) ? (f.loadouts as unknown[]) : null;
  if (!entries || !entries.every((e) => validEntry(e, target))) throw new RecordError(`${RECORD_PATH} is malformed`);
  const loadouts = entries as PinnedRecord[];
  if (new Set(loadouts.map((l) => l.id)).size !== loadouts.length) throw new RecordError(`${RECORD_PATH} is malformed`);
  return { version: 1, loadouts };
}

export async function writeRecord(target: string, file: RecordFile): Promise<void> {
  const path = join(target, RECORD_PATH);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutRecord.test.ts src/host/loadoutPins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/loadoutRecord.ts src/host/loadoutRecord.test.ts
git commit -m "feat(host): pinned-loadout record file"
```

---

### Task 3: Safe tarball extraction

**Files:**
- Modify: `src/main/ociCore.ts` (add `MAX_BLOB_BYTES`)
- Modify: `src/main/ociClient.ts:10-19` (import and re-export it)
- Create: `src/host/loadoutTar.ts`
- Create: `src/host/testTar.ts` (test helper, not shipped)
- Test: `src/host/loadoutTar.test.ts`

**Interfaces:**
- Consumes: `safeLayerPath` from `src/main/ociCore.ts`.
- Produces:
  - `MAX_BLOB_BYTES` exported from `ociCore.ts` (still exported from `ociClient.ts`);
  - `interface TarLimits { tarball: number; tar: number; file: number; total: number; files: number }`, `TAR_LIMITS`;
  - `class TarError extends Error`;
  - `tarEntries(tar: Buffer): Generator<TarEntry>`;
  - `extractLoadout(tgz: Buffer, id: string, destDir: string, limits?: TarLimits): Promise<string[]>`, which returns the sorted loadout-relative file paths;
  - test helper `testTar.ts`: `interface TarSpec { path: string; type?: string; body?: string | Buffer; mode?: number; linkname?: string }`, `buildTar(entries: TarSpec[]): Buffer`, `buildTarGz(entries: TarSpec[]): Buffer`.

- [ ] **Step 1: Move `MAX_BLOB_BYTES` to `ociCore.ts`**

In `src/main/ociCore.ts`, after `export function safeLayerPath(…) { … }`, add:

```ts
/** Per-file cap for pulled loadout files (OCI layers on the desktop, tarball entries in fleet-host). */
export const MAX_BLOB_BYTES = 5_242_880;
```

In `src/main/ociClient.ts`, add `MAX_BLOB_BYTES,` to the `import { … } from './ociCore.js'` list and replace

```ts
export const MAX_BLOB_BYTES = 5_242_880; // 5 MiB/layer — loadout files are small.
```

with

```ts
export { MAX_BLOB_BYTES };
```

Run: `npx vitest run src/main/ociClient.test.ts src/main/ociCore.test.ts`
Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write the test helper**

Create `src/host/testTar.ts`:

```ts
// tar.gz archives for tests, shaped like `git archive` output (pax global header, ustar entries, pax long paths).
import { gzipSync } from 'node:zlib';

export interface TarSpec {
  path: string;
  /** '0' file (default), '5' directory, '1' hardlink, '2' symlink, … */
  type?: string;
  body?: string | Buffer;
  mode?: number;
  linkname?: string;
}

function paxRecord(key: string, value: string): Buffer {
  const kv = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(kv);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return Buffer.from(`${len}${kv}`);
}

function header(name: string, size: number, type: string, mode: number, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  h.write('0001750\0', 108, 'latin1');
  h.write('0001750\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('14760000000\0', 136, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar' + '\0' + '00', 257, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

function padded(b: Buffer): Buffer[] {
  const r = b.length % 512;
  return r ? [b, Buffer.alloc(512 - r)] : [b];
}

export function buildTar(entries: TarSpec[]): Buffer {
  const global = paxRecord('comment', 'f'.repeat(40));
  const parts: Buffer[] = [header('pax_global_header', global.length, 'g', 0o666), ...padded(global)];
  for (const e of entries) {
    const type = e.type ?? '0';
    const body = typeof e.body === 'string' ? Buffer.from(e.body) : (e.body ?? Buffer.alloc(0));
    let name = e.path;
    if (Buffer.byteLength(name) > 100) {
      const rec = paxRecord('path', e.path);
      parts.push(header('PaxHeader', rec.length, 'x', 0o644), ...padded(rec));
      name = e.path.slice(0, 100);
    }
    const size = type === '0' ? body.length : 0;
    parts.push(header(name, size, type, e.mode ?? (type === '5' ? 0o755 : 0o644), e.linkname));
    if (size) parts.push(...padded(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const buildTarGz = (entries: TarSpec[]): Buffer => gzipSync(buildTar(entries));
```

- [ ] **Step 3: Write the failing test**

Create `src/host/loadoutTar.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractLoadout, TAR_LIMITS } from './loadoutTar.js';
import { buildTar, buildTarGz, type TarSpec } from './testTar.js';

const ROOT = 'SumerSports-claude-fleet-loadouts-abc1234';
const MD = '---\ntitle: demo\ndescription: d\nversion: 1.0.0\n---\n';
const md: TarSpec = { path: 'loadouts/demo/loadout.md', body: MD };
const repo = (entries: TarSpec[]): Buffer =>
  buildTarGz([{ path: `${ROOT}/`, type: '5' }, ...entries.map((e) => ({ ...e, path: `${ROOT}/${e.path}` }))]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ltar-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractLoadout', () => {
  it('extracts only loadouts/<id>/ and keeps exec bits', async () => {
    const files = await extractLoadout(
      repo([
        { path: 'README.md', body: 'repo readme' },
        { path: 'loadouts/', type: '5' },
        { path: 'loadouts/demo/', type: '5' },
        md,
        { path: 'loadouts/demo/skills/demo/run.sh', body: '#!/bin/sh\n', mode: 0o755 },
        { path: 'loadouts/demo-two/loadout.md', body: MD },
        { path: 'loadouts/other/loadout.md', body: MD }
      ]),
      'demo',
      dir
    );
    expect(files).toEqual(['loadout.md', 'skills/demo/run.sh']);
    expect((await stat(join(dir, 'skills/demo/run.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, 'loadout.md'))).mode & 0o777).toBe(0o644);
    expect((await readdir(dir)).sort()).toEqual(['loadout.md', 'skills']);
  });

  it('reads pax long paths', async () => {
    const inner = `skills/${'a'.repeat(60)}/${'b'.repeat(60)}/SKILL.md`;
    expect(await extractLoadout(repo([md, { path: `loadouts/demo/${inner}`, body: 'deep' }]), 'demo', dir)).toContain(inner);
    expect(await readFile(join(dir, inner), 'utf8')).toBe('deep');
  });

  it.each([
    ['symlink', { path: 'loadouts/demo/skills/x', type: '2', linkname: '/etc/passwd' }],
    ['hardlink', { path: 'loadouts/demo/skills/x', type: '1', linkname: `${ROOT}/README.md` }],
    ['entry type "6"', { path: 'loadouts/demo/fifo', type: '6' }]
  ] as [string, TarSpec][])('refuses a %s inside the loadout and writes nothing', async (kind, entry) => {
    await expect(extractLoadout(repo([md, entry]), 'demo', dir)).rejects.toThrow(`${kind} at ${entry.path} is not allowed`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('ignores links outside the loadout', async () => {
    expect(await extractLoadout(repo([md, { path: 'docs/link', type: '2', linkname: '../README.md' }]), 'demo', dir)).toEqual(['loadout.md']);
  });

  it('refuses a path that escapes the loadout', async () => {
    await expect(extractLoadout(repo([md, { path: 'loadouts/demo/../../evil', body: 'x' }]), 'demo', dir)).rejects.toThrow(
      'unsafe path loadouts/demo/../../evil'
    );
  });

  it('refuses a second top-level directory', async () => {
    const tgz = buildTarGz([{ path: `${ROOT}/`, type: '5' }, { path: `${ROOT}/loadouts/demo/loadout.md`, body: MD }, { path: 'elsewhere/x', body: 'x' }]);
    await expect(extractLoadout(tgz, 'demo', dir)).rejects.toThrow('archive has more than one top-level directory');
  });

  it('refuses a duplicate entry and a missing loadout.md', async () => {
    await expect(extractLoadout(repo([md, md]), 'demo', dir)).rejects.toThrow('duplicate entry loadouts/demo/loadout.md');
    await expect(extractLoadout(repo([{ path: 'loadouts/demo/CLAUDE.md', body: 'x' }]), 'demo', dir)).rejects.toThrow(
      'loadouts/demo/loadout.md is not in the archive'
    );
  });

  it('enforces every cap', async () => {
    const two = [md, { path: 'loadouts/demo/a.md', body: 'x'.repeat(20) }, { path: 'loadouts/demo/b.md', body: 'y' }];
    await expect(extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, file: 10 })).rejects.toThrow('loadouts/demo/loadout.md is over 10 bytes');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, files: 2 })).rejects.toThrow('loadouts/demo has more than 2 files');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, total: 60 })).rejects.toThrow('loadouts/demo is over 60 bytes');
    await expect(extractLoadout(repo(two), 'demo', dir, { ...TAR_LIMITS, tar: 2048 })).rejects.toThrow('archive is over 2048 bytes');
    await expect(extractLoadout(repo([md]), 'demo', dir, { ...TAR_LIMITS, tarball: 10 })).rejects.toThrow('tarball is over 10 bytes');
    expect(TAR_LIMITS.file).toBe(5_242_880);
  });

  it('refuses a corrupt header and a non-gzip body', async () => {
    const tar = buildTar([{ path: `${ROOT}/`, type: '5' }, { path: `${ROOT}/loadouts/demo/loadout.md`, body: MD }]);
    tar[1024] ^= 1;
    await expect(extractLoadout(gzipSync(tar), 'demo', dir)).rejects.toThrow('bad header checksum');
    await expect(extractLoadout(Buffer.from('not gzip'), 'demo', dir)).rejects.toThrow('not a gzip archive');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutTar.test.ts`
Expected: FAIL with a missing module error for `./loadoutTar.js`.

- [ ] **Step 5: Implement**

Create `src/host/loadoutTar.ts`:

```ts
// One loadout out of a GitHub tarball (`git archive`, gzip): regular files and directories only, capped, confined.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MAX_BLOB_BYTES, safeLayerPath } from '../main/ociCore.js';

export interface TarLimits {
  /** Compressed download. */
  tarball: number;
  /** Decompressed archive: the whole repo. */
  tar: number;
  file: number;
  /** One loadout's files together. */
  total: number;
  files: number;
}

export const TAR_LIMITS: Readonly<TarLimits> = Object.freeze({
  tarball: 25 * 1024 * 1024,
  tar: 100 * 1024 * 1024,
  file: MAX_BLOB_BYTES,
  total: 20 * 1024 * 1024,
  files: 1000
});

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface TarEntry {
  path: string;
  type: string;
  mode: number;
  data: Buffer;
}

const LINK_KINDS: Record<string, string> = { '1': 'hardlink', '2': 'symlink' };

function octal(h: Buffer, off: number, len: number, what: string): number {
  const f = h.subarray(off, off + len);
  if (f[0] & 0x80) throw new TarError(`${what}: base-256 numbers are not supported`);
  const z = f.indexOf(0);
  const s = (z === -1 ? f : f.subarray(0, z)).toString('latin1').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`${what} is not octal`);
  return parseInt(s, 8);
}

function cstr(h: Buffer, off: number, len: number): string {
  const f = h.subarray(off, off + len);
  const z = f.indexOf(0);
  return (z === -1 ? f : f.subarray(0, z)).toString('utf8');
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === octal(h, 148, 8, 'checksum');
}

function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const len = sp === -1 ? NaN : Number(data.subarray(i, sp).toString('latin1'));
    if (!Number.isInteger(len) || len <= sp - i + 1 || i + len > data.length) throw new TarError('bad pax record');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') path = rec.slice(eq + 1);
    i += len;
  }
  return path;
}

/** Entries in order; a pax `x` path applies to the next entry and `g` headers are skipped. */
export function* tarEntries(tar: Buffer): Generator<TarEntry> {
  let off = 0;
  let paxNext: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    if (!checksumOk(h)) throw new TarError('bad header checksum');
    const size = octal(h, 124, 12, 'size');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const start = off + 512;
    if (start + size > tar.length) throw new TarError('truncated archive');
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      paxNext = paxPath(data);
      continue;
    }
    if (type === 'L' || type === 'K') throw new TarError('GNU long names are not supported');
    const name = cstr(h, 0, 100);
    const prefix = h.subarray(257, 263).toString('latin1') === 'ustar\0' ? cstr(h, 345, 155) : '';
    yield { path: paxNext ?? (prefix ? `${prefix}/${name}` : name), type, mode: octal(h, 100, 8, 'mode'), data };
    paxNext = null;
  }
  throw new TarError('truncated archive');
}

/** Writes `loadouts/<id>/` into destDir only after the whole archive passed; returns the loadout-relative files. */
export async function extractLoadout(tgz: Buffer, id: string, destDir: string, limits: TarLimits = TAR_LIMITS): Promise<string[]> {
  if (tgz.length > limits.tarball) throw new TarError(`tarball is over ${limits.tarball} bytes`);
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: limits.tar });
  } catch (e) {
    throw new TarError((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? `archive is over ${limits.tar} bytes` : 'not a gzip archive');
  }
  const scope = `loadouts/${id}/`;
  const writes: { target: string; data: Buffer; mode: number }[] = [];
  const seen = new Set<string>();
  let root: string | null = null;
  let total = 0;
  for (const e of tarEntries(tar)) {
    const slash = e.path.indexOf('/');
    const top = slash === -1 ? e.path : e.path.slice(0, slash);
    root ??= top;
    if (top !== root) throw new TarError('archive has more than one top-level directory');
    const rel = slash === -1 ? '' : e.path.slice(slash + 1);
    if (!rel.startsWith(scope) || e.type === '5') continue;
    if (e.type !== '0') throw new TarError(`${LINK_KINDS[e.type] ?? `entry type ${JSON.stringify(e.type)}`} at ${rel} is not allowed`);
    const inner = rel.slice(scope.length);
    let target: string;
    try {
      target = safeLayerPath(destDir, inner);
    } catch {
      throw new TarError(`unsafe path ${rel}`);
    }
    if (seen.has(inner)) throw new TarError(`duplicate entry ${rel}`);
    seen.add(inner);
    if (seen.size > limits.files) throw new TarError(`loadouts/${id} has more than ${limits.files} files`);
    if (e.data.length > limits.file) throw new TarError(`${rel} is over ${limits.file} bytes`);
    total += e.data.length;
    if (total > limits.total) throw new TarError(`loadouts/${id} is over ${limits.total} bytes`);
    writes.push({ target, data: e.data, mode: e.mode & 0o111 ? 0o755 : 0o644 });
  }
  if (!seen.has('loadout.md')) throw new TarError(`loadouts/${id}/loadout.md is not in the archive`);
  for (const w of writes) {
    await mkdir(dirname(w.target), { recursive: true });
    await writeFile(w.target, w.data, { mode: w.mode, flag: 'wx' });
  }
  return [...seen].sort();
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutTar.test.ts src/main/ociClient.test.ts src/main/ociCore.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/ociCore.ts src/main/ociClient.ts src/host/loadoutTar.ts src/host/loadoutTar.test.ts src/host/testTar.ts
git commit -m "feat(host): safe one-loadout extraction from a GitHub tarball"
```

---

### Task 4: GitHub fetch (tag → commit on the default branch → tarball)

**Files:**
- Create: `src/host/loadoutFetch.ts`
- Create: `src/host/testGithubRepo.ts` (test helper, not shipped)
- Test: `src/host/loadoutFetch.test.ts`

**Interfaces:**
- Consumes: `isTokenShaped` from `src/main/ociCore.ts`; `TAR_LIMITS`, `extractLoadout` (Task 3); `buildTarGz`, `TarSpec` (Task 3 helper).
- Produces:
  - `interface GithubSource { api: string; owner: string; repo: string; token: string }`;
  - `type FetchStage = 'resolve' | 'download'` and `class FetchError extends Error { stage: FetchStage; status?: number }`;
  - `defaultBranch(src, signal): Promise<string>`;
  - `resolveTag(src, tag: string, branch: string, signal): Promise<string>` (a 40-hex commit);
  - `downloadTarball(src, commit: string, signal, cap?: number): Promise<Buffer>`;
  - `readCapped(res: Response, cap: number): Promise<Buffer>`;
  - test helper `testGithubRepo.ts`: `startFakeGithubRepo({ owner, repo }): Promise<FakeGithubRepo>` (`url`, `token`, `tags: Map<string, FakeTag>`, `requests`, `failTarball: Set<string>`, `hangTarball`, `location`, `close()`), `FakeTag { commit; files; annotated?; onMain? }`, `FakeFile`, `sha(n)`, `annotatedSha(commit)`, `loadoutFiles(id, version, extra?)`.

- [ ] **Step 1: Write the fake GitHub API**

Create `src/host/testGithubRepo.ts`:

```ts
// Fake GitHub REST API for the pinned-loadout sync (not shipped): repository, tag refs, annotated tags,
// compare and tarball → codeload redirects. Codeload answers 400 if it receives an Authorization header.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTarGz, type TarSpec } from './testTar.js';

export type FakeFile = string | Omit<TarSpec, 'path'>;

export interface FakeTag {
  commit: string;
  /** Repo-relative paths, e.g. loadouts/demo/loadout.md. */
  files: Record<string, FakeFile>;
  annotated?: boolean;
  /** false: compare answers `diverged`. */
  onMain?: boolean;
}

export interface FakeGithubRepo {
  url: string;
  token: string;
  tags: Map<string, FakeTag>;
  requests: { method: string; path: string; auth: string | null }[];
  failTarball: Set<string>;
  hangTarball: boolean;
  location: ((commit: string) => string) | null;
  close(): Promise<void>;
}

export const sha = (n: number): string => n.toString(16).padStart(40, '0');
export const annotatedSha = (commit: string): string => `e${commit.slice(1)}`;

export function loadoutFiles(id: string, version: string, extra: Record<string, FakeFile> = {}): Record<string, FakeFile> {
  return {
    [`loadouts/${id}/loadout.md`]: `---\ntitle: ${id}\ndescription: test loadout\nversion: ${version}\n---\nInstall ${id}.\n`,
    [`loadouts/${id}/skills/${id}/SKILL.md`]: `---\nname: ${id}\ndescription: ${id} ${version}\n---\n${id} ${version}\n`,
    ...extra
  };
}

export async function startFakeGithubRepo(o: { owner: string; repo: string }): Promise<FakeGithubRepo> {
  const base = `/repos/${o.owner}/${o.repo}`;
  const fake: FakeGithubRepo = {
    url: '',
    token: `ghs_${'t'.repeat(36)}`,
    tags: new Map(),
    requests: [],
    failTarball: new Set(),
    hangTarball: false,
    location: null,
    close: async () => undefined
  };
  const byCommit = (c: string): FakeTag | undefined => [...fake.tags.values()].find((t) => t.commit === c);
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    fake.requests.push({ method: req.method ?? '', path, auth });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith('/codeload/')) {
      if (auth) return send(400, { message: 'Authorization sent to codeload' });
      const commit = path.slice('/codeload/'.length);
      const tag = byCommit(commit);
      if (!tag) return send(404, { message: 'Not Found' });
      if (fake.hangTarball) return;
      if (fake.failTarball.has(commit)) return send(500, { message: 'Server Error' });
      const root = `${o.owner}-${o.repo}-${commit.slice(0, 7)}`;
      const entries: TarSpec[] = [{ path: `${root}/`, type: '5' }];
      for (const [p, f] of Object.entries(tag.files)) entries.push(typeof f === 'string' ? { path: `${root}/${p}`, body: f } : { ...f, path: `${root}/${p}` });
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      res.end(buildTarGz(entries));
      return;
    }
    if (auth !== `Bearer ${fake.token}`) return send(401, { message: 'Bad credentials' });
    if (path === base) return send(200, { default_branch: 'main' });
    if (path.startsWith(`${base}/git/ref/tags/`)) {
      const name = decodeURIComponent(path.slice(`${base}/git/ref/tags/`.length));
      const tag = fake.tags.get(name);
      if (!tag) return send(404, { message: 'Not Found' });
      const object = tag.annotated ? { type: 'tag', sha: annotatedSha(tag.commit) } : { type: 'commit', sha: tag.commit };
      return send(200, { ref: `refs/tags/${name}`, object });
    }
    if (path.startsWith(`${base}/git/tags/`)) {
      const s = path.slice(`${base}/git/tags/`.length);
      const tag = [...fake.tags.values()].find((t) => t.annotated && annotatedSha(t.commit) === s);
      return tag ? send(200, { object: { type: 'commit', sha: tag.commit } }) : send(404, { message: 'Not Found' });
    }
    const rest = path.startsWith(`${base}/`) ? path.slice(base.length) : '';
    const cmp = /^\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(rest);
    if (cmp) {
      const tag = byCommit(cmp[1]);
      return tag ? send(200, { status: tag.onMain === false ? 'diverged' : 'ahead' }) : send(404, { message: 'Not Found' });
    }
    const tb = /^\/tarball\/([0-9a-f]{40})$/.exec(rest);
    if (tb) {
      if (!byCommit(tb[1])) return send(404, { message: 'Not Found' });
      return send(302, {}, { location: fake.location ? fake.location(tb[1]) : `${fake.url}/codeload/${tb[1]}?token=codeload-only` });
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/host/loadoutFetch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBranch, downloadTarball, readCapped, resolveTag, type GithubSource } from './loadoutFetch.js';
import { extractLoadout } from './loadoutTar.js';
import { annotatedSha, loadoutFiles, sha, startFakeGithubRepo, type FakeGithubRepo } from './testGithubRepo.js';

const R = '/repos/SumerSports/claude-fleet-loadouts';
let gh: FakeGithubRepo;
let src: GithubSource;
let dir: string;
const signal = (): AbortSignal => AbortSignal.timeout(5_000);

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  src = { api: gh.url, owner: 'SumerSports', repo: 'claude-fleet-loadouts', token: gh.token };
  dir = await mkdtemp(join(tmpdir(), 'lfetch-'));
});
afterEach(async () => {
  await gh.close();
  await rm(dir, { recursive: true, force: true });
});

describe('loadoutFetch', () => {
  it('reads the default branch with the token', async () => {
    expect(await defaultBranch(src, signal())).toBe('main');
    expect(gh.requests).toEqual([{ method: 'GET', path: R, auth: `Bearer ${gh.token}` }]);
  });

  it('resolves a lightweight tag on the default branch', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    expect(await resolveTag(src, 'demo/v1.0.0', 'main', signal())).toBe(sha(1));
    expect(gh.requests.map((r) => r.path)).toEqual([`${R}/git/ref/tags/demo/v1.0.0`, `${R}/compare/${sha(1)}...main`]);
  });

  it('dereferences an annotated tag', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: {}, annotated: true });
    expect(await resolveTag(src, 'demo/v1.0.0', 'main', signal())).toBe(sha(1));
    expect(gh.requests.map((r) => r.path)).toContain(`${R}/git/tags/${annotatedSha(sha(1))}`);
  });

  it('refuses a tag whose commit is not on the default branch', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: {}, onMain: false });
    await expect(resolveTag(src, 'demo/v1.0.0', 'main', signal())).rejects.toThrow('resolve: tag demo/v1.0.0 is not on main');
  });

  it('reports a missing tag as a 404', async () => {
    await expect(resolveTag(src, 'demo/v9.9.9', 'main', signal())).rejects.toMatchObject({
      stage: 'resolve',
      status: 404,
      message: 'resolve: tag demo/v9.9.9 → HTTP 404'
    });
  });

  it('never puts the token in an error', async () => {
    const bad = { ...src, token: `ghs_${'x'.repeat(36)}` };
    const e = await defaultBranch(bad, signal()).catch((x: Error) => x);
    expect(e.message).toBe('resolve: repository → HTTP 401');
    expect(e.message).not.toContain(bad.token);
  });

  it('downloads through the codeload redirect without the token', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const tgz = await downloadTarball(src, sha(1), signal());
    expect(await extractLoadout(tgz, 'demo', dir)).toEqual(['loadout.md', 'skills/demo/SKILL.md']);
    expect(gh.requests.find((r) => r.path.startsWith('/codeload/'))).toEqual({ method: 'GET', path: `/codeload/${sha(1)}`, auth: null });
  });

  it('refuses a plain-http redirect to another origin', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.location = () => 'http://evil.example/x';
    await expect(downloadTarball(src, sha(1), signal())).rejects.toThrow('download: redirect to http: refused');
  });

  it('caps the body', async () => {
    await expect(readCapped(new Response(Buffer.alloc(10)), 5)).rejects.toThrow('download: tarball is over 5 bytes');
  });

  it('times out a stalled download', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.hangTarball = true;
    await expect(downloadTarball(src, sha(1), AbortSignal.timeout(200))).rejects.toThrow(/^download: timed out \(127\.0\.0\.1:\d+\)$/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutFetch.test.ts`
Expected: FAIL with a missing module error for `./loadoutFetch.js`.

- [ ] **Step 4: Implement**

Create `src/host/loadoutFetch.ts`:

```ts
// One pinned loadout from the GitHub REST API: tag → commit on the default branch → tarball (SPEC §7 Pinned loadouts).
import { isTokenShaped } from '../main/ociCore.js';
import { TAR_LIMITS } from './loadoutTar.js';

export interface GithubSource {
  /** API base without a trailing slash. */
  api: string;
  owner: string;
  repo: string;
  token: string;
}

export type FetchStage = 'resolve' | 'download';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly stage: FetchStage,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

const REQUEST_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/;

const segments = (s: string): string => s.split('/').map(encodeURIComponent).join('/');
const repoUrl = (s: GithubSource): string => `${s.api}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;

async function get(src: GithubSource, url: string, stage: FetchStage, signal: AbortSignal, withToken = true): Promise<Response> {
  if (withToken && !isTokenShaped(src.token)) throw new FetchError(`${stage}: the token is malformed`, stage);
  try {
    return await fetch(url, {
      headers: {
        ...(withToken ? { authorization: `Bearer ${src.token}` } : {}),
        accept: withToken ? 'application/vnd.github+json' : '*/*',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleet-host'
      },
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
    });
  } catch (e) {
    // Never the original message: undici can echo header values.
    const timedOut = signal.aborted || (e as Error).name === 'TimeoutError';
    throw new FetchError(`${stage}: ${timedOut ? 'timed out' : 'unreachable'} (${new URL(url).host})`, stage);
  }
}

async function json(res: Response, stage: FetchStage, what: string): Promise<Record<string, unknown>> {
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`${stage}: ${what} → HTTP ${res.status}`, stage, res.status);
  }
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new FetchError(`${stage}: ${what} is not a JSON object`, stage);
}

export async function defaultBranch(src: GithubSource, signal: AbortSignal): Promise<string> {
  const j = await json(await get(src, repoUrl(src), 'resolve', signal), 'resolve', 'repository');
  const b = j.default_branch;
  if (typeof b !== 'string' || !/^[A-Za-z0-9._/-]{1,255}$/.test(b)) throw new FetchError('resolve: the repository has no default branch', 'resolve');
  return b;
}

type GitObject = { type?: unknown; sha?: unknown } | undefined;

export async function resolveTag(src: GithubSource, tag: string, branch: string, signal: AbortSignal): Promise<string> {
  const ref = await json(await get(src, `${repoUrl(src)}/git/ref/tags/${segments(tag)}`, 'resolve', signal), 'resolve', `tag ${tag}`);
  let obj = ref.object as GitObject;
  if (obj?.type === 'tag' && typeof obj.sha === 'string' && SHA.test(obj.sha)) {
    const annotated = await json(await get(src, `${repoUrl(src)}/git/tags/${obj.sha}`, 'resolve', signal), 'resolve', `tag ${tag}`);
    obj = annotated.object as GitObject;
  }
  if (obj?.type !== 'commit' || typeof obj.sha !== 'string' || !SHA.test(obj.sha)) {
    throw new FetchError(`resolve: tag ${tag} does not point at a commit`, 'resolve');
  }
  const commit = obj.sha;
  const cmp = await json(await get(src, `${repoUrl(src)}/compare/${commit}...${segments(branch)}`, 'resolve', signal), 'resolve', `compare ${tag}`);
  if (cmp.status !== 'ahead' && cmp.status !== 'identical') throw new FetchError(`resolve: tag ${tag} is not on ${branch}`, 'resolve');
  return commit;
}

export async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`download: tarball is over ${cap} bytes`, 'download');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) {
        await reader.cancel().catch(() => undefined);
        throw new FetchError(`download: tarball is over ${cap} bytes`, 'download');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError('download: interrupted', 'download');
  }
  return Buffer.concat(chunks);
}

/** The codeload redirect carries its own short-lived token in the URL: followed once, without ours, never logged. */
export async function downloadTarball(src: GithubSource, commit: string, signal: AbortSignal, cap = TAR_LIMITS.tarball): Promise<Buffer> {
  if (!SHA.test(commit)) throw new FetchError('download: not a commit sha', 'download');
  let res = await get(src, `${repoUrl(src)}/tarball/${commit}`, 'download', signal);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    const loc = res.headers.get('location');
    let next: URL;
    try {
      if (!loc) throw new Error('no location');
      next = new URL(loc, `${src.api}/`);
    } catch {
      throw new FetchError('download: bad redirect', 'download');
    }
    if (next.protocol !== 'https:' && next.origin !== new URL(src.api).origin) throw new FetchError(`download: redirect to ${next.protocol} refused`, 'download');
    res = await get(src, next.href, 'download', signal, false);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`download: tarball → HTTP ${res.status}`, 'download', res.status);
  }
  return readCapped(res, cap);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutFetch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host/loadoutFetch.ts src/host/loadoutFetch.test.ts src/host/testGithubRepo.ts
git commit -m "feat(host): fetch a pinned loadout from the GitHub API"
```

---

### Task 5: The sync (reconcile, rollback, scripts, logs)

**Files:**
- Create: `src/host/loadoutSync.ts`
- Test: `src/host/loadoutSync.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `parsePins`, `parseRepo`, `parseApiBase`, `pinTag`, `planSync`, `DEFAULT_LOADOUTS_API`, `Pin`;
  - Task 2: `readRecord`, `writeRecord`, `PinnedRecord`, `RecordFile`;
  - Task 3: `extractLoadout`, `TarError`;
  - Task 4: `defaultBranch`, `resolveTag`, `downloadTarball`, `FetchError`, `GithubSource`;
  - `src/main/loadoutCore.ts`: `applyLoadoutFiles`, `applyLoadoutMerges`, `loadoutFileList`, `parseLoadout`, `revertLoadoutFiles`, `revertLoadoutMerges`, `runLoadoutScripts`, `LoadoutMeta`;
  - `isTokenShaped` (`ociCore.ts`); `Logger` (`log.ts`).
- Produces:
  - `type SyncStage = 'config' | 'record' | 'token' | 'resolve' | 'download' | 'extract' | 'verify' | 'revert' | 'apply' | 'timeout'`;
  - `interface ScriptRun { exitCode: number; output: string }`;
  - `interface SyncOptions { env: NodeJS.ProcessEnv; target: string; log: Logger; token(owner: string, repo: string): Promise<string>; runScript(command: string, cwd: string, timeoutMs: number): Promise<ScriptRun>; budgetMs: number; stagingRoot?: string }`;
  - `interface SyncSummary { installed: string[]; reverted: string[]; unchanged: string[]; failed: string[] }`;
  - `syncLoadouts(o: SyncOptions): Promise<SyncSummary>`.
- Log messages (exact): `loadout sync failed`, `loadout installed`, `loadout reverted`, `loadout rolled back`, `loadout rollback failed`, `loadout script`, `loadout script failed`, `loadout dependency not pinned`, `loadout automations not installed`, `loadout sync uses a non-default API`, `loadout sync done`.

- [ ] **Step 1: Write the failing test**

Create `src/host/loadoutSync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecord } from './loadoutRecord.js';
import { syncLoadouts, type ScriptRun, type SyncOptions } from './loadoutSync.js';
import { loadoutFiles, sha, startFakeGithubRepo, type FakeFile, type FakeGithubRepo } from './testGithubRepo.js';

type Line = { level: string; msg: string } & Record<string, unknown>;

let gh: FakeGithubRepo;
let target: string;
let staging: string;
let lines: Line[];
let scripts: { command: string; cwd: string }[];

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  target = await mkdtemp(join(tmpdir(), 'lsync-target-'));
  staging = await mkdtemp(join(tmpdir(), 'lsync-staging-'));
  lines = [];
  scripts = [];
});
afterEach(async () => {
  await gh.close();
  await rm(target, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

function opts(pins: string | undefined, over: Partial<SyncOptions> = {}): SyncOptions {
  return {
    env: { FLEET_LOADOUTS: pins, FLEET_LOADOUTS_API: gh.url },
    target,
    log: { log: (level, msg, fields = {}) => void lines.push({ level, msg, ...fields }) },
    token: async () => gh.token,
    runScript: async (command, cwd): Promise<ScriptRun> => {
      scripts.push({ command, cwd });
      return { exitCode: 0, output: '' };
    },
    budgetMs: 10_000,
    stagingRoot: staging,
    ...over
  };
}
const read = (p: string): Promise<string> => readFile(join(target, p), 'utf8');
const exists = (p: string): Promise<boolean> => stat(join(target, p)).then(() => true, () => false);
const failures = (): Line[] => lines.filter((l) => l.msg === 'loadout sync failed');
const tag = (id: string, version: string, n: number, extra: Record<string, FakeFile> = {}): void => {
  gh.tags.set(`${id}/v${version}`, { commit: sha(n), files: loadoutFiles(id, version, extra) });
};
const setLoadoutMd = (tagName: string, text: string): void => {
  const id = tagName.split('/')[0];
  gh.tags.get(tagName)!.files[`loadouts/${id}/loadout.md`] = text;
};

describe('syncLoadouts', () => {
  it('installs a pin: files, CLAUDE.md block, merges and the record', async () => {
    tag('demo', '1.0.0', 1, {
      'loadouts/demo/CLAUDE.md': 'Use demo.\n',
      'loadouts/demo/settings.json': JSON.stringify({ env: { DEMO: '1' } }),
      'loadouts/demo/.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'demo-mcp' } } })
    });
    const s = await syncLoadouts(opts('demo@1.0.0'));
    expect(s).toEqual({ installed: ['demo@1.0.0'], reverted: [], unchanged: [], failed: [] });
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect(await read('CLAUDE.md')).toContain('<!-- loadout:demo start -->\nUse demo.\n<!-- loadout:demo end -->');
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ env: { DEMO: '1' } });
    expect(JSON.parse(await read('.mcp.json'))).toEqual({ mcpServers: { demo: { command: 'demo-mcp' } } });
    expect((await readRecord(target)).loadouts).toEqual([
      expect.objectContaining({
        id: 'demo',
        version: '1.0.0',
        repo: 'SumerSports/claude-fleet-loadouts',
        commit: sha(1),
        files: ['.claude/skills/demo/SKILL.md'],
        claudeMd: true,
        settingsKeys: ['env'],
        mcpServers: ['demo'],
        hooks: []
      })
    ]);
    expect(await readdir(staging)).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ msg: 'loadout sync done', installed: ['demo@1.0.0'] });
  });

  it('skips an unchanged pin without asking for a token', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0'));
    const calls = gh.requests.length;
    const s = await syncLoadouts(opts('demo@1.0.0', { token: () => Promise.reject(new Error('no token expected')) }));
    expect(s).toEqual({ installed: [], reverted: [], unchanged: ['demo@1.0.0'], failed: [] });
    expect(gh.requests.length).toBe(calls);
  });

  it('reverts the previous version before applying a new one', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n' });
    tag('demo', '2.0.0', 2, { 'loadouts/demo/CLAUDE.md': 'two\n', 'loadouts/demo/commands/demo.md': 'run demo\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.installed).toEqual(['demo@2.0.0']);
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 2.0.0');
    expect(await read('.claude/commands/demo.md')).toBe('run demo\n');
    const md = await read('CLAUDE.md');
    expect(md).toContain('two');
    expect(md).not.toContain('one');
    expect((await readRecord(target)).loadouts.map((r) => [r.version, r.commit])).toEqual([['2.0.0', sha(2)]]);
  });

  it('reverts a loadout that is no longer pinned', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n', 'loadouts/demo/settings.json': '{"env":{"A":"1"}}' });
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts(undefined));
    expect(s.reverted).toEqual(['demo@1.0.0']);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
    expect(await exists('CLAUDE.md')).toBe(false);
    expect(await exists('.claude/settings.json')).toBe(false);
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('keeps the previous version when the new one fails to download', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2);
    await syncLoadouts(opts('demo@1.0.0'));
    gh.failTarball.add(sha(2));
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(failures()).toEqual([
      expect.objectContaining({ level: 'error', stage: 'download', id: 'demo', version: '2.0.0', error: 'download: tarball → HTTP 500' })
    ]);
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect((await readRecord(target)).loadouts.map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('refuses a tag whose loadout.md has another version', async () => {
    gh.tags.set('demo/v3.0.0', { commit: sha(3), files: loadoutFiles('demo', '2.9.9') });
    await syncLoadouts(opts('demo@3.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'verify', error: 'loadout.md version is 2.9.9, not 3.0.0' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  it('reports a missing tag', async () => {
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'resolve', error: 'resolve: tag demo/v1.0.0 → HTTP 404' })]);
  });

  it('rolls back to the previous version when the apply fails', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'apply', id: 'demo', version: '2.0.0' })]);
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'loadout rolled back', id: 'demo', version: '1.0.0' }));
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect((await readRecord(target)).loadouts.map((r) => [r.version, r.commit])).toEqual([['1.0.0', sha(1)]]);
  });

  it('changes nothing when FLEET_LOADOUTS is malformed', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts('demo@1.0'));
    expect(s).toEqual({ installed: [], reverted: [], unchanged: [], failed: [] });
    expect(failures()).toEqual([expect.objectContaining({ stage: 'config' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(true);
  });

  it('changes nothing when the record is unreadable', async () => {
    tag('demo', '1.0.0', 1);
    await mkdir(join(target, '.claude'), { recursive: true });
    await writeFile(join(target, '.claude/fleet-loadouts.json'), '{not json');
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'record', error: '.claude/fleet-loadouts.json is not JSON' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  it('fails every pin when the token is refused, without calling GitHub', async () => {
    tag('a', '1.0.0', 1);
    tag('b', '1.0.0', 2);
    const s = await syncLoadouts(opts('a@1.0.0 b@1.0.0', { token: () => Promise.reject(new Error('403: not in github.repositories: claude-fleet-loadouts')) }));
    expect(s.failed).toEqual(['a@1.0.0', 'b@1.0.0']);
    expect(failures().map((f) => f.stage)).toEqual(['token', 'token']);
    expect(gh.requests).toEqual([]);
  });

  it('refuses a malformed token without sending it', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0', { token: async () => 'has space' }));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'token', error: 'the credential server returned a malformed token' })]);
    expect(gh.requests).toEqual([]);
  });

  it('stops at the budget and says so', async () => {
    tag('demo', '1.0.0', 1);
    gh.hangTarball = true;
    const t0 = Date.now();
    await syncLoadouts(opts('demo@1.0.0', { budgetMs: 300 }));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'timeout', id: 'demo' })]);
  });

  it('runs scripts in the target and keeps the install when one fails', async () => {
    tag('demo', '1.0.0', 1);
    setLoadoutMd(
      'demo/v1.0.0',
      '---\ntitle: demo\ndescription: d\nversion: 1.0.0\nscripts:\n  - label: hello\n    run: echo hi\n  - label: broken\n    run: exit 3\n---\n'
    );
    const s = await syncLoadouts(
      opts('demo@1.0.0', {
        runScript: async (command, cwd) => {
          scripts.push({ command, cwd });
          return command === 'exit 3' ? { exitCode: 3, output: 'boom' } : { exitCode: 0, output: 'hi\n' };
        }
      })
    );
    expect(scripts).toEqual([
      { command: 'echo hi', cwd: target },
      { command: 'exit 3', cwd: target }
    ]);
    expect(s.installed).toEqual(['demo@1.0.0']);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'loadout script failed', id: 'demo', label: 'broken', exitCode: 3, output: 'boom' })
    );
  });

  it('warns about an unpinned dependency and skips automations', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/automations/nightly/automation.yaml': 'name: nightly\n' });
    setLoadoutMd(
      'demo/v1.0.0',
      '---\ntitle: demo\ndescription: d\nversion: 1.0.0\ndependencies:\n  loadouts:\n    - { id: git-sync, version: "^1.0.0" }\n---\n'
    );
    await syncLoadouts(opts('demo@1.0.0'));
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'loadout dependency not pinned', id: 'demo', dependency: 'git-sync' }));
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: 'loadout automations not installed', id: 'demo' }));
    expect(await exists('automations')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutSync.test.ts`
Expected: FAIL with a missing module error for `./loadoutSync.js`.

- [ ] **Step 3: Implement**

Create `src/host/loadoutSync.ts`:

```ts
// `fleet-host loadouts sync`: make /workspace hold exactly the FLEET_LOADOUTS pins (SPEC §7 Pinned loadouts).
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLoadoutFiles,
  applyLoadoutMerges,
  loadoutFileList,
  parseLoadout,
  revertLoadoutFiles,
  revertLoadoutMerges,
  runLoadoutScripts,
  type LoadoutMeta
} from '../main/loadoutCore.js';
import { isTokenShaped } from '../main/ociCore.js';
import { defaultBranch, downloadTarball, FetchError, resolveTag, type GithubSource } from './loadoutFetch.js';
import { DEFAULT_LOADOUTS_API, parseApiBase, parsePins, parseRepo, pinTag, planSync, type Pin, type RepoRef } from './loadoutPins.js';
import { readRecord, writeRecord, type PinnedRecord, type RecordFile } from './loadoutRecord.js';
import { extractLoadout, TarError } from './loadoutTar.js';
import type { Logger } from './log.js';

export type SyncStage = 'config' | 'record' | 'token' | 'resolve' | 'download' | 'extract' | 'verify' | 'revert' | 'apply' | 'timeout';

export interface ScriptRun {
  exitCode: number;
  output: string;
}

export interface SyncOptions {
  /** FLEET_LOADOUTS, FLEET_LOADOUTS_REPO and FLEET_LOADOUTS_API. */
  env: NodeJS.ProcessEnv;
  target: string;
  log: Logger;
  token(owner: string, repo: string): Promise<string>;
  runScript(command: string, cwd: string, timeoutMs: number): Promise<ScriptRun>;
  budgetMs: number;
  stagingRoot?: string;
}

export interface SyncSummary {
  installed: string[];
  reverted: string[];
  unchanged: string[];
  failed: string[];
}

type Applied = Pick<PinnedRecord, 'files' | 'claudeMd' | 'settingsKeys' | 'mcpServers' | 'hooks'> & { skipped: string[] };

interface Ctx {
  o: SyncOptions;
  src: GithubSource;
  branch: string;
  repoName: string;
  pinned: Set<string>;
  signal: AbortSignal;
  deadline: number;
  out: SyncSummary;
  fail(stage: SyncStage, error: string, pin?: Pin): void;
  commitRecord(id: string, rec: PinnedRecord | null): Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const label = (p: Pin): string => `${p.id}@${p.version}`;
const present = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function stageOf(e: unknown, signal: AbortSignal): SyncStage {
  if (signal.aborted) return 'timeout';
  if (e instanceof FetchError) return e.stage;
  if (e instanceof TarError) return 'extract';
  return 'verify';
}

function toRecord(pin: Pin, repo: string, commit: string, a: Applied): PinnedRecord {
  return {
    id: pin.id,
    version: pin.version,
    repo,
    commit,
    files: a.files,
    claudeMd: a.claudeMd,
    settingsKeys: a.settingsKeys,
    mcpServers: a.mcpServers,
    hooks: a.hooks,
    installedAt: Date.now()
  };
}

async function revertRecord(target: string, r: PinnedRecord): Promise<void> {
  await revertLoadoutFiles(target, { files: r.files, claudeMd: r.claudeMd }, r.id);
  await revertLoadoutMerges(target, { settingsKeys: r.settingsKeys, mcpServers: r.mcpServers, hooks: r.hooks });
}

/** On failure, removes the files this apply added and its CLAUDE.md block, then rethrows. */
async function applyFrom(target: string, dir: string, id: string): Promise<Applied> {
  const planned = await loadoutFileList(dir);
  const before = new Set<string>();
  for (const f of planned) if (await present(join(target, f))) before.add(f);
  try {
    const files = await applyLoadoutFiles(dir, target, id);
    const merges = await applyLoadoutMerges(dir, target);
    return {
      files: files.files,
      claudeMd: files.claudeMd,
      settingsKeys: merges.settingsKeys,
      mcpServers: merges.mcpServers,
      hooks: merges.hooks,
      skipped: [...files.skipped, ...merges.skipped]
    };
  } catch (e) {
    // Per file: one unremovable path (e.g. under a file where a directory should be) mustn't stop the rest.
    for (const f of planned) {
      if (f !== 'CLAUDE.md' && !before.has(f)) await rm(join(target, f), { force: true }).catch(() => undefined);
    }
    if (planned.includes('CLAUDE.md')) await revertLoadoutFiles(target, { files: [], claudeMd: true }, id).catch(() => undefined);
    throw e;
  }
}

async function fetchInto(ctx: Ctx, id: string, commit: string, dir: string): Promise<void> {
  await extractLoadout(await downloadTarball(ctx.src, commit, ctx.signal), id, dir);
}

function dependencyIds(meta: LoadoutMeta): string[] {
  const raw: unknown = meta.dependencies?.loadouts;
  const deps = Array.isArray(raw) ? (raw as unknown[]) : [];
  return deps.flatMap((d) => {
    if (typeof d === 'string') return [d];
    const id = d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

async function notices(ctx: Ctx, id: string, meta: LoadoutMeta, dir: string): Promise<void> {
  for (const dependency of dependencyIds(meta)) {
    if (!ctx.pinned.has(dependency)) ctx.o.log.log('warn', 'loadout dependency not pinned', { id, dependency });
  }
  if (await present(join(dir, 'automations'))) {
    ctx.o.log.log('info', 'loadout automations not installed', { id, reason: 'remote automations come from the host config' });
  }
}

async function runScripts(ctx: Ctx, id: string, dir: string, meta: LoadoutMeta): Promise<void> {
  const results = await runLoadoutScripts(dir, meta.scripts, async (command) => {
    const left = ctx.deadline - Date.now();
    if (left <= 0) return { exitCode: -1, output: 'the sync ran out of time' };
    return ctx.o.runScript(command, ctx.o.target, left);
  });
  for (const r of results) {
    if (r.status === 'failed') {
      ctx.o.log.log('warn', 'loadout script failed', { id, label: r.label, exitCode: r.exitCode, output: (r.output ?? '').slice(-500) });
    } else {
      ctx.o.log.log('info', 'loadout script', { id, label: r.label, status: r.status });
    }
  }
}

async function rollback(ctx: Ctx, previous: PinnedRecord): Promise<void> {
  const dir = await mkdtemp(join(ctx.o.stagingRoot ?? tmpdir(), 'fleet-loadout-'));
  try {
    await fetchInto(ctx, previous.id, previous.commit, dir);
    const back = await applyFrom(ctx.o.target, dir, previous.id);
    await ctx.commitRecord(previous.id, toRecord(previous, previous.repo, previous.commit, back));
    ctx.o.log.log('warn', 'loadout rolled back', { id: previous.id, version: previous.version });
  } catch (e) {
    await ctx.commitRecord(previous.id, null);
    ctx.o.log.log('error', 'loadout rollback failed', { id: previous.id, version: previous.version, error: errText(e) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function installPin(ctx: Ctx, pin: Pin, previous: PinnedRecord | null): Promise<void> {
  const staging = await mkdtemp(join(ctx.o.stagingRoot ?? tmpdir(), 'fleet-loadout-'));
  try {
    let commit: string;
    let meta: LoadoutMeta;
    try {
      commit = await resolveTag(ctx.src, pinTag(pin), ctx.branch, ctx.signal);
      await fetchInto(ctx, pin.id, commit, staging);
      meta = await parseLoadout(staging, pin.id);
    } catch (e) {
      return ctx.fail(stageOf(e, ctx.signal), errText(e), pin);
    }
    if (meta.version !== pin.version) return ctx.fail('verify', `loadout.md version is ${meta.version ?? 'unset'}, not ${pin.version}`, pin);
    if (previous) {
      try {
        await revertRecord(ctx.o.target, previous);
      } catch (e) {
        return ctx.fail('revert', errText(e), pin);
      }
    }
    let applied: Applied;
    try {
      applied = await applyFrom(ctx.o.target, staging, pin.id);
    } catch (e) {
      ctx.fail('apply', errText(e), pin);
      if (previous) await rollback(ctx, previous);
      return;
    }
    await ctx.commitRecord(pin.id, toRecord(pin, ctx.repoName, commit, applied));
    ctx.out.installed.push(label(pin));
    ctx.o.log.log('info', 'loadout installed', { id: pin.id, version: pin.version, commit, files: applied.files.length, skipped: applied.skipped });
    await notices(ctx, pin.id, meta, staging);
    await runScripts(ctx, pin.id, staging, meta);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('timed out'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      }
    );
  });
}

export async function syncLoadouts(o: SyncOptions): Promise<SyncSummary> {
  const started = Date.now();
  const deadline = started + o.budgetMs;
  const out: SyncSummary = { installed: [], reverted: [], unchanged: [], failed: [] };
  const fail = (stage: SyncStage, error: string, pin?: Pin): void => {
    if (pin) out.failed.push(label(pin));
    o.log.log('error', 'loadout sync failed', { stage, ...(pin ? { id: pin.id, version: pin.version } : {}), error });
  };
  const finish = (): SyncSummary => {
    o.log.log('info', 'loadout sync done', { ...out, ms: Date.now() - started });
    return out;
  };

  let pins: Pin[];
  let repo: RepoRef;
  let api: string;
  try {
    pins = parsePins(o.env.FLEET_LOADOUTS);
    repo = parseRepo(o.env.FLEET_LOADOUTS_REPO);
    api = parseApiBase(o.env.FLEET_LOADOUTS_API);
  } catch (e) {
    fail('config', errText(e));
    return finish();
  }
  let record: RecordFile;
  try {
    record = await readRecord(o.target);
  } catch (e) {
    fail('record', errText(e));
    return finish();
  }
  if (api !== DEFAULT_LOADOUTS_API) o.log.log('warn', 'loadout sync uses a non-default API', { api });

  const commitRecord = async (id: string, rec: PinnedRecord | null): Promise<void> => {
    record = { version: 1, loadouts: [...record.loadouts.filter((x) => x.id !== id), ...(rec ? [rec] : [])] };
    try {
      await writeRecord(o.target, record);
    } catch (e) {
      o.log.log('error', 'loadout sync failed', { stage: 'record', id, error: errText(e) });
    }
  };

  const plan = planSync(pins, repo, record.loadouts);
  for (const r of plan.unchanged) out.unchanged.push(label(r));
  for (const r of plan.revert) {
    try {
      await revertRecord(o.target, r);
    } catch (e) {
      fail('revert', errText(e), r);
      continue;
    }
    await commitRecord(r.id, null);
    out.reverted.push(label(r));
    o.log.log('info', 'loadout reverted', { id: r.id, version: r.version });
  }
  if (plan.install.length === 0) return finish();

  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let src: GithubSource;
  let branch: string;
  try {
    const token = await untilAborted(o.token(repo.owner, repo.repo), signal);
    if (!isTokenShaped(token)) throw new Error('the credential server returned a malformed token');
    src = { api, owner: repo.owner, repo: repo.repo, token };
    branch = await defaultBranch(src, signal);
  } catch (e) {
    const stage: SyncStage = signal.aborted ? 'timeout' : e instanceof FetchError ? e.stage : 'token';
    for (const { pin } of plan.install) fail(stage, errText(e), pin);
    return finish();
  }
  const ctx: Ctx = {
    o,
    src,
    branch,
    repoName: `${repo.owner}/${repo.repo}`,
    pinned: new Set(pins.map((p) => p.id)),
    signal,
    deadline,
    out,
    fail,
    commitRecord
  };
  for (const { pin, previous } of plan.install) {
    if (signal.aborted) fail('timeout', 'the sync ran out of time', pin);
    else await installPin(ctx, pin, previous);
  }
  return finish();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutSync.test.ts src/host/loadoutFetch.test.ts src/host/loadoutTar.test.ts src/host/loadoutRecord.test.ts src/host/loadoutPins.test.ts src/main/loadoutCore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/loadoutSync.ts src/host/loadoutSync.test.ts
git commit -m "feat(host): pinned-loadout sync with keep-previous and rollback"
```

---

### Task 6: `fleet-host loadouts sync` and the host bundle's inputs

**Files:**
- Create: `src/host/loadoutsCli.ts`
- Modify: `src/host/cli.ts` (header comment; a `loadouts` branch after the `embed-check` branch)
- Modify: `src/host/importGraph.test.ts:15-25` (`MAIN_ALLOWED`)
- Modify: `.dockerignore` (opt in two `src/main` files; exclude two test helpers)
- Modify: `.github/workflows/publish-runner.yml` and `.github/workflows/test-runner-images.yml` (path filters)
- Test: `src/host/loadoutsCli.test.ts`

**Interfaces:**
- Consumes: `syncLoadouts`, `ScriptRun` (Task 5); `parseTimeoutS`, `DEFAULT_SYNC_TIMEOUT_S` (Task 1); `requestToken(endpoint: CredEndpoint, body: unknown): Promise<string>` and `CredEndpoint` (`credCli.ts`); `DEFAULT_CRED_SOCKET` (`credServer.ts`); `parseHostPort` (`endpoint.ts`); `createLogger`, `Logger` (`log.ts`).
- Produces: `SYNC_TARGET = '/workspace'`; `runScript(command: string, cwd: string, timeoutMs: number): Promise<ScriptRun>`; `loadoutsCli(argv: string[], env: NodeJS.ProcessEnv, target?: string, log?: Logger): Promise<number>` (0, or 2 on usage).

- [ ] **Step 1: Write the failing test**

Create `src/host/loadoutsCli.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadoutsCli, runScript } from './loadoutsCli.js';
import { createLogger } from './log.js';
import { loadoutFiles, sha, startFakeGithubRepo, type FakeGithubRepo } from './testGithubRepo.js';

let gh: FakeGithubRepo;
let target: string;
let cred: Server;
let credPort: number;
let bodies: unknown[];

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  target = await mkdtemp(join(tmpdir(), 'lcli-'));
  bodies = [];
  cred = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: gh.token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    });
  });
  await new Promise<void>((r) => cred.listen(0, '127.0.0.1', () => r()));
  credPort = (cred.address() as AddressInfo).port;
});
afterEach(async () => {
  await gh.close();
  await new Promise<void>((r) => cred.close(() => r()));
  await rm(target, { recursive: true, force: true });
});

describe('loadoutsCli', () => {
  it('syncs with a contents:read token from the credential server', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const out: string[] = [];
    const env = { FLEET_LOADOUTS: 'demo@1.0.0', FLEET_LOADOUTS_API: gh.url, FLEET_HOST_CRED_ADDR: `127.0.0.1:${credPort}` };
    expect(await loadoutsCli(['sync'], env, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(bodies).toEqual([{ owner: 'SumerSports', repositories: ['claude-fleet-loadouts'], permissions: { contents: 'read' } }]);
    expect(await readFile(join(target, '.claude/skills/demo/SKILL.md'), 'utf8')).toContain('demo 1.0.0');
    expect(out.join('\n')).not.toContain(gh.token);
    expect(out.join('\n')).toContain('"msg":"loadout sync done"');
  });

  it('logs a bad credential address as a token failure and exits 0', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const out: string[] = [];
    const env = { FLEET_LOADOUTS: 'demo@1.0.0', FLEET_LOADOUTS_API: gh.url, FLEET_HOST_CRED_ADDR: 'not-an-address' };
    expect(await loadoutsCli(['sync'], env, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(out.join('\n')).toContain('"stage":"token"');
  });

  it('ignores a bad timeout with a warning', async () => {
    const out: string[] = [];
    expect(await loadoutsCli(['sync'], { FLEET_LOADOUTS_TIMEOUT_S: '0' }, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(out.join('\n')).toContain('"msg":"loadout sync timeout ignored"');
  });

  it('exits 2 on usage errors', async () => {
    const quiet = createLogger(() => undefined);
    expect(await loadoutsCli([], {}, target, quiet)).toBe(2);
    expect(await loadoutsCli(['sync', 'extra'], {}, target, quiet)).toBe(2);
    expect(await loadoutsCli(['bogus'], {}, target, quiet)).toBe(2);
  });
});

describe('runScript', () => {
  it('runs sh -lc in the target and reports the exit code and output', async () => {
    const r = await runScript('pwd -P; exit 3', target, 5_000);
    expect(r.exitCode).toBe(3);
    expect(r.output.trim()).toBe(await realpath(target));
  });

  it('kills a script that outlives its time', async () => {
    const t0 = Date.now();
    const r = await runScript('sleep 5', target, 200);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/host/loadoutsCli.test.ts`
Expected: FAIL with a missing module error for `./loadoutsCli.js`.

- [ ] **Step 3: Implement the CLI**

Create `src/host/loadoutsCli.ts`:

```ts
// `fleet-host loadouts sync`, run by `fleet-host-entry workspace` as uid 1000 before the broker (SPEC §4 Supervision).
import { spawn } from 'node:child_process';
import { requestToken, type CredEndpoint } from './credCli.js';
import { DEFAULT_CRED_SOCKET } from './credServer.js';
import { parseHostPort } from './endpoint.js';
import { DEFAULT_SYNC_TIMEOUT_S, parseTimeoutS } from './loadoutPins.js';
import { syncLoadouts, type ScriptRun } from './loadoutSync.js';
import { createLogger, type Logger } from './log.js';

export const SYNC_TARGET = '/workspace';
const SCRIPT_OUTPUT_MAX = 64 * 1024;
/** fleet-host-entry's `timeout` fires at the cap; stopping this much earlier leaves time to log. */
const EXIT_MARGIN_MS = 5_000;

export function runScript(command: string, cwd: string, timeoutMs: number): Promise<ScriptRun> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn('sh', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, Math.max(1, timeoutMs));
    const settle = (r: ScriptRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const take = (c: Buffer): void => {
      if (output.length < SCRIPT_OUTPUT_MAX) output += c.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => settle({ exitCode: -1, output: e.message }));
    child.on('close', (code, signal) => settle({ exitCode: code ?? (signal ? 128 : -1), output }));
  });
}

export async function loadoutsCli(argv: string[], env: NodeJS.ProcessEnv, target = SYNC_TARGET, log: Logger = createLogger()): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'sync') {
    log.log('error', 'usage: fleet-host loadouts sync');
    return 2;
  }
  let timeoutS = DEFAULT_SYNC_TIMEOUT_S;
  try {
    timeoutS = parseTimeoutS(env.FLEET_LOADOUTS_TIMEOUT_S);
  } catch (e) {
    log.log('warn', 'loadout sync timeout ignored', { error: (e as Error).message, timeoutS });
  }
  const addr = env.FLEET_HOST_CRED_ADDR;
  const endpoint: CredEndpoint | null = addr ? parseHostPort(addr) : env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;
  await syncLoadouts({
    env,
    target,
    log,
    budgetMs: Math.max(1_000, timeoutS * 1000 - EXIT_MARGIN_MS),
    token: (owner, repo) =>
      endpoint
        ? requestToken(endpoint, { owner, repositories: [repo], permissions: { contents: 'read' } })
        : Promise.reject(new Error('FLEET_HOST_CRED_ADDR is not host:port')),
    runScript
  });
  return 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/host/loadoutsCli.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the subcommand and watch the import-graph test fail**

In `src/host/cli.ts`, replace the first two header lines with:

```ts
// Bundle entry: the host, or a one-shot `init` (resolve or mint the workspace id), `bootstrap` or `migrate` (dbCli.ts),
// `write-mcp-bridge <path>` or `embed-check [reference]` (image build), or `loadouts sync` (workspace pod start).
```

and after the `if (argv[0] === 'embed-check') { … }` block add:

```ts
  if (argv[0] === 'loadouts') {
    const { loadoutsCli } = await import('./loadoutsCli.js');
    const code = await loadoutsCli(argv.slice(1), process.env);
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    process.exit(code);
  }
```

Run: `npx vitest run src/host/importGraph.test.ts`
Expected: FAIL. `reaches only pure src/main modules` lists `main/loadoutCore.ts` and `main/ociCore.ts`, and the build-inputs tests list `src/main/loadoutCore.ts` and `src/main/ociCore.ts`.

- [ ] **Step 6: Admit the two modules to the host bundle**

In `src/host/importGraph.test.ts`, in `MAIN_ALLOWED`, after the line `/^main\/mcpContainerBridge\.ts$/, /^main\/remoteUrl\.ts$/,` add:

```ts
  /^main\/(loadoutCore|ociCore)\.ts$/,
```

In `.dockerignore`, after `!src/main/publish/scrub.ts` add:

```
!src/main/loadoutCore.ts
!src/main/ociCore.ts
```

and after `src/host/testAutomationRuntime.ts` add:

```
src/host/testGithubRepo.ts
src/host/testTar.ts
```

In `.github/workflows/publish-runner.yml` (`on.push.paths`) and `.github/workflows/test-runner-images.yml` (`on.pull_request.paths`), after `      - 'src/main/publish/scrub.ts'` add:

```yaml
      - 'src/main/loadoutCore.ts'
      - 'src/main/ociCore.ts'
```

- [ ] **Step 7: Run the host suite, typecheck and build the bundle**

Run: `npx vitest run src/host/ src/main/loadoutCore.test.ts src/main/ociCore.test.ts src/main/ociClient.test.ts`
Expected: PASS (including `importGraph.test.ts`).

Run: `npx tsc -p tsconfig.host.json && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no errors.

Run: `npx vite build --config vite.host.config.ts && node out/host/fleet-host.mjs loadouts bogus; echo rc=$?`
Expected: an `{"level":"error","msg":"usage: fleet-host loadouts sync"…}` line, then `rc=2`.

- [ ] **Step 8: Commit**

```bash
git add src/host/loadoutsCli.ts src/host/loadoutsCli.test.ts src/host/cli.ts src/host/importGraph.test.ts .dockerignore .github/workflows/publish-runner.yml .github/workflows/test-runner-images.yml
git commit -m "feat(host): fleet-host loadouts sync"
```

---

### Task 7: The entry script runs the sync before the broker

**Files:**
- Modify: `docker/host/fleet-host-entry` (header comment, `sync_loadouts`, `run_workspace`)
- Test: `docker/host/fleet-host-entry.test.sh`

**Interfaces:**
- Consumes: `fleet-host loadouts sync` (Task 6) through `node "$host_js" loadouts sync`.
- Produces: env `FLEET_LOADOUTS_TIMEOUT_S` (1–600, default 60) and `FLEET_LOADOUTS_RECORD` (default `/workspace/.claude/fleet-loadouts.json`); log lines `loadout sync timed out; starting the broker` and `loadout sync exited; starting the broker`.

- [ ] **Step 1: Teach the fake fleet-host the sync, and isolate the env**

In `docker/host/fleet-host-entry.test.sh`, in the `host.mjs` heredoc, after the line `const note = (s) => appendFileSync(ev, s + '\n');` add:

```js
if (process.argv[2] === 'loadouts') {
  note(`sync ${process.argv.slice(3).join(' ')} [${process.env.FLEET_LOADOUTS ?? ''}]`);
  if (!process.env.FAKE_SYNC_HANG) process.exit(Number(process.env.FAKE_SYNC_EXIT ?? 0));
  await new Promise(() => setInterval(() => undefined, 1000));
}
```

In `run()`, add `-u FLEET_LOADOUTS -u FLEET_LOADOUTS_TIMEOUT_S -u FLEET_LOADOUTS_RECORD` to the `env -u …` list, and `FLEET_LOADOUTS_RECORD="$dir/record.json"` immediately before `"$@"`.

- [ ] **Step 2: Write the failing cases**

Insert before the final `[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1` line:

```bash
# 32. workspace syncs the pinned loadouts before it execs the broker.
run wsload workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 FLEET_LOADOUTS='demo@1.0.0'
until_count broker-start 1
assert "$(head -1 "$dir/events")" "sync sync [demo@1.0.0]" "workspace runs the sync first"
assert "$(head -1 "$dir/pids")" "$pid" "workspace still execs the broker after the sync"
kill -TERM "$pid"; finish

# 33. Nothing pinned and nothing recorded: no sync, no node.
run wsnoload workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1
until_count broker-start 1
assert "$(grep -c '^sync ' "$dir/events")" "0" "no sync without pins or a record"
kill -TERM "$pid"; finish

# 34. Nothing pinned but a record exists: the sync runs so it can revert.
mkdir -p "$tmp/case-wsrevert" && : > "$tmp/case-wsrevert/record.json"
run wsrevert workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1
until_count broker-start 1
assert "$(grep -c '^sync sync \[\]$' "$dir/events")" "1" "a record alone runs the sync"
kill -TERM "$pid"; finish

# 35. A hung sync is cut at FLEET_LOADOUTS_TIMEOUT_S and the broker starts anyway.
run wshang workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 FLEET_LOADOUTS='demo@1.0.0' FLEET_LOADOUTS_TIMEOUT_S=1 FAKE_SYNC_HANG=1
until_count broker-start 1
assert "$(head -1 "$dir/pids")" "$pid" "workspace execs the broker after a hung sync"
grep -q 'loadout sync timed out; starting the broker' "$dir/log"; assert "$?" "0" "sync timeout logged"
kill -TERM "$pid"; finish

# 36. A failing sync is logged and the broker starts.
run wssyncfail workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 FLEET_LOADOUTS='demo@1.0.0' FAKE_SYNC_EXIT=3
until_count broker-start 1
grep -q 'loadout sync exited; starting the broker' "$dir/log"; assert "$?" "0" "sync failure logged"
kill -TERM "$pid"; finish
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bash docker/host/fleet-host-entry.test.sh`
Expected: `FAIL: workspace runs the sync first`, `FAIL: a record alone runs the sync`, `FAIL: sync timeout logged`, `FAIL: sync failure logged`; the other cases still `ok`.

- [ ] **Step 4: Implement**

In `docker/host/fleet-host-entry`, change the header's `workspace` line to:

```bash
#   workspace  the broker and its sessions (workspace pod, uid 1000): pinned loadouts first, then broker :7070, readiness :7071, drain on preStop/SIGTERM
```

After `workspace_uid=${FLEET_WORKSPACE_UID:-1000}` add:

```bash
loadouts_record=${FLEET_LOADOUTS_RECORD:-/workspace/.claude/fleet-loadouts.json}
```

Before `run_workspace() {` add:

```bash
# Pinned loadouts land before any session exists; a recorded install is reverted even with nothing pinned (D163, D164).
sync_loadouts() {
  [ -n "${FLEET_LOADOUTS:-}" ] || [ -e "$loadouts_record" ] || return 0
  local t=${FLEET_LOADOUTS_TIMEOUT_S:-60} status=0
  case "$t" in ''|*[!0-9]*|????*) t=60 ;; esac
  t=$(( 10#$t ))
  (( t >= 1 && t <= 600 )) || t=60
  timeout -k 5 "$t" node "$host_js" loadouts sync || status=$?
  if (( status == 124 || status == 137 )); then
    log warn "loadout sync timed out; starting the broker" ",\"timeoutS\":$t"
  elif (( status != 0 )); then
    log warn "loadout sync exited; starting the broker" ",\"status\":$status"
  fi
}
```

In `run_workspace`, replace the final `exec "$broker_bin"` with:

```bash
  sync_loadouts
  exec "$broker_bin"
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bash docker/host/fleet-host-entry.test.sh`
Expected: every line `ok: …`, then `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add docker/host/fleet-host-entry docker/host/fleet-host-entry.test.sh
git commit -m "feat(host): fleet-host-entry workspace syncs pinned loadouts before the broker"
```

---

### Task 8: Image tests with a fake GitHub endpoint

**Files:**
- Create: `docker/host/testdata/fake-github.mjs`
- Modify: `docker/host/split.test.sh`
- Modify: `docker/host/smoke.test.sh`

**Interfaces:**
- Consumes: the runner-host image built from Tasks 1–7 (`fleet-host-entry workspace`, `fleet-host loadouts sync`).
- Produces: CI coverage in `test-runner-images.yml` (it already runs both scripts).

- [ ] **Step 1: Write the fake**

Create `docker/host/testdata/fake-github.mjs`:

```js
// Split test only: a fake fleet-host credential server (:8081) and GitHub REST API (:8090) serving
// `git archive` tarballs of a real repo built at start. FAKE_FAIL_TAGS: tags whose tarball answers 500.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const TOKEN = `ghs_${'f'.repeat(36)}`;
const repo = '/tmp/fake-loadouts';
const base = '/repos/SumerSports/claude-fleet-loadouts';
const fail = new Set((process.env.FAKE_FAIL_TAGS ?? '').split(',').filter(Boolean));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@example.com' };
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
const gitText = (...args) => git(...args).toString('utf8').trim();
const put = (path, text) => {
  mkdirSync(`${repo}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
  writeFileSync(`${repo}/${path}`, text);
};
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const log = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
for (const v of ['1.0.0', '2.0.0']) {
  put('loadouts/demo/loadout.md', `---\ntitle: Demo\ndescription: split test loadout\nversion: ${v}\n---\nDemo.\n`);
  put('loadouts/demo/skills/demo/SKILL.md', `---\nname: demo\ndescription: demo ${v}\n---\nDemo skill ${v}.\n`);
  git('add', '-A');
  git('commit', '-qm', `demo ${v}`);
  git('tag', `demo/v${v}`);
}
const main = gitText('rev-parse', 'main');

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log({ token_request: JSON.parse(body || '{}') });
    json(res, 200, { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
}).listen(8081, '0.0.0.0');

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fake').pathname;
  log({ method: req.method, path, auth: Boolean(req.headers.authorization) });
  if (path.startsWith('/codeload/')) {
    if (req.headers.authorization) return json(res, 400, { message: 'Authorization sent to codeload' });
    const commit = path.slice('/codeload/'.length);
    if (!/^[0-9a-f]{40}$/.test(commit)) return json(res, 404, { message: 'Not Found' });
    const tgz = git('archive', '--format=tar.gz', `--prefix=SumerSports-claude-fleet-loadouts-${commit.slice(0, 7)}/`, commit);
    res.writeHead(200, { 'content-type': 'application/x-gzip' });
    return res.end(tgz);
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: 'Bad credentials' });
  if (path === base) return json(res, 200, { default_branch: 'main' });
  if (path.startsWith(`${base}/git/ref/tags/`)) {
    const tag = decodeURIComponent(path.slice(`${base}/git/ref/tags/`.length));
    try {
      return json(res, 200, { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: gitText('rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`) } });
    } catch {
      return json(res, 404, { message: 'Not Found' });
    }
  }
  const cmp = new RegExp(`^${base}/compare/([0-9a-f]{40})\\.\\.\\.main$`).exec(path);
  if (cmp) {
    try {
      git('merge-base', '--is-ancestor', cmp[1], 'main');
      return json(res, 200, { status: cmp[1] === main ? 'identical' : 'ahead' });
    } catch {
      return json(res, 200, { status: 'diverged' });
    }
  }
  const tb = new RegExp(`^${base}/tarball/([0-9a-f]{40})$`).exec(path);
  if (tb) {
    if (gitText('tag', '--points-at', tb[1]).split('\n').some((t) => fail.has(t))) return json(res, 500, { message: 'Server Error' });
    return json(res, 302, {}, { location: `http://${req.headers.host}/codeload/${tb[1]}` });
  }
  json(res, 404, { message: 'Not Found' });
}).listen(8090, '0.0.0.0');
log({ ready: true });
```

Run: `node --check docker/host/testdata/fake-github.mjs`
Expected: no output, exit 0.

- [ ] **Step 2: Add the split-test cases**

In `docker/host/split.test.sh`:

1. After `image=$1` add `here=$(cd "$(dirname "$0")" && pwd)`.
2. In `cleanup()`, after `docker network rm "$n" >/dev/null 2>&1 || true` add `docker volume rm "$n-ws-data" >/dev/null 2>&1 || true`.
3. Before the `# The sidecar-less workspace pod gives up after 60 s and exits 1.` block, insert:

```bash
# Pinned loadouts (D159–D166): a fake credential server + GitHub API; the sync runs before the broker listens.
ready_get_js="require('http').get('http://127.0.0.1:7071/ready',(s)=>{let b='';s.on('data',(d)=>b+=d);s.on('end',()=>console.log(s.statusCode+' '+b.trim()))}).on('error',(e)=>console.log(e.code))"
docker volume create "$n-ws-data" >/dev/null
docker run --rm -u 0 -v "$n-ws-data:/workspace" --entrypoint chown "$image" 1000:1000 /workspace || fail "chown the workspace volume"
ids+=("$(docker run -d --name "$n-gh" --network "$n" --network-alias gh-fake -u 1000:1000 -e FAKE_FAIL_TAGS=demo/v2.0.0 \
  -v "$here/testdata:/fake:ro" --entrypoint node "$image" /fake/fake-github.mjs)")
retry sh -c "docker logs '$n-gh' 2>/dev/null | grep -q '\"ready\":true'" || fail "fake GitHub never started"
# loadouts_pod <name> <FLEET_LOADOUTS>: a workspace pod on the shared /workspace volume, pointed at the fake.
loadouts_pod() {
  ids+=("$(docker run -d --name "$n-$1net" --network "$n" --entrypoint node "$image" -e "$ready_js")")
  ids+=("$(docker run -d --name "$n-$1" --network "container:$n-$1net" -u 1000:1000 -v "$n-ws-data:/workspace" \
    -e FLEET_HOST_CRED_ADDR=gh-fake:8081 -e FLEET_LOADOUTS_API=http://gh-fake:8090 -e "FLEET_LOADOUTS=$2" -e CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat \
    "$image" fleet-host-entry workspace)")
  until_eq "200 serving" docker exec "$n-$1" node -e "$ready_get_js" || fail "$1: broker never served"
}

loadouts_pod ld1 demo@1.0.0
grep -q 'Demo skill 1.0.0' <<<"$(docker exec "$n-ld1" cat /workspace/.claude/skills/demo/SKILL.md)" || fail "pinned loadout not installed"
grep -q '"version": "1.0.0"' <<<"$(docker exec "$n-ld1" cat /workspace/.claude/fleet-loadouts.json)" || fail "install not recorded"
ld1_logs=$(docker logs "$n-ld1" 2>&1)
sync_at=$(grep -n '"msg":"loadout sync done"' <<<"$ld1_logs" | head -1 | cut -d: -f1)
listen_at=$(grep -n 'listening on' <<<"$ld1_logs" | head -1 | cut -d: -f1)
[ -n "$sync_at" ] && [ -n "$listen_at" ] && (( sync_at < listen_at )) || fail "the sync did not finish before the broker listened"
gh_logs=$(docker logs "$n-gh" 2>&1)
grep -q '"token_request":{"owner":"SumerSports","repositories":\["claude-fleet-loadouts"\],"permissions":{"contents":"read"}}' <<<"$gh_logs" \
  || fail "token request is not contents: read on the loadouts repo"
grep -q '"path":"/codeload/[0-9a-f]*","auth":false' <<<"$gh_logs" || fail "codeload request carried a token"
docker stop -t 15 "$n-ld1" >/dev/null || fail "stop ld1"

# A failed download keeps the installed version and the broker still serves.
loadouts_pod ld2 demo@2.0.0
grep -q '"msg":"loadout sync failed".*"stage":"download"' <<<"$(docker logs "$n-ld2" 2>&1)" || fail "failed download not logged"
grep -q 'Demo skill 1.0.0' <<<"$(docker exec "$n-ld2" cat /workspace/.claude/skills/demo/SKILL.md)" || fail "previous version not kept"
docker stop -t 15 "$n-ld2" >/dev/null || fail "stop ld2"

# Nothing pinned: the recorded loadout is reverted.
loadouts_pod ld3 ''
docker exec "$n-ld3" test ! -e /workspace/.claude/skills/demo/SKILL.md || fail "unpinned loadout not reverted"
grep -q '"msg":"loadout reverted"' <<<"$(docker logs "$n-ld3" 2>&1)" || fail "revert not logged"
docker stop -t 15 "$n-ld3" >/dev/null || fail "stop ld3"
```

- [ ] **Step 3: Add the smoke checks**

In `docker/host/smoke.test.sh`, after the `fleet-host migrate without db` line add:

```bash
# Nothing pinned and nothing recorded: the sync is a logged no-op; a bad subcommand is a usage error.
grep -q '"msg":"loadout sync done"' <<<"$(docker exec "$cid" fleet-host loadouts sync)" || fail "fleet-host loadouts sync with nothing pinned"
test "$(docker exec "$cid" sh -c 'fleet-host loadouts bogus >/dev/null 2>&1; echo rc=$?')" = rc=2 || fail "fleet-host loadouts bogus is not rc 2"
```

Update the smoke script's header comment's first line to end with `, the pinned-loadout sync's no-op and usage exit`.

- [ ] **Step 4: Check the scripts parse**

Run: `bash -n docker/host/split.test.sh && bash -n docker/host/smoke.test.sh && node --check docker/host/testdata/fake-github.mjs && echo ok`
Expected: `ok`. (Docker runs only in CI: `test-runner-images.yml` builds `runner-host` and runs both scripts.)

- [ ] **Step 5: Commit**

```bash
git add docker/host/testdata/fake-github.mjs docker/host/split.test.sh docker/host/smoke.test.sh
git commit -m "test(host): pinned loadouts in the image smoke and two-pod split tests"
```

---

### Task 9: SPEC.md and the full gate

**Files:**
- Modify: `docs/SPEC.md` (§4 *Host images*, §7 *Private sources (#444)*, §7 *Remote host*, §9, §10, §11)

**Interfaces:**
- Consumes: everything above.
- Produces: the spec text that describes it.

- [ ] **Step 1: §7 *Private sources (#444)***

Replace

```markdown
There is no headless pin mechanism yet (`FLEET_LOADOUTS` isn't implemented). The env steps are its hook. `pullIndex`
```

with

```markdown
Remote workspaces pin loadouts from a git repo instead (§7 *Remote host*, *Pinned loadouts*); `FLEET_LOADOUT_TOKEN*` play no part there. `pullIndex`
```

- [ ] **Step 2: §4 *Host images***

1. Replace `` `/usr/local/bin/fleet-host` wraps it (`fleet-host init`, `bootstrap`, `migrate`); `` with `` `/usr/local/bin/fleet-host` wraps it (`fleet-host init`, `bootstrap`, `migrate`, `loadouts sync`); ``.
2. In the `workspace` supervision bullet, replace

```markdown
exports `CLAUDE_FLEET_BROKER_DRAIN=1` (the control socket, the readiness listener on `CLAUDE_FLEET_BROKER_READY_PORT` and SIGTERM drain, §7 *Workspace pod drain*), and `exec`s the broker.
```

with

```markdown
exports `CLAUDE_FLEET_BROKER_DRAIN=1` (the control socket, the readiness listener on `CLAUDE_FLEET_BROKER_READY_PORT` and SIGTERM drain, §7 *Workspace pod drain*), runs the pinned-loadout sync (§7 *Remote host*, *Pinned loadouts*) when `FLEET_LOADOUTS` is non-empty or `FLEET_LOADOUTS_RECORD` (default `/workspace/.claude/fleet-loadouts.json`) exists, as `timeout -k 5 <FLEET_LOADOUTS_TIMEOUT_S> node fleet-host.mjs loadouts sync` (1–600, default 60; an invalid value is 60), logs a timeout (124/137: `loadout sync timed out; starting the broker`) or another non-zero exit (`loadout sync exited; starting the broker`), and `exec`s the broker whatever the sync did.
```

3. In the image-tests paragraph, replace

```markdown
a clean SIGTERM) gates both publishes on amd64
```

with

```markdown
a clean SIGTERM, and `fleet-host loadouts sync` with nothing pinned exiting 0 and `fleet-host loadouts bogus` exiting 2) gates both publishes on amd64
```

and directly after the sentence ending

```markdown
and a workspace container with no responder never listens (checked in `/proc/net/tcp` and `tcp6`) and exits 1.
```

add:

```markdown
 Workspace containers with `FLEET_LOADOUTS` against `docker/host/testdata/fake-github.mjs` (a fake credential server and GitHub API serving `git archive` tarballs from a real repo) install the pinned loadout before the broker listens (asking for `contents: read` and sending no token to codeload), keep it when the next version's tarball fails, and revert it when the pins are emptied.
```

- [ ] **Step 3: §7 *Remote host* — env contract**

In the workspace-pod table, after the `CLAUDE_FLEET_BROKER_READY_PORT` row add:

```markdown
| `FLEET_LOADOUTS` | unset | pinned loadouts, `id@version` separated by whitespace or commas (*Pinned loadouts*) |
| `FLEET_LOADOUTS_REPO` | `SumerSports/claude-fleet-loadouts` | `owner/repo` the pins come from |
| `FLEET_LOADOUTS_API` | `https://api.github.com` | GitHub REST API base (http(s), no credentials, query or fragment; a non-default value logs `warn`) |
| `FLEET_LOADOUTS_TIMEOUT_S` | `60` | the sync's cap, 1–600 |
| `FLEET_LOADOUTS_RECORD` | `/workspace/.claude/fleet-loadouts.json` | the record `fleet-host-entry` checks for (tests only) |
```

- [ ] **Step 4: §7 *Remote host* — GitHub App credentials and the new subsection**

In *GitHub App credentials*, after the bullet that starts with `` - **`fleet-host-cred`** (the second bundle entry) `` add:

```markdown
- **The pinned-loadout sync** (*Pinned loadouts*) is a third client: once per sync that has something to fetch, it posts `{owner, repositories: [<loadouts repo>], permissions: {contents: "read"}}` to `FLEET_HOST_CRED_ADDR` (else the socket), so the host config's `github.repositories` (when set) must list the loadouts repo.
```

Before `**Routes.**` insert:

```markdown
**Pinned loadouts** (D159–D167; design `superpowers/specs/2026-11-20-remote-pinned-loadouts-design.md`). `fleet-host loadouts sync` (`loadoutsCli.ts`, `loadoutSync.ts`), run by `fleet-host-entry workspace` as uid 1000 before the broker (§4 *Supervision*), makes `/workspace` hold exactly the loadouts pinned in `FLEET_LOADOUTS`, installed as the desktop installs a container loadout (`loadoutCore.ts`: drop files, the `CLAUDE.md` block, the `settings.json`/`.mcp.json`/hooks merges, `scripts:`).
- **Source** (D159, D160): the git repo `FLEET_LOADOUTS_REPO` through the GitHub REST API at `FLEET_LOADOUTS_API`, not GHCR (GHCR accepts only classic PATs, and installation tokens get no `packages` scope). One installation token per sync from the credential server, `contents: read` on that repo, requested only when a pin must be fetched; it stays in memory and is never logged, written or given to scripts.
- **Resolve** (D161): pin `id@version` → tag `<id>/v<version>` → `git/ref/tags/…` (an annotated tag is dereferenced through `git/tags/{sha}`) → the commit must be on the default branch (`compare/{commit}...{default_branch}` answers `ahead` or `identical`) → `tarball/{commit}`, whose redirect is followed once, manually, without `Authorization`, to an `https:` URL or the API's own origin. `loadout.md`'s `version` must equal the pin. The loadouts repo's publish workflow creates the tags (`scripts/tag-loadouts.sh`: idempotent; fails on an existing tag with a different tree; `--backfill`).
- **Pins** (D162): `id` `^[a-z0-9][a-z0-9-]{0,62}$`, `version` `MAJOR.MINOR.PATCH[-prerelease]`, each id once. A malformed `FLEET_LOADOUTS`, `FLEET_LOADOUTS_REPO` or `FLEET_LOADOUTS_API` changes nothing (`stage: "config"`); an empty `FLEET_LOADOUTS` reverts everything recorded.
- **Reconcile** (D163): against `/workspace/.claude/fleet-loadouts.json` (`{version: 1, loadouts: [{id, version, repo, commit, files, claudeMd, settingsKeys, mcpServers, hooks, installedAt}]}`, written atomically, paths confined to `/workspace`): same id, version and repo → skipped (no token, no GitHub call); otherwise fetched, extracted and verified in staging, the previous version reverted, the new one applied and recorded, then its `scripts:` run with `sh -lc` in `/workspace` within the remaining budget; recorded but unpinned → reverted. `dependencies.loadouts` aren't resolved (`loadout dependency not pinned`, `warn`); `automations/` aren't installed (`loadout automations not installed`, `info`; remote automations come from the host config, D125). Scripts run only when a version is applied.
- **Failure** (D165): the pod is never blocked; the sync exits 0 except on a usage error (2). A fetch, extract or verify failure leaves the previous version installed. A failed apply removes what it added and rolls back by refetching the previous version's recorded commit (`loadout rolled back`; else `loadout rollback failed` and the entry is dropped). An unreadable record changes nothing. One `AbortSignal` with the budget (`FLEET_LOADOUTS_TIMEOUT_S` − 5 s, at least 1 s) covers the token and every request; scripts are killed (process group) at the deadline. A failing script logs `loadout script failed` and the install stands.
- **Extraction** (D166, `loadoutTar.ts`): only `<root>/loadouts/<id>/` of a `git archive` tarball; one top-level directory; pax `x` paths honoured, `g` skipped, GNU `L`/`K` and base-256 refused, checksums verified; in scope only regular files and directories (a symlink, hardlink or other type fails the loadout); every path through `safeLayerPath`, no duplicates; caps 25 MiB tarball, 100 MiB archive, `MAX_BLOB_BYTES` (5 MiB) per file, 20 MiB and 1000 files per loadout; modes 0644 or 0755; nothing is written until the whole archive passed.
- **Logs**: `loadout sync failed` `{stage, id?, version?, error}` (`stage` ∈ `config`, `record`, `token`, `resolve`, `download`, `extract`, `verify`, `revert`, `apply`, `timeout`), `loadout installed` `{id, version, commit, files, skipped}`, `loadout reverted`, `loadout rolled back`, `loadout rollback failed`, `loadout script`, `loadout script failed`, `loadout dependency not pinned`, `loadout automations not installed`, `loadout sync uses a non-default API`, `loadout sync done` `{installed, reverted, unchanged, failed, ms}`.
- **Deployment** (D167): the workspace pod that runs review-pr uses `runner-devops-host` (the `gh` shim needs the real `gh`). The App needs Contents read (the loadouts repo and the reviewed repos), Pull requests write, Issues write, Checks read, Statuses read and Metadata read; no Packages. `github.permissions`, when set, must include `contents` and match what the App holds; the installation must include the loadouts repo, whose owner must be the installation's account.
```

- [ ] **Step 5: §9**

After the bullet `- **A session's App installation token is never a host grant:** …` add:

```markdown
- **The pinned-loadout sync holds a repo token only in memory** (D160, D166). It asks for `contents: read` on the one loadouts repo, sends it only to `FLEET_LOADOUTS_API`, follows the tarball redirect without it, and never logs it, writes it or gives it to loadout scripts. Extraction admits only regular files and directories under `loadouts/<id>/`, through `safeLayerPath`, within the caps, and checks the whole archive before writing. Scripts run as uid 1000, the sessions' uid. The record is session-writable (same uid); its paths are confined to `/workspace`. **Known exposure:** a host whose `github.repositories` lists the loadouts repo lets any session mint a token for it within `github.permissions`; with `contents: write` a session could push a branch or tag there. The sync refuses a tag whose commit isn't on the default branch, and the repo needs branch protection on `main` and a `*/v*` tag ruleset that only the publish workflow bypasses (design Appendix A).
```

- [ ] **Step 6: §10**

Replace

```markdown
│       └── *.test.sh                  # entry-script harness; image smoke
```

with

```markdown
│       ├── *.test.sh                  # entry-script harness; image smoke; two-pod split
│       └── testdata/fake-github.mjs   # split test: fake credential server + GitHub API for pinned loadouts
```

and append `; loadout{Pins,Record,Tar,Fetch,Sync,sCli}.ts = pinned loadouts (§7)` to the comment of the `├── host/` line under `src/`.

- [ ] **Step 7: §11 *Remote host: what remains***

Before `- **\`--mcp-config\` precedence:**` add:

```markdown
- **Host checklist for pinned loadouts:** the design's Appendix B (`superpowers/specs/2026-11-20-remote-pinned-loadouts-design.md`): tags backfilled; a pinned loadout installed before the broker listens; an unchanged restart makes no token request; a missing tag keeps the installed version and the pod Ready; an emptied pin list reverts; `gh` in a session uses the shim on `runner-devops-host`; the loadouts repo's branch protection and `*/v*` tag ruleset refuse a session's push.
- **Pinned loadouts: gaps:** `dependencies.loadouts` aren't resolved (pin each one; `git-sync-sumer`'s dependency `git-sync` isn't in the SumerSports repo); scripts run only when a version is applied, so a script whose effect lives outside `/workspace` on a non-persistent path isn't redone on a new pod; `github.permissions` is one ceiling for every repo, so a host that lists the loadouts repo lets sessions mint `contents: write` for it whenever the ceiling has it (a per-repo ceiling isn't built).
```

- [ ] **Step 8: Full gate**

Run: `npx vitest run`
Expected: PASS (the whole unit suite).

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npx tsc -p tsconfig.host.json`
Expected: no errors.

Run: `bash docker/host/fleet-host-entry.test.sh`
Expected: `ALL PASS`.

Run: `npx vite build --config vite.host.config.ts`
Expected: builds `out/host/fleet-host.mjs` and `out/host/fleet-host-cred.mjs`.

- [ ] **Step 9: Commit and open the PR**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): pinned loadouts in remote workspaces"
```

Open the PR to `ImIOImI/claude-fleet` with a factual body (what changed, the env contract, that Docker tests run in CI, that the cluster check is the design's Appendix B), ending with the required attribution line.

---

### Task 10: Version tags in `SumerSports/claude-fleet-loadouts`

Independent of Tasks 1–9. It must merge, and the backfill must have run, before platform-ops sets `FLEET_LOADOUTS`.

**Files (in a clone of `SumerSports/claude-fleet-loadouts`):**
- Create: `scripts/tag-loadouts.sh`
- Create: `scripts/tag-loadouts.test.sh`
- Modify: `.github/workflows/publish-loadouts.yml`
- Modify: `Makefile`
- Modify: `README.md`

**Interfaces:**
- Consumes: `loadouts/<id>/loadout.md` frontmatter `version`.
- Produces: lightweight tags `<id>/v<version>` on `main` commits, which the sync resolves (D161).

- [ ] **Step 1: Clone and branch**

```bash
gh repo clone SumerSports/claude-fleet-loadouts /tmp/cfl-tags -- --quiet
git -C /tmp/cfl-tags switch -c feat/version-tags
```

- [ ] **Step 2: Write the failing test**

Create `scripts/tag-loadouts.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for tag-loadouts.sh in a throwaway repo (PUSH=0, nothing leaves it). Requires git and yq.
set -u
here=$(cd "$(dirname "$0")" && pwd)
fails=0
assert() { if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fails=$((fails+1)); fi; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" || exit 1
git init -q -b main .
git config user.name test
git config user.email test@example.com
# lo <id> <version> [body]: write loadouts/<id>/loadout.md and commit.
lo() {
  mkdir -p "loadouts/$1"
  printf -- '---\ntitle: %s\ndescription: d\nversion: %s\n---\nbody %s\n' "$1" "$2" "${3:-}" > "loadouts/$1/loadout.md"
  git add -A
  git commit -qm "$1 $2 ${3:-}"
}

lo alpha 1.0.0
lo alpha 1.0.0 edited
first=$(git rev-parse HEAD)
lo alpha 1.1.0
lo beta 0.1.0

PUSH=0 bash "$here/tag-loadouts.sh" >/dev/null; assert "$?" 0 "tag mode exits 0"
assert "$(git tag | sort | tr '\n' ' ')" "alpha/v1.1.0 beta/v0.1.0 " "HEAD's versions are tagged"
PUSH=0 bash "$here/tag-loadouts.sh" >/dev/null; assert "$?" 0 "re-tagging is idempotent"
PUSH=0 bash "$here/tag-loadouts.sh" --backfill >/dev/null; assert "$?" 0 "backfill exits 0"
assert "$(git rev-parse 'alpha/v1.0.0^{commit}')" "$first" "backfill tags a version at its newest commit"

printf 'changed\n' >> loadouts/beta/loadout.md
git commit -qam "beta edit without a bump"
bash "$here/tag-loadouts.sh" --check >/dev/null 2>&1; assert "$?" 1 "--check refuses an unbumped change"
PUSH=0 bash "$here/tag-loadouts.sh" >/dev/null 2>&1; assert "$?" 1 "tag mode refuses an unbumped change"
assert "$(git rev-parse 'beta/v0.1.0^{commit}')" "$(git rev-parse HEAD~1)" "an existing tag never moves"

git reset -q --hard HEAD~1
lo gamma 1.0
bash "$here/tag-loadouts.sh" --check >/dev/null 2>&1; assert "$?" 1 "a non-semver version is refused"

bash "$here/tag-loadouts.sh" --bogus >/dev/null 2>&1; assert "$?" 2 "unknown flag is a usage error"
[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bash scripts/tag-loadouts.test.sh`
Expected: FAIL lines (`tag-loadouts.sh: No such file or directory`).

- [ ] **Step 4: Implement**

Create `scripts/tag-loadouts.sh` (and `chmod +x`):

```bash
#!/usr/bin/env bash
# Tag each loadout's version as <id>/v<version>; claude-fleet's remote workspaces pin loadouts by these tags
# (claude-fleet SPEC §7 Pinned loadouts). Run from the repo root.
#   tag-loadouts.sh             tag HEAD's version of every loadout, then push the new tags (PUSH=0 skips the push)
#   tag-loadouts.sh --check     tag nothing; fail if a version's tag exists with a different loadouts/<id> tree
#   tag-loadouts.sh --backfill  tag every version in history at the newest commit that carried it
# An existing tag never moves: a changed loadout needs a version bump. Requires git and yq (mikefarah).
set -euo pipefail
mode=${1:-tag}
case "$mode" in tag|--check|--backfill) ;; *) echo "usage: tag-loadouts.sh [--check|--backfill]" >&2; exit 2 ;; esac
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
id_re='^[a-z0-9][a-z0-9-]{0,62}$'
new=()
fails=0

# version_at <rev> <id>: the frontmatter version of loadouts/<id>/loadout.md at <rev> (empty when unset).
version_at() {
  { git show "$1:loadouts/$2/loadout.md" 2>/dev/null || true; } \
    | awk 'NR==1 && /^---[[:space:]]*$/{f=1; next} f && /^---[[:space:]]*$/{exit} f{print}' \
    | yq '.version // ""'
}

# tag_one <id> <version> <rev>
tag_one() {
  local id=$1 ver=$2 rev=$3 tag existing
  tag="$id/v$ver"
  if ! [[ $ver =~ $semver ]]; then
    echo "error: loadouts/$id version '$ver' is not MAJOR.MINOR.PATCH[-prerelease]" >&2
    fails=$((fails + 1))
    return
  fi
  if existing=$(git rev-parse -q --verify "refs/tags/$tag^{commit}"); then
    if [ "$(git rev-parse "$existing:loadouts/$id")" = "$(git rev-parse "$rev:loadouts/$id")" ]; then
      echo "= $tag"
      return
    fi
    echo "error: $tag already tags a different loadouts/$id; bump version in loadouts/$id/loadout.md" >&2
    fails=$((fails + 1))
    return
  fi
  if [ "$mode" = --check ]; then
    echo "+ $tag (new)"
    return
  fi
  git tag "$tag" "$rev"
  new+=("refs/tags/$tag")
  echo "+ $tag -> $(git rev-parse --short "$rev")"
}

for dir in loadouts/*/; do
  id=$(basename "$dir")
  [ -f "$dir/loadout.md" ] || continue
  if ! [[ $id =~ $id_re ]]; then
    echo "error: loadout id '$id' is not a valid pin id" >&2
    fails=$((fails + 1))
    continue
  fi
  if [ "$mode" = --backfill ]; then
    declare -A seen=()
    while read -r rev; do
      ver=$(version_at "$rev" "$id")
      [ -n "$ver" ] && [ -z "${seen[$ver]:-}" ] || continue
      seen[$ver]=1
      tag_one "$id" "$ver" "$rev"
    done < <(git log --format=%H HEAD -- "loadouts/$id")
    unset seen
  else
    ver=$(version_at HEAD "$id")
    if [ -z "$ver" ]; then
      echo "skip: loadouts/$id has no version"
      continue
    fi
    tag_one "$id" "$ver" HEAD
  fi
done

(( fails == 0 )) || exit 1
if [ "$mode" != --check ] && (( ${#new[@]} > 0 )) && [ "${PUSH:-1}" = 1 ]; then
  git push origin "${new[@]}"
fi
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bash scripts/tag-loadouts.test.sh`
Expected: every line `ok: …`, then `ALL PASS`.

- [ ] **Step 6: Wire the workflow, Makefile and README**

In `.github/workflows/publish-loadouts.yml`:
- add a `backfill` input to `workflow_dispatch`:

```yaml
  workflow_dispatch:
    inputs:
      backfill:
        description: Tag every loadout version in history (run once)
        type: boolean
        default: false
```

- change `permissions.contents` from `read` to `write`;
- give the Checkout step `with: { fetch-depth: 0 }` (the tag script reads history and existing tags);
- before `Validate (dry run)` add:

```yaml
      - name: Tag script tests
        run: bash scripts/tag-loadouts.test.sh

      - name: Check version tags
        run: ./scripts/tag-loadouts.sh --check
```

- after `Package and push loadouts` add:

```yaml
      - name: Tag published loadouts
        run: ./scripts/tag-loadouts.sh ${{ inputs.backfill && '--backfill' || '' }}
```

In `Makefile`, add `tag-check tag-backfill` to `.PHONY` and:

```make
# Fail if a loadout changed without a version bump (its <id>/v<version> tag holds another tree).
tag-check:
	./scripts/tag-loadouts.sh --check

# Tag every version in history and push the tags (needs push rights).
tag-backfill:
	./scripts/tag-loadouts.sh --backfill
```

In `README.md`, add a section:

```markdown
## Version tags

Every published loadout is tagged `<id>/v<version>` on `main` (`scripts/tag-loadouts.sh`, run by the publish workflow after it publishes). claude-fleet's remote workspaces pin loadouts by these tags (`FLEET_LOADOUTS="committee-pr-review@2.2.0"`), so:

- bump `version` in `loadout.md` whenever a loadout changes: the workflow fails if `<id>/v<version>` already tags a different tree, and a tag never moves;
- `make tag-check` runs the same check locally;
- the `backfill` input of a manual workflow run tags every version in history (once).
```

- [ ] **Step 7: Commit, push and open the PR**

```bash
git -C /tmp/cfl-tags add scripts/tag-loadouts.sh scripts/tag-loadouts.test.sh .github/workflows/publish-loadouts.yml Makefile README.md
git -C /tmp/cfl-tags commit -m "feat: tag each published loadout <id>/v<version> for claude-fleet pins"
git -C /tmp/cfl-tags push -u origin feat/version-tags
gh pr create -R SumerSports/claude-fleet-loadouts --head feat/version-tags --title "Tag each published loadout <id>/v<version>" --body-file <factual body ending with the attribution line>
```

After merge: run the workflow once with `backfill: true` and check `git ls-remote --tags origin '*/v*'` lists `committee-pr-review/v2.2.0` and `git-sync-sumer/v1.0.0`. Ask the repo admin for the branch protection and the `*/v*` tag ruleset (design Appendix A).

---

## Self-review

- **Spec coverage:**
  - source/auth (D159, D160): Tasks 4–6;
  - tags (D161): Task 4 (resolve, default-branch check) and Task 10;
  - pins (D162): Task 1;
  - engine and record (D163): Tasks 2, 5, 6;
  - entry and cap (D164): Task 7;
  - failure (D165): Task 5;
  - safety (D166): Tasks 3, 4, 5;
  - testing: every task, image tests in Task 8;
  - deployment answers (D167): Task 9 (SPEC) and the design's appendices;
  - SPEC.md: Task 9.
- **Placeholder scan:** the only deferred input is the PR body text in Task 9 Step 9 and Task 10 Step 7, which the repo's review conventions define (factual, attribution footer).
- **Type consistency:**
  - `PinnedRecord`/`RecordFile` (Task 1) are used unchanged by Tasks 2 and 5;
  - `Pin`, `RepoRef`, `planSync` and `pinTag` (Task 1) are used by Task 5;
  - `TAR_LIMITS`, `TarError` and `extractLoadout(tgz, id, destDir, limits?) → string[]` (Task 3) are used by Tasks 4 and 5;
  - `GithubSource`, `FetchError.stage` (`'resolve' | 'download'`), `defaultBranch`, `resolveTag(src, tag, branch, signal)` and `downloadTarball(src, commit, signal, cap?)` (Task 4) are used by Task 5;
  - `SyncOptions`, `ScriptRun` and `syncLoadouts` (Task 5) are used by Task 6;
  - `loadoutsCli(argv, env, target?, log?)` (Task 6) is used by `cli.ts`;
  - the log message strings in Task 5's Interfaces match Tasks 7–9;
  - the record path `.claude/fleet-loadouts.json` matches across Tasks 2, 5, 7, 8 and 9.
