# Task 11 Report: Bundle qwen mapper + ship/start sidecar in qwen image

## Status: COMPLETE

**Commit:** `e03f5b4`
**Tests:** 14/14 passed (8 original qwenAdapter.test.ts + 6 parity qwenAdapterMjs.test.ts)
**Typecheck:** 0 errors (after filtering TS6307 + addon-webgl + addon-canvas as instructed)

---

## 1. esbuild command (npm script)

Added to `package.json`:
```
"build:qwen-sidecar": "esbuild src/main/qwenAdapter.ts --bundle --format=esm --platform=node --outfile=docker/qwen/qwenAdapter.mjs"
```

Run ad-hoc:
```
node_modules/.bin/esbuild src/main/qwenAdapter.ts --bundle --format=esm --platform=node --outfile=docker/qwen/qwenAdapter.mjs
```

Output: `docker/qwen/qwenAdapter.mjs` 2.2 KB, exports `mapQwenRecord` as ESM named export. Committed.

---

## 2. CF_QWEN_CHATS_DIR and CF_FLEET_PROJECTS_DIR — path choices and bind-mount trace

### CF_FLEET_PROJECTS_DIR

**Traced from docker.ts `createWorkspaceInner`:**

```typescript
const claudeDir = workspaceClaudeDir(spec.id);
// paths.ts: workspaceClaudeDir(id) = join(workspaceStateDir(id), '.claude')
//         = join(<userData>/state/<id>, '.claude')
//         = <userData>/state/<id>/.claude

binds.push(`${claudeDir}:/home/fleet/.claude:rw`);
```

The host chokidar watcher (jsonlWatcher.ts) watches:
```typescript
const PROJECTS_SUBDIR = join('projects', '-workspace');
// host path: <userData>/state/<id>/.claude/projects/-workspace/
```

Therefore the in-container path is:
```
/home/fleet/.claude/projects/-workspace
```

Set: `CF_FLEET_PROJECTS_DIR=/home/fleet/.claude/projects/-workspace`

### CF_QWEN_CHATS_DIR

**Derivation:** qwen sanitizes cwd using the same character replacement as claude's `encodeClaudeProjectDir` (every non-[A-Za-z0-9] becomes `-`). The container's WorkingDir is `/workspace`, which sanitizes to `-workspace`.

qwen writes to:
```
~/.qwen/projects/<sanitized-cwd>/chats/<sid>.jsonl
         └─ -workspace ─┘
```

The sidecar's `pump(sid)` reads from `join(CHATS, `${sid}.jsonl`)`, so `CF_QWEN_CHATS_DIR` must point at the `chats` directory directly (not the parent), making it:
```
/home/fleet/.qwen/projects/-workspace/chats
```

Set: `CF_QWEN_CHATS_DIR=/home/fleet/.qwen/projects/-workspace/chats`

**Note:** `~/.qwen` is NOT bind-mounted — it lives inside the container's ephemeral layer. The sidecar reads qwen's output from this in-container path and writes to the bind-mounted `/home/fleet/.claude/projects/-workspace/` which lands on the host at `<userData>/state/<id>/.claude/projects/-workspace/` where chokidar is watching.

### Assumption requiring host verification

The `-workspace` sanitization assumes the container WorkingDir is always `/workspace` (or `/workspace` with no subdir, since `workingDir = '/workspace/' + spec.workspaceSubdir.replace(/\/$/, '') || '/workspace'`). If a qwen workspace has a non-empty `workspaceSubdir`, the sanitized path would differ. For the initial qwen-code use case (default subdir = `''`), the derivation is correct.

---

## 3. sidecar.mjs changes

**None.** The sidecar already reads `CF_QWEN_CHATS_DIR` as the direct chats dir (it does `join(CHATS, `${sid}.jsonl`)` in `pump()`), and `CF_FLEET_PROJECTS_DIR` as the output dir. No changes needed; the hardcoded path makes the chats-dir boundary explicit.

---

## 4. Parity test

`src/main/qwenAdapterMjs.test.ts` — 6 fixtures:
1. Assistant w/ usage + model → correct field mapping
2. tool_use (functionCall) → content array with tool_use block
3. tool_result (functionResponse) → content array with tool_result block
4. Plain user text → bare string content (for first_user_message)
5. functionCall.id fast-path → fc_id_123 preserved, not synthesized
6. Unmappable (system) record → null

All 6 passed on the committed `docker/qwen/qwenAdapter.mjs`.

---

## 5. Typecheck output

```
npm run typecheck 2>&1 | grep -E "error TS" | grep -vE "TS6307|addon-webgl|addon-canvas"
(empty — no errors)
```

---

---

## 6. Hardening: sidecar glob-discovers chats dirs (avoids silent-dark on path assumption)

### Problem
`sidecar.mjs` previously read `CF_QWEN_CHATS_DIR` as a hardcoded exact path
(`/home/fleet/.qwen/projects/-workspace/chats`), assuming qwen's `encodeProjectDir`
produces `-workspace` for container cwd `/workspace`. If qwen's sanitization differs,
the sidecar watches a nonexistent dir silently — no error, no transcripts on the host.

### Discovery approach

Extracted a pure, synchronous helper module `docker/qwen/discover.mjs` with two
exported functions:

- **`listChatsFiles(projectsRoot)`** — scans `<projectsRoot>/<anySubdir>/chats/*.jsonl`
  and returns their absolute paths. Used by `initialScan()` in the sidecar to pump all
  files found under any project dir.
- **`listChatsDirs(projectsRoot)`** — same scan, returns unique `chats/` directory paths.
  Used by the sidecar to wire `fs.watch` watchers for real-time event delivery.

Both functions are dependency-free (use only `node:fs` builtins), return empty arrays on
any fs error (projects root missing, chats/ not yet created), and are pure enough to test
synchronously with real tmp dirs.

### Changes

| File | Change |
|---|---|
| `docker/qwen/discover.mjs` | New: pure discovery helpers `listChatsFiles` / `listChatsDirs` |
| `docker/qwen/sidecar.mjs` | Updated: reads `CF_QWEN_PROJECTS_DIR`; imports `discover.mjs`; offset map keyed by absolute path; `CF_QWEN_CHATS_DIR` honored as optional back-compat extra hint |
| `src/main/docker.ts` | Added `CF_QWEN_PROJECTS_DIR=/home/fleet/.qwen/projects` for qwen workspaces; kept `CF_QWEN_CHATS_DIR` as back-compat hint for older sidecar images |

### Offset map keying

Previously offsets were keyed by bare sid. Now they are keyed by **absolute source path**
(`/home/fleet/.qwen/projects/<projDir>/chats/<sid>.jsonl`). In practice one workspace = one
project dir, so the same sid can't appear in two project dirs, but keying by path is strictly
safer and costs nothing.

### Back-compat

Old sidecar images (pre-discovery) still see `CF_QWEN_CHATS_DIR` set to the expected path,
so they continue to work without an image rebuild. The new sidecar additionally reads
`CF_QWEN_PROJECTS_DIR` and discovers from there.

### CF_FLEET_PROJECTS_DIR unchanged

`CF_FLEET_PROJECTS_DIR=/home/fleet/.claude/projects/-workspace` is unchanged. The host
chokidar watcher still watches `<userData>/state/<id>/.claude/projects/-workspace/`
(PROJECTS_SUBDIR in jsonlWatcher.ts). The sidecar still appends mapped `<sid>.jsonl` there.

### New unit test

`src/main/qwenSidecarDiscovery.test.ts` — 9 cases covering both exported functions with
real tmp directories (no mocking), following the `mkdtemp` pattern from `config.test.ts`:

1. `listChatsFiles` — missing projects root → `[]`
2. `listChatsFiles` — existing root, no subdirs → `[]`
3. `listChatsFiles` — project dir present but no `chats/` → `[]`
4. `listChatsFiles` — single project dir with two .jsonl files → both returned
5. `listChatsFiles` — two project dirs → all files from both returned
6. `listChatsFiles` — non-.jsonl file in `chats/` → ignored
7. `listChatsFiles` — `chats` is a file, not a dir → `[]`
8. `listChatsDirs` — missing root → `[]`
9. `listChatsDirs` — one dir with `chats/`, one without → only the one with `chats/`
10. `listChatsDirs` — two dirs both with `chats/` → both returned

### Test output

```
 Test Files  4 passed (4)
      Tests  26 passed (26)
   Start at  23:47:15
   Duration  3.51s
```
(26 = 9 new discovery tests + 2 nextLines + 8 qwenAdapter.test.ts + 6 qwenAdapterMjs.test.ts + 1 qwenSidecar.test.ts)

### Typecheck

`npm run typecheck 2>&1 | grep -E "error TS" | grep -vE "TS6307|addon-webgl|addon-canvas"` → empty.

---

## Items requiring host/CI verification

1. **Image build:** Docker not available in this container; the Dockerfile changes (COPY *.mjs + start.sh, chmod, CMD) must be built and verified in CI or on the host.
2. **`-workspace` path assumption:** Verify that qwen actually uses `-workspace` as the project subdir when the container cwd is `/workspace`. This can be confirmed by running a qwen session and checking `~/.qwen/projects/` inside the container.
3. **qwen chats vs projects layout:** Confirm qwen creates the `chats/` subdir under the project dir (expected from `chatRecordingService.ts` in QwenLM/qwen-code), not just bare `<sid>.jsonl` files directly under `-workspace`.
4. **End-to-end flow:** After image rebuild, run a qwen session and verify a `<sid>.jsonl` appears at `<userData>/state/<id>/.claude/projects/-workspace/` on the host.
