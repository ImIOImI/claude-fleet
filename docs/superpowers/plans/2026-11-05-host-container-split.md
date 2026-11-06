# Host container split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the fleet-host pod as a host container (fleet-host + credential socket, uid 1001) and a workspace container (broker + sessions, uid 1000) from one image, sharing only two group-0660 sockets, so a session can no longer read the App key, read fleet-host's `/proc`, or kill fleet-host.

**Architecture:** `fleet-host-entry` gains a required mode (`host`, `workspace`, `prep`, `single`). A `prep` initContainer makes the shared socket directory (3770, group 1500) and copies the App key to a memory emptyDir as 0400 uid 1001. The broker and the credential server each gain a "group socket" mode, switched on by env. Ingest stops following symlinks, since transcripts now share a mount namespace with the key.

**Tech Stack:** bash, Go 1.x (broker), TypeScript / Node 22 (fleet-host), vitest, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-05-host-container-split-design.md` (decisions D1–D10, pod spec §4). SPEC §4 *Host images*, §7 *Remote host*, §9.

## Global Constraints

- uids/gids: `fleet` 1000:1000 (workspace), `fleet-host` 1001:1001 (host, prep), shared group `fleet-run` 1500.
- Shared dir `/run/fleet` (`FLEET_RUN_DIR`), mode 3770, group 1500 (`FLEET_RUN_GID`); sockets `/run/fleet/broker.sock` and `/run/fleet/cred.sock`, 0660, group 1500.
- **Amendment (c3b):** `prep` also makes `/run/fleet/mcp/` (uid 1001, group 1500, mode 2750) for the fleet-state MCP socket `/run/fleet/mcp/mcp.sock` (0660, group 1500). The prep test (case 22) asserts `stat -c '%a %u %g' "$p/run/sock/mcp"` = `2750 $(id -u) $(id -g)`, and reruns leave it unchanged. fleet-host checks the directory itself (`src/host/socketDir.ts`). Task 4: `fleet-host-entry host` exports `FLEET_HOST_MCP_SOCKET=/run/fleet/mcp/mcp.sock` and `FLEET_HOST_MCP_SOCKET_GROUP=$FLEET_RUN_GID`, and the shared-directory check should reuse `socketDir.ts`.
- New env: `CLAUDE_FLEET_BROKER_SOCKET_GROUP` (broker), `FLEET_HOST_CRED_SOCKET_GROUP` (fleet-host and `fleet-host-cred serve`), `FLEET_WORKSPACE_UID` (default 1000), `FLEET_PREP_RUN`, `FLEET_PREP_KEY_SRC`, `FLEET_PREP_KEY_DST`.
- Unset, every new env leaves today's behaviour (broker socket 0666; cred socket 0600 in a 0700 dir).
- No mode → `fleet-host-entry` exits 2. `single` is today's script plus a warning.
- Every change to the env contract, image layout or §9 updates `docs/SPEC.md` in the same commit (`.claude/rules/spec-maintenance.md`).
- Code comments: terse, only for non-obvious why (`.claude/rules/review-conventions.md`).
- Secret hygiene: never `bash -x`/`set -x`, `env` or `printenv` in this container.
- Worktree: `W=/workspace/claude-fleet/.claude/worktrees/<name>`; use `git -C "$W"`; never `cd /workspace/claude-fleet`; never stage `.superpowers/`.
- Unit tests: `npx vitest run <file>`; Go: `cd broker && go test -race ./...` (Go at `/usr/local/go/bin` in the dev image).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `broker/internal/listen/listen.go` (+ `_test.go`) | create | the broker's Unix socket, world or group mode |
| `broker/cmd/broker/main.go` | modify | read `CLAUDE_FLEET_BROKER_SOCKET_GROUP`, call `listen.Unix` |
| `src/host/credServer.ts` (+ test) | modify | shared-dir check, group socket mode |
| `src/host/config.ts` (+ test) | modify | `HostEnv.credSocketGroup` |
| `src/host/main.ts`, `src/host/credServe.ts` | modify | pass `socketGroup` through |
| `src/host/hostIngest.ts` (+ test) | modify | no symlinks, regular files, realpath containment |
| `docker/host/fleet-host-entry` (+ `.test.sh`) | modify | the four modes |
| `docker/host/Dockerfile` | modify | `fleet-host` user, `fleet-run` group, dirs |
| `docker/host/smoke.test.sh` | modify | runs `single`, asserts the no-mode refusal |
| `docker/host/split.test.sh` | create | plain-docker emulation of the pod |
| `.github/workflows/test-runner-images.yml` | modify | runs `split.test.sh` |
| `docs/SPEC.md` | modify | §4, §7, §9 |

---

### Task 1: Broker group-socket mode

**Files:**
- Create: `broker/internal/listen/listen.go`, `broker/internal/listen/listen_test.go`
- Modify: `broker/cmd/broker/main.go` (header knob list; the unix branch around lines 86–111)
- Modify: `docs/SPEC.md` §4 *Host images* (after the *Supervision* bullet)

**Interfaces:**
- Produces: `listen.Unix(ctx context.Context, path string, gid int, logf func(string, ...any)) (net.Listener, error)`; env `CLAUDE_FLEET_BROKER_SOCKET_GROUP`.

- [ ] **Step 1: Write the failing tests** — `broker/internal/listen/listen_test.go`:

```go
package listen

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Unix socket paths are capped near 108 bytes; t.TempDir() can exceed that.
func shortDir(t *testing.T) string {
	d, err := os.MkdirTemp("", "ls")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func statSock(t *testing.T, p string) (os.FileMode, int) {
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket", p)
	}
	return st.Mode().Perm(), int(st.Sys().(*syscall.Stat_t).Gid)
}

func TestGroupModeIs0660InTheGroup(t *testing.T) {
	p := filepath.Join(shortDir(t), "b.sock")
	ln, err := Unix(context.Background(), p, os.Getgid(), t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	perm, gid := statSock(t, p)
	if perm != 0o660 || gid != os.Getgid() {
		t.Fatalf("got %o gid %d, want 660 gid %d", perm, gid, os.Getgid())
	}
}

func TestGroupModeNeedsTheDirectory(t *testing.T) {
	p := filepath.Join(shortDir(t), "missing", "b.sock")
	if ln, err := Unix(context.Background(), p, os.Getgid(), t.Logf); err == nil {
		ln.Close()
		t.Fatal("listened in a directory prep never made")
	}
}

func TestWorldModeCreatesTheDirectory(t *testing.T) {
	p := filepath.Join(shortDir(t), "run", "b.sock")
	ln, err := Unix(context.Background(), p, -1, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if perm, _ := statSock(t, p); perm != 0o666 {
		t.Fatalf("got %o, want 666", perm)
	}
}

func TestReplacesAStaleEntry(t *testing.T) {
	p := filepath.Join(shortDir(t), "b.sock")
	if err := os.WriteFile(p, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ln, err := Unix(context.Background(), p, os.Getgid(), t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	statSock(t, p)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && go test ./internal/listen/`
Expected: FAIL, `undefined: Unix`.

- [ ] **Step 3: Implement** — `broker/internal/listen/listen.go`:

```go
// Package listen opens the broker's Unix socket.
package listen

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// Unix listens on path. With gid < 0 the socket is world-rw (the desktop's
// host is another uid) and its directory is created. With gid >= 0 the
// directory must already exist (fleet-host-entry prep makes it) and the
// socket is 0660 in group gid.
func Unix(ctx context.Context, path string, gid int, logf func(string, ...any)) (net.Listener, error) {
	if gid < 0 {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("mkdir socket dir: %w", err)
		}
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale socket: %w", err)
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	if gid < 0 {
		if err := os.Chmod(path, 0o666); err != nil {
			logf("chmod socket: %v (continuing)", err)
		}
		return ln, nil
	}
	err = os.Lchown(path, -1, gid)
	if err == nil {
		err = os.Chmod(path, 0o660)
	}
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("socket group %d: %w", gid, err)
	}
	return ln, nil
}
```

- [ ] **Step 4: Wire `main.go`.** Add to the header knob list after `CLAUDE_FLEET_BROKER_TCP_PORT`:

```go
//	CLAUDE_FLEET_BROKER_SOCKET_GROUP  if set (a gid), the socket is 0660 in
//	                              that group and its directory must already
//	                              exist (the split pod's shared dir).
//	                              (default: unset → 0666, dir created)
```

Import `github.com/ImIOImI/claude-fleet/broker/internal/listen`. After `claudeExec := …` add:

```go
	sockGroup := -1
	if g := os.Getenv("CLAUDE_FLEET_BROKER_SOCKET_GROUP"); g != "" {
		n, err := strconv.Atoi(g)
		if err != nil || n < 0 {
			log.Fatalf("CLAUDE_FLEET_BROKER_SOCKET_GROUP %q is not a group id", g)
		}
		sockGroup = n
	}
```

Replace the whole unix `else { … }` branch body with:

```go
		listenAddr = socketPath
		ln, err = listen.Unix(ctx, socketPath, sockGroup, log.Printf)
		if err != nil {
			log.Fatalf("listen %s: %v", socketPath, err)
		}
```

Drop the now-unused `path/filepath` and `errors` imports only if the compiler says so (`errors` is still used by the serve error check).

- [ ] **Step 5: Run the tests and build**

Run: `cd broker && go test -race ./... && CGO_ENABLED=0 go build -o /tmp/broker ./cmd/broker`
Expected: PASS, build succeeds.

- [ ] **Step 6: SPEC.** In §4 *Host images*, after the *Supervision* bullet, add:

```markdown
- **Broker socket group:** with `CLAUDE_FLEET_BROKER_SOCKET_GROUP=<gid>` the broker creates its socket 0660 in that group and requires the directory to exist; unset, the socket is 0666 and the directory is created (the desktop's host is another uid).
```

- [ ] **Step 7: Commit**

```bash
git -C "$W" add broker/internal/listen broker/cmd/broker/main.go docs/SPEC.md
git -C "$W" commit -m "feat(broker): group-socket mode for the split host pod

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Credential socket in a shared directory

**Files:**
- Modify: `src/host/credServer.ts` (`listenCredSocket`, `CredHelperOptions`, `startCredHelper`; new `checkSharedSocketDir`)
- Modify: `src/host/config.ts` (`HostEnv`, `readHostEnv`)
- Modify: `src/host/main.ts:126`, `src/host/credServe.ts:15`
- Test: `src/host/credServer.test.ts`, `src/host/config.test.ts`
- Modify: `docs/SPEC.md` §7 *Remote host* env table and *GitHub App credentials* → *Socket*

**Interfaces:**
- Produces: `HostEnv.credSocketGroup: number | null`; `listenCredSocket(socketPath: string, minter: TokenMinter, log: Logger, group?: number | null): Promise<CredServer>`; `CredHelperOptions.socketGroup?: number | null`; `checkSharedSocketDir(dir: string, group: number): Promise<void>`.

- [ ] **Step 1: Failing tests, env.** In `src/host/config.test.ts`, add `credSocketGroup: null,` to the `toEqual` object in *applies the deployment contract defaults*, and add to `describe('readHostEnv')`:

```ts
  it('reads FLEET_HOST_CRED_SOCKET_GROUP as a group id', () => {
    expect(readHostEnv({ FLEET_HOST_CRED_SOCKET_GROUP: '1500' }).credSocketGroup).toBe(1500);
    for (const bad of ['x', '-1', '1.5', '2147483648']) {
      expect(() => readHostEnv({ FLEET_HOST_CRED_SOCKET_GROUP: bad })).toThrow(/FLEET_HOST_CRED_SOCKET_GROUP/);
    }
  });
```

- [ ] **Step 2: Failing tests, socket.** In `src/host/credServer.test.ts`, extend the `node:fs` import with `symlinkSync`, import `type TokenMinter` from `./appToken.js`, and append:

```ts
describe('credential socket in a shared directory', () => {
  const gid = process.getgid!();
  const log = createLogger(() => undefined);
  const stub = { account: async () => 'acme', mint: async () => { throw new Error('unused'); } } as unknown as TokenMinter;
  const shared = (mode = 0o2770) => {
    const d = mkdtempSync(join(tmpdir(), 'crs-'));
    chmodSync(d, mode);
    return d;
  };

  it('is 0660 in the group and leaves the directory as prep made it', async () => {
    const d = shared();
    srv = await listenCredSocket(join(d, 'cred.sock'), stub, log, gid);
    const st = statSync(join(d, 'cred.sock'));
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o660);
    expect(st.gid).toBe(gid);
    expect(statSync(d).mode & 0o7777).toBe(0o2770);
  });

  it('refuses a directory others can reach', async () => {
    await expect(listenCredSocket(join(shared(0o2777), 'cred.sock'), stub, log, gid)).rejects.toThrow(/no access for others/);
  });

  it('refuses a directory in another group', async () => {
    await expect(listenCredSocket(join(shared(), 'cred.sock'), stub, log, gid + 1)).rejects.toThrow(/must be group/);
  });

  it('refuses a symlinked directory', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'crl-')), 'run');
    symlinkSync(shared(), link);
    await expect(listenCredSocket(join(link, 'cred.sock'), stub, log, gid)).rejects.toThrow(/not a directory/);
  });

  it('replaces a stale file holding the socket name', async () => {
    const d = shared();
    writeFileSync(join(d, 'cred.sock'), 'x');
    srv = await listenCredSocket(join(d, 'cred.sock'), stub, log, gid);
    expect(statSync(join(d, 'cred.sock')).isSocket()).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/host/credServer.test.ts src/host/config.test.ts`
Expected: FAIL (the new cases; `credSocketGroup` missing).

- [ ] **Step 4: Implement `config.ts`.** Add to `HostEnv`:

```ts
  /** Set in the split pod: the credential socket is 0660 in this group, in a directory `fleet-host-entry prep` made. */
  credSocketGroup: number | null;
```

In `readHostEnv`, before `return`:

```ts
  const groupText = env.FLEET_HOST_CRED_SOCKET_GROUP;
  let credSocketGroup: number | null = null;
  if (groupText) {
    const g = Number(groupText);
    if (!/^\d+$/.test(groupText) || g > 0x7fffffff) throw new HostConfigError(`FLEET_HOST_CRED_SOCKET_GROUP ${groupText} is not a group id`);
    credSocketGroup = g;
  }
```

and add `credSocketGroup,` to the returned object.

- [ ] **Step 5: Implement `credServer.ts`.** Import `chown` and `rm` from `node:fs/promises`. Add:

```ts
export async function checkSharedSocketDir(dir: string, group: number): Promise<void> {
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`${dir} is not a directory (run fleet-host-entry prep)`);
  if (st.gid !== group || (st.mode & 0o070) !== 0o070 || (st.mode & 0o007) !== 0) {
    throw new Error(`${dir} must be group ${group} with group rwx and no access for others`);
  }
}
```

Change the signature to `listenCredSocket(socketPath: string, minter: TokenMinter, log: Logger, group: number | null = null)` and replace the directory/stale-socket block with:

```ts
  const dir = dirname(socketPath);
  if (group === null) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const st = await lstat(socketPath).catch(() => null);
    if (st) {
      if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      await unlink(socketPath);
    }
  } else {
    await checkSharedSocketDir(dir, group);
    // The dir is sticky and ours, so whatever holds the name can go, even a file a session left.
    await rm(socketPath, { force: true });
  }
```

Replace `await chmod(socketPath, 0o600);` with:

```ts
  if (group !== null) await chown(socketPath, -1, group);
  await chmod(socketPath, group === null ? 0o600 : 0o660);
```

Add `socketGroup?: number | null;` to `CredHelperOptions` and end `startCredHelper` with `return listenCredSocket(o.socketPath, minter, o.log, o.socketGroup ?? null);`.

- [ ] **Step 6: Wire callers.** `src/host/main.ts:126` and `src/host/credServe.ts:15`: add `socketGroup: env.credSocketGroup` to the `startCredHelper({ … })` object.

- [ ] **Step 7: Run**

Run: `npx vitest run src/host/ && npx tsc --noEmit -p tsconfig.host.json`
Expected: PASS, no type errors.

- [ ] **Step 8: SPEC.** §7 *Remote host* env table, add a row after `FLEET_HOST_CRED_SOCKET`:

```markdown
| `FLEET_HOST_CRED_SOCKET_GROUP` | unset | split pod: the credential socket is 0660 in this gid, in a directory `fleet-host-entry prep` made (3770); the directory is checked, never changed |
```

In *GitHub App credentials* → **Socket**, replace "(0600, in a 0700 directory)" with "(0600 in a 0700 directory; with `FLEET_HOST_CRED_SOCKET_GROUP`, 0660 in that group in the shared directory, which must be a real directory in that group with no access for others, and whose stale entry is replaced)".

- [ ] **Step 9: Commit**

```bash
git -C "$W" add src/host/credServer.ts src/host/credServer.test.ts src/host/config.ts src/host/config.test.ts src/host/main.ts src/host/credServe.ts docs/SPEC.md
git -C "$W" commit -m "feat(host): credential socket in the split pod's shared directory

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Ingest never follows a symlink

**Files:**
- Modify: `src/host/hostIngest.ts` (`process`, new `inProjects`)
- Test: `src/host/hostIngest.test.ts` (Postgres suite)
- Modify: `docs/SPEC.md` §7 *Ingest*

**Interfaces:**
- Consumes: nothing new. Produces: nothing other tasks call.

- [ ] **Step 1: Failing test.** In `src/host/hostIngest.test.ts`, extend the `node:fs` import with `symlinkSync`, and add after *attributes a subagent transcript to its parent session*:

```ts
  it('never follows a symlink out of the projects directory', async () => {
    const { make, projects } = await rig();
    const S2 = '22222222-2222-4222-8222-222222222222';
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'agent-x.jsonl'), line('o'));
    mkdirSync(join(projects, '-workspace', S1));
    symlinkSync(outside, join(projects, '-workspace', S1, 'subagents'));
    mkdirSync(join(projects, '-workspace', S2, 'subagents'), { recursive: true });
    symlinkSync(join(outside, 'agent-x.jsonl'), join(projects, '-workspace', S2, 'subagents', 'agent-y.jsonl'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts -t symlink`
Expected: FAIL, `expected 2 to be 0`. (Needs the Postgres the pg config points at; CI runs this suite.)

- [ ] **Step 3: Implement.** In `hostIngest.ts`, change imports to `import { constants, watch, type FSWatcher } from 'node:fs';`, add `realpath` to the `node:fs/promises` import and `dirname, sep` to `node:path`. Add a field and method to the class:

```ts
  private projectsReal: string | null = null;

  private async inProjects(path: string): Promise<boolean> {
    this.projectsReal ??= await realpath(this.o.projectsDir);
    const dir = await realpath(dirname(path));
    return dir === this.projectsReal || dir.startsWith(this.projectsReal + sep);
  }
```

In `process`, replace `fh = await open(path, 'r');` with:

```ts
      // Names are session-controlled and the App key shares this mount namespace.
      if (!(await this.inProjects(path))) return;
      fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
```

and immediately after `const st = await fh.stat({ bigint: true });` add `if (!st.isFile()) return;` (the existing `finally` closes `fh`).

- [ ] **Step 4: Run**

Run: `npx vitest run -c vitest.pg.config.ts src/host/hostIngest.test.ts && npx tsc --noEmit -p tsconfig.host.json`
Expected: PASS.

- [ ] **Step 5: SPEC.** §7 *Ingest*, append a bullet:

```markdown
- Transcript names are session-controlled: a file is opened with `O_NOFOLLOW`, only a regular file is read, and a file whose directory's realpath is outside `FLEET_HOST_PROJECTS` is skipped. In the split pod the App key shares fleet-host's mount namespace.
```

- [ ] **Step 6: Commit**

```bash
git -C "$W" add src/host/hostIngest.ts src/host/hostIngest.test.ts docs/SPEC.md
git -C "$W" commit -m "fix(host): ingest never follows a symlink out of the projects dir

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `fleet-host-entry` modes

**Files:**
- Modify: `docker/host/fleet-host-entry` (full rewrite below)
- Test: `docker/host/fleet-host-entry.test.sh`
- Modify: `docs/SPEC.md` §4 *Supervision*, §7 *Exit codes*, §9

**Interfaces:**
- Consumes: Task 1's `CLAUDE_FLEET_BROKER_SOCKET_GROUP`, Task 2's `FLEET_HOST_CRED_SOCKET_GROUP`.
- Produces: `fleet-host-entry host|workspace|prep|single`; env `FLEET_RUN_DIR`, `FLEET_RUN_GID`, `FLEET_WORKSPACE_UID`, `FLEET_PREP_RUN`, `FLEET_PREP_KEY_SRC`, `FLEET_PREP_KEY_DST`. Usage line text: `usage: fleet-host-entry host|workspace|prep|single`.

- [ ] **Step 1: Update the harness fakes and `run`.** In `fleet-host-entry.test.sh`:

Broker fake, after `echo broker-start >> "$FAKE_DIR/events"`:

```bash
echo "env ${CLAUDE_FLEET_BROKER_SOCKET:-} ${CLAUDE_FLEET_BROKER_SOCKET_GROUP:-} ${FLEET_HOST_CRED_SOCKET:-}" >> "$FAKE_DIR/events"
```

Host fake, after `note('host-start');`:

```js
note(`env ${process.env.CLAUDE_FLEET_BROKER_SOCKET ?? ''} ${process.env.FLEET_HOST_CRED_SOCKET ?? ''} ${process.env.FLEET_HOST_CRED_SOCKET_GROUP ?? ''}`);
```

Replace `run()` with:

```bash
# run <case> <mode|none> [env...]: starts the entry script in the background; sets $pid and $dir.
# RUN_DIR_MODE (default 2770) is the mode of the fake shared socket dir.
run() {
  dir="$tmp/case-$1"; local mode=$2; shift 2
  mkdir -p "$dir/run"; chmod "${RUN_DIR_MODE:-2770}" "$dir/run"; : > "$dir/events"
  local args=("$mode"); [ "$mode" = none ] && args=()
  env -u CLAUDE_FLEET_BROKER_TCP_PORT -u CLAUDE_FLEET_BROKER_SOCKET -u FLEET_HOST_CRED_SOCKET \
    FAKE_DIR="$dir" FLEET_BROKER_BIN="$tmp/broker" FLEET_HOST_JS="$tmp/host.mjs" FLEET_HOST_PORT="$(free_port)" \
    FLEET_HOST_BACKOFF_START_MS=20 FLEET_HOST_BACKOFF_MAX_MS=80 \
    FLEET_RUN_DIR="$dir/run" FLEET_RUN_GID="$(id -g)" FLEET_WORKSPACE_UID=99999 "$@" \
    bash "$here/fleet-host-entry" "${args[@]}" 2> "$dir/log" &
  pid=$!
}
```

Insert `single` as the second argument of every existing `run` call (cases 1–10), e.g. `run restart single FAKE_HOST_CRASHES=2`, `run squat6 single FLEET_HOST_PORT="$squat_port"`.

- [ ] **Step 2: Add the new cases** before the final `[ "$fails" -eq 0 ]` line:

```bash
# 11. No mode refuses with usage and starts nothing.
run nomode none
finish
assert "$st" "2" "no mode exits 2"
assert "$(count broker-start)" "0" "no mode starts no broker"
grep -q 'usage: fleet-host-entry host|workspace|prep|single' "$dir/log"; assert "$?" "0" "usage logged"

# 12. single warns about the shared uid.
run singlewarn single
until_count host-start 1
grep -q 'single-container mode' "$dir/log"; assert "$?" "0" "single warns"
kill -TERM "$pid"; finish

# 13. workspace execs the broker with the shared-socket env, and no fleet-host.
run ws workspace
until_count broker-start 1
assert "$(grep '^env ' "$dir/events")" "env $dir/run/broker.sock $(id -g) $dir/run/cred.sock" "workspace exports socket env"
assert "$(head -1 "$dir/pids")" "$pid" "workspace execs the broker"
assert "$(count host-start)" "0" "workspace runs no fleet-host"
kill -TERM "$pid"; finish
assert "$st" "0" "workspace exits with the broker"

# 14. workspace propagates the broker's exit status.
run wsexit workspace FAKE_BROKER_EXIT=4
finish
assert "$st" "4" "workspace exit status is the broker's"

# 15. workspace refuses a TCP broker port.
run wstcp workspace CLAUDE_FLEET_BROKER_TCP_PORT=7070
finish
assert "$st" "1" "workspace refuses CLAUDE_FLEET_BROKER_TCP_PORT"
assert "$(count broker-start)" "0" "broker never started under TCP"

# 16. Both split modes refuse a run dir others can reach, or in another group.
RUN_DIR_MODE=2777 run wsopen workspace
finish
assert "$st" "1" "workspace refuses a world-reachable run dir"
grep -q 'fleet-host-entry prep' "$dir/log"; assert "$?" "0" "refusal names prep"
run hostgid host FLEET_RUN_GID=$(( $(id -g) + 1 ))
finish
assert "$st" "1" "host refuses a run dir in another group"
assert "$(count host-start)" "0" "host never started on a bad run dir"

# 17. host exports the shared-socket env; a non-75 exit ends the container with its status.
run hostexit host FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=3
finish
assert "$st" "3" "host exit status is fleet-host's"
assert "$(count host-start)" "1" "host leaves other exits to Kubernetes"
assert "$(grep -m1 '^env ' "$dir/events")" "env $dir/run/broker.sock $dir/run/cred.sock $(id -g)" "host exports socket env"
assert "$(count broker-start)" "0" "host runs no broker"

# 18. host restarts exit 75 with backoff and never gives up.
run host75 host FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75
until_count host-start 4
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "host still running after repeated exit 75"
grep -q '"delayMs":80' "$dir/log"; assert "$?" "0" "host exit-75 restarts back off"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM in backoff exits 0"

# 19. host forwards SIGHUP and SIGTERM.
run hosthup host
until_count host-start 1
sleep 0.2
kill -HUP "$pid"
until_count host-hup 1; assert "$(count host-hup)" "1" "host forwards SIGHUP"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM exits 0"
assert "$(count host-term)" "1" "SIGTERM reaches fleet-host"
assert "$(count host-start)" "1" "host never restarted on HUP or TERM"

# 20. host never starts onto a taken port.
squat_port=$(free_port)
node -e "require('net').createServer().listen($squat_port,'0.0.0.0')" &
squatter=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$squat_port") 2>/dev/null && break; sleep 0.05; done
run hostsquat host FLEET_HOST_PORT="$squat_port"
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "host refuses a taken port"
assert "$(count host-start)" "0" "host never starts onto a taken port"

# 21. host refuses to run as the workspace uid.
run hostuid host FLEET_WORKSPACE_UID="$(id -u)"
finish
assert "$st" "1" "host refuses the workspace uid"
assert "$(count host-start)" "0" "fleet-host never started as the workspace uid"
grep -q 'refuses to run as the workspace uid' "$dir/log"; assert "$?" "0" "uid refusal logged"

# 22. prep makes the socket dir and copies the key; reruns are idempotent; no key is fine.
p="$tmp/prep"; mkdir -p "$p/run" "$p/secret" "$p/key"
printf 'PEM' > "$p/secret/key.pem"; chmod 0444 "$p/secret/key.pem"
prep() { FLEET_RUN_GID="$(id -g)" FLEET_PREP_RUN="$1/run" FLEET_PREP_KEY_SRC="$1/secret/key.pem" FLEET_PREP_KEY_DST="$1/key/key.pem" bash "$here/fleet-host-entry" prep 2> "$1/log"; }
prep "$p"; assert "$?" "0" "prep exits 0"
assert "$(stat -c '%a %g' "$p/run/sock")" "3770 $(id -g)" "prep makes a 3770 dir in the run group"
assert "$(stat -c '%a %u' "$p/key/key.pem")" "400 $(id -u)" "prep copies the key 0400"
assert "$(cat "$p/key/key.pem")" "PEM" "prep copies the key's bytes"
prep "$p"; assert "$?" "0" "prep reruns cleanly"
rm "$p/secret/key.pem" "$p/key/key.pem"
prep "$p"; assert "$?" "0" "prep without a key exits 0"
[ -e "$p/key/key.pem" ]; assert "$?" "1" "no key copied when the Secret has none"
grep -q 'credential helper stays off' "$p/log"; assert "$?" "0" "missing key logged"
p2="$tmp/prep2"; mkdir -p "$p2/run" "$p2/key" "$p2/secret"; ln -s "$tmp" "$p2/run/sock"
prep "$p2"; assert "$?" "1" "prep refuses a symlinked socket dir"
```

- [ ] **Step 3: Run to verify failure**

Run: `bash docker/host/fleet-host-entry.test.sh`
Expected: cases 1–10 pass only if the script ignores `$1` (it does today); cases 11–22 FAIL; final line not `ALL PASS`.

- [ ] **Step 4: Rewrite `docker/host/fleet-host-entry`:**

```bash
#!/usr/bin/env bash
# fleet-host-entry <mode> (SPEC §4 Host images):
#   host       fleet-host and the credential socket (split pod, uid 1001)
#   workspace  the broker and its sessions (split pod, uid 1000)
#   prep       split pod initContainer: the shared socket dir and the App key copy
#   single     broker and fleet-host in one container under one uid; local and dev only
set -u
mode=${1:-}
broker_bin=${FLEET_BROKER_BIN:-/usr/local/bin/broker}
host_js=${FLEET_HOST_JS:-/usr/local/lib/fleet-host/fleet-host.mjs}
host_port=${FLEET_HOST_PORT:-8080}
max_restarts=${FLEET_HOST_MAX_RESTARTS:-5}
window_s=${FLEET_HOST_RESTART_WINDOW_S:-60}
backoff_start_ms=${FLEET_HOST_BACKOFF_START_MS:-1000}
backoff_max_ms=${FLEET_HOST_BACKOFF_MAX_MS:-10000}
run_dir=${FLEET_RUN_DIR:-/run/fleet}
run_gid=${FLEET_RUN_GID:-1500}
workspace_uid=${FLEET_WORKSPACE_UID:-1000}

log() { printf '{"level":"%s","msg":"fleet-host-entry: %s"%s}\n' "$1" "$2" "${3:-}" >&2; }

# TCP mode would serve the broker, unauthenticated, on the pod IP.
refuse_tcp() {
  if [ -n "${CLAUDE_FLEET_BROKER_TCP_PORT:-}" ]; then
    log error "CLAUDE_FLEET_BROKER_TCP_PORT is set; refusing to start (the broker must stay on its Unix socket)"
    exit 1
  fi
}

# True if any socket in this network namespace listens on $host_port (IPv4 or IPv6, any address).
port_bound() {
  local hex sl local_addr rem st rest
  hex=$(printf '%04X' "$host_port")
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    while read -r sl local_addr rem st rest; do
      [ "$st" = 0A ] && [ "${local_addr##*:}" = "$hex" ] && return 0
    done < "$f"
  done
  return 1
}

check_run_dir() {
  local gid perm
  if [ -L "$run_dir" ] || [ ! -d "$run_dir" ]; then
    log error "$run_dir is not a directory (run fleet-host-entry prep first)"
    exit 1
  fi
  read -r gid perm < <(stat -c '%g %a' "$run_dir")
  if [ "$gid" != "$run_gid" ] || (( (8#$perm & 8#070) != 8#070 || (8#$perm & 8#007) != 0 )); then
    log error "$run_dir must be group $run_gid with group rwx and no access for others (run fleet-host-entry prep first)" ",\"gid\":$gid,\"mode\":\"$perm\""
    exit 1
  fi
}

host=
pause=
delay_ms=$backoff_start_ms

# Sleeps delay_ms (a trapped signal cuts it short), then doubles it up to the max.
backoff_sleep() {
  sleep "$(( delay_ms / 1000 )).$(printf '%03d' $(( delay_ms % 1000 )))" &
  pause=$!
  while kill -0 "$pause" 2>/dev/null; do wait "$pause" 2>/dev/null; done
  pause=
  delay_ms=$(( delay_ms * 2 > backoff_max_ms ? backoff_max_ms : delay_ms * 2 ))
}

stop_host() {
  [ -n "$pause" ] && kill "$pause" 2>/dev/null
  if [ -n "$host" ]; then
    kill -TERM "$host" 2>/dev/null
    wait "$host" 2>/dev/null
  fi
}

run_prep() {
  local root=${FLEET_PREP_RUN:-/prep/run} src=${FLEET_PREP_KEY_SRC:-/prep/secret/key.pem} dst=${FLEET_PREP_KEY_DST:-/prep/key/key.pem}
  local d=$root/sock
  if [ -L "$d" ]; then log error "$d is a symlink; refusing"; exit 1; fi
  mkdir -p "$d" || exit 1
  if [ "$(stat -c %u "$d")" != "$(id -u)" ]; then log error "$d is owned by another user; refusing"; exit 1; fi
  # setgid: every socket gets the run group. sticky: only a socket's owner, or this dir's, can remove it.
  chgrp "$run_gid" "$d" && chmod 3770 "$d" || exit 1
  if [ -e "$src" ]; then
    install -m 0400 "$src" "$dst.tmp" && mv -f "$dst.tmp" "$dst" || exit 1
    log info "app key copied"
  else
    log info "no app key at $src; the credential helper stays off"
  fi
}

run_workspace() {
  refuse_tcp
  check_run_dir
  export CLAUDE_FLEET_BROKER_SOCKET=${CLAUDE_FLEET_BROKER_SOCKET:-$run_dir/broker.sock}
  export CLAUDE_FLEET_BROKER_SOCKET_GROUP=$run_gid
  export FLEET_HOST_CRED_SOCKET=${FLEET_HOST_CRED_SOCKET:-$run_dir/cred.sock}
  exec "$broker_bin"
}

run_host() {
  if [ "$(id -u)" = "$workspace_uid" ]; then
    log error "host mode refuses to run as the workspace uid $workspace_uid"
    exit 1
  fi
  check_run_dir
  export CLAUDE_FLEET_BROKER_SOCKET=${CLAUDE_FLEET_BROKER_SOCKET:-$run_dir/broker.sock}
  export FLEET_HOST_CRED_SOCKET=${FLEET_HOST_CRED_SOCKET:-$run_dir/cred.sock}
  export FLEET_HOST_CRED_SOCKET_GROUP=$run_gid
  trap 'stop_host; exit 0' TERM INT
  trap '[ -n "$host" ] && kill -HUP "$host" 2>/dev/null' HUP
  local status
  while :; do
    # The pod's containers share a network namespace: a session can listen here while fleet-host is down.
    if port_bound; then
      log error "port $host_port is already bound; refusing to start fleet-host" ",\"port\":$host_port"
      exit 1
    fi
    node "$host_js" &
    host=$!
    while :; do
      wait "$host"; status=$?
      kill -0 "$host" 2>/dev/null || break
    done
    host=
    # 75 = EXIT_DB_UNAVAILABLE in src/host/main.ts. Restarted here: CrashLoopBackOff would hold the host down for minutes after the DB recovers.
    if (( status != 75 )); then
      log error "fleet-host exited" ",\"status\":$status"
      exit "$status"
    fi
    log warn "fleet-host exited (db unavailable); restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    backoff_sleep
  done
}

# fleet-host never starts onto a port someone else holds: sessions share its
# uid, so a session could kill it and listen in its place to collect bearer
# tokens. The container exits instead.
run_single() {
  refuse_tcp
  log warn "single-container mode: sessions share fleet-host's uid (SPEC §9); local and dev only"
  stop() {
    stop_host
    kill -TERM "$broker" 2>/dev/null
    wait "$broker" 2>/dev/null
  }
  trap 'stop; exit 0' TERM INT
  trap '[ -n "$host" ] && kill -HUP "$host" 2>/dev/null' HUP

  "$broker_bin" &
  broker=$!

  starts=()
  start_host() {
    if port_bound; then
      log error "port $host_port is already bound; refusing to start fleet-host" ",\"port\":$host_port"
      stop
      exit 1
    fi
    node "$host_js" &
    host=$!
    starts+=("$SECONDS")
  }
  start_host

  while :; do
    done_pid=
    wait -n -p done_pid "$broker" "$host"
    status=$?
    # A trapped signal (e.g. HUP) interrupts wait without any child exiting.
    [ -z "${done_pid:-}" ] && continue
    if [ "$done_pid" = "$broker" ]; then
      log error "broker exited; stopping" ",\"status\":$status"
      broker=
      kill -TERM "$host" 2>/dev/null
      wait "$host" 2>/dev/null
      exit "$status"
    fi
    host=
    # 75 = EXIT_DB_UNAVAILABLE in src/host/main.ts.
    if (( status == 75 )); then
      unset 'starts[-1]'
      starts=("${starts[@]}")
    fi
    recent=()
    for t in "${starts[@]}"; do (( SECONDS - t < window_s )) && recent+=("$t"); done
    starts=("${recent[@]}")
    # starts holds this run plus the restarts inside the window.
    if (( ${#starts[@]} > max_restarts )); then
      log error "fleet-host crash-looping; giving up" ",\"status\":$status,\"restarts\":$(( ${#starts[@]} - 1 ))"
      stop
      (( status == 0 )) && status=1
      exit "$status"
    fi
    (( status != 75 && ${#starts[@]} == 1 )) && delay_ms=$backoff_start_ms
    if (( status == 75 )); then
      log warn "fleet-host exited (db unavailable); restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    else
      log warn "fleet-host exited; restarting" ",\"status\":$status,\"delayMs\":$delay_ms"
    fi
    backoff_sleep
    if ! kill -0 "$broker" 2>/dev/null; then
      wait "$broker"
      status=$?
      log error "broker exited; stopping" ",\"status\":$status"
      exit "$status"
    fi
    start_host
  done
}

case "$mode" in
  host) run_host ;;
  workspace) run_workspace ;;
  prep) run_prep ;;
  single) run_single ;;
  *) log error "usage: fleet-host-entry host|workspace|prep|single"; exit 2 ;;
esac
```

- [ ] **Step 5: Run**

Run: `bash docker/host/fleet-host-entry.test.sh`
Expected: every line `ok:`, last line `ALL PASS`.

- [ ] **Step 6: SPEC.**
  - §4 *Host images*: replace the *Supervision* bullet's first sentence with "**Supervision** (`fleet-host-entry <mode>`; no mode exits 2). `single` runs the broker and fleet-host side by side under one uid and warns that it is for local and dev only:" and keep the rest of that bullet as `single`'s behaviour. Add after it:

```markdown
- **Split pod modes** (design `docs/superpowers/specs/2026-11-05-host-container-split-design.md`):
  - `prep` (initContainer, uid 1001): creates `$FLEET_PREP_RUN/sock` (3770, group `FLEET_RUN_GID`, default 1500) and copies `FLEET_PREP_KEY_SRC` to `FLEET_PREP_KEY_DST` as 0400; a missing key leaves the helper off.
  - `host` (uid 1001): refuses `FLEET_WORKSPACE_UID` (default 1000) and a `FLEET_RUN_DIR` (default `/run/fleet`) that isn't a real directory in the run group with group rwx and no access for others; defaults the two socket paths into it and sets `FLEET_HOST_CRED_SOCKET_GROUP`; checks the port before every start; restarts exit 75 with the doubling backoff and no give-up; any other exit ends the container with its status. SIGTERM/SIGINT and SIGHUP reach fleet-host.
  - `workspace` (uid 1000): refuses `CLAUDE_FLEET_BROKER_TCP_PORT`, checks the run dir, exports the socket paths and `CLAUDE_FLEET_BROKER_SOCKET_GROUP`, and execs the broker.
```

  - §7 *Exit codes*: replace "`fleet-host-entry` doesn't count it toward its give-up" with "`fleet-host-entry` restarts it in the container (no give-up in `single`, no Kubernetes restart in `host`)".
  - §9: replace the two bullets starting **Known risk: fleet-host, the broker and every claude session share uid 1000.** and **The shared uid also defeats the host's other controls.** with:

```markdown
- **In the split pod a session can't reach fleet-host's process, key or AWS identity.** fleet-host and the credential socket run in the host container as uid 1001; the broker and sessions run in the workspace container as uid 1000; there is no shared PID namespace, so a session can't signal, ptrace or read `/proc` of fleet-host. The App key is copied by `prep` into a memory emptyDir as 0400 uid 1001 and mounted only in the host container. Each container has its own web-identity token and role: the host's can only reach the DB, the workspace's only the read-only llm-bot roles. The two containers share only `/run/fleet` (3770, group 1500): `broker.sock` and `cred.sock`, both 0660.
- **Residual risks in the split pod.** Containers share the pod's network namespace, so a session can listen on `FLEET_HOST_PORT` while the host container is down; `fleet-host-entry host` then refuses to start and the pod goes unready, but connections routed during endpoint propagation can reach the squatter. A session can no longer cause that restart by killing fleet-host. Sessions also reach the Istio sidecar's localhost ports, and every session can read and signal every other session and the broker.
- **`single` mode keeps the shared uid.** Sessions can signal fleet-host, read its `/proc/<pid>` (environ, and memory where ptrace is allowed, which holds open sockets' raw tokens), read the App key, use the pod's AWS identity against the host DB, or kill fleet-host and listen on :8080. The port check before every start ends the container instead of starting onto a squatted port; nothing else is mitigated. Use it only for local and dev runs.
```

  Also in §9, replace "`fleet-host-entry` refuses to start with `CLAUDE_FLEET_BROKER_TCP_PORT` set" with "`fleet-host-entry workspace` and `single` refuse to start with `CLAUDE_FLEET_BROKER_TCP_PORT` set", and in §7 *GitHub App credentials* replace "It is not a boundary against a session while sessions share fleet-host's uid (§9)." with "It is a boundary against a session only in the split pod (§9)."

- [ ] **Step 7: Commit**

```bash
git -C "$W" add docker/host/fleet-host-entry docker/host/fleet-host-entry.test.sh docs/SPEC.md
git -C "$W" commit -m "feat(host): fleet-host-entry host, workspace, prep and single modes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Image users, smoke test and the split-pod container test

**Files:**
- Modify: `docker/host/Dockerfile`
- Modify: `docker/host/smoke.test.sh`
- Create: `docker/host/split.test.sh`
- Modify: `.github/workflows/test-runner-images.yml`
- Modify: `docs/SPEC.md` §4 *Host images* (env defaults, smoke bullet)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: users `fleet-host` (1001) and group `fleet-run` (1500) in the image; `split.test.sh <image>`.

- [ ] **Step 1: Dockerfile.** In the `RUN` after the `COPY` lines, append before `&& mkdir -p /etc/fleet-host /run/fleet-host \`:

```dockerfile
 && groupadd --gid 1500 fleet-run \
 && groupadd --gid 1001 fleet-host \
 && useradd --uid 1001 --gid 1001 --groups fleet-run --home-dir /var/lib/fleet-host/state --no-create-home --shell /usr/sbin/nologin fleet-host \
 && usermod -aG fleet-run fleet \
 && mkdir -p /run/fleet /var/lib/fleet-host/state /var/lib/fleet-host/projects \
```

Leave `USER fleet` and `CMD ["/usr/local/bin/fleet-host-entry"]` as they are: with no mode the script exits 2 (D1).

- [ ] **Step 2: Smoke test.** In `docker/host/smoke.test.sh`, change the `docker run -d …` line to end `"$image" fleet-host-entry single)`, and add after the `trap` line:

```bash
rc=0; docker run --rm "$image" >/dev/null 2>&1 || rc=$?
test "$rc" = 2
test "$(docker run --rm --entrypoint id "$image" -u fleet-host)" = 1001
docker run --rm --entrypoint getent "$image" group fleet-run | grep -q '^fleet-run:x:1500:'
```

Update its header comment to "…uid 1000 under `single`, the no-mode refusal, the `fleet-host` user…".

- [ ] **Step 3: Write `docker/host/split.test.sh`:**

```bash
#!/usr/bin/env bash
# Emulates the split pod with plain docker: prep, then host and workspace
# sharing a pause container's network namespace, each in its own PID namespace.
set -euo pipefail
image=$1
tmp=$(mktemp -d)
n=split-$$
ids=()
cleanup() {
  for c in "${ids[@]}"; do docker logs "$c" 2>&1 | tail -20 || true; docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker run --rm -u 0 -v "$tmp:/t" --entrypoint sh "$image" -c 'rm -rf /t/*' >/dev/null 2>&1 || true
  rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT
refuse() { if "$@" >/dev/null 2>&1; then echo "FAIL: allowed: $*"; exit 1; fi; }

mkdir -p "$tmp"/{run,key,secret,cfg,projects,state}
chmod 0777 "$tmp/run" "$tmp/key" "$tmp/state"
openssl genrsa -out "$tmp/secret/key.pem" 2048 2>/dev/null
chmod 0444 "$tmp/secret/key.pem"
cat > "$tmp/cfg/config.yaml" <<'YAML'
workspace: { name: split }
grants:
  - { team: acme/platform, tier: session }
github: { appId: 1, installationId: 2, keyFile: /var/run/secrets/github-app/key.pem }
YAML
chmod -R a+rX "$tmp/cfg" "$tmp/projects"

docker run --rm -u 1001:1001 --group-add 1500 --read-only \
  -v "$tmp/run:/prep/run" -v "$tmp/secret:/prep/secret:ro" -v "$tmp/key:/prep/key" \
  "$image" fleet-host-entry prep

pod=$(docker run -d --name "$n-pod" -p 127.0.0.1::8080 --entrypoint sleep "$image" infinity); ids+=("$pod")
host=$(docker run -d --name "$n-host" --network "container:$pod" -u 1001:1001 --group-add 1500 --read-only --tmpfs /tmp \
  -e FLEET_HOST_STATE=/var/lib/fleet-host/state -e FLEET_HOST_PROJECTS=/var/lib/fleet-host/projects -e HOME=/var/lib/fleet-host/state \
  -v "$tmp/cfg:/etc/fleet-host:ro" -v "$tmp/key:/var/run/secrets/github-app:ro" -v "$tmp/run/sock:/run/fleet" \
  -v "$tmp/projects:/var/lib/fleet-host/projects:ro" -v "$tmp/state:/var/lib/fleet-host/state" \
  "$image" fleet-host-entry host); ids+=("$host")
ws=$(docker run -d --name "$n-ws" --network "container:$pod" -u 1000:1000 --group-add 1500 \
  -v "$tmp/run/sock:/run/fleet" "$image" fleet-host-entry workspace); ids+=("$ws")
port=$(docker port "$pod" 8080/tcp | head -1 | sed 's/.*://')

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null | grep -q '"lease":"holder"' && return 0
    sleep 1
  done
  return 1
}
healthy
for _ in $(seq 1 30); do
  docker exec "$ws" test -S /run/fleet/broker.sock && docker exec "$ws" test -S /run/fleet/cred.sock && break
  sleep 1
done

# The shared dir and its two sockets.
test "$(docker exec "$ws" stat -c '%a %g' /run/fleet)" = "3770 1500"
test "$(docker exec "$ws" stat -c '%a %g %u' /run/fleet/broker.sock)" = "660 1500 1000"
test "$(docker exec "$ws" stat -c '%a %g %u' /run/fleet/cred.sock)" = "660 1500 1001"
test "$(docker exec "$ws" ls /run/fleet | sort | tr '\n' ' ')" = "broker.sock cred.sock "

# Each side reaches the other's socket; a session can't remove cred.sock.
docker exec "$ws" node -e "require('http').request({socketPath:'/run/fleet/cred.sock',method:'POST',path:'/token',headers:{'content-type':'application/json'}},r=>{console.log(r.statusCode);r.resume()}).end('{}')" | grep -qE '^4[0-9][0-9]$'
docker exec "$host" node -e "require('net').connect('/run/fleet/broker.sock').on('connect',function(){console.log('ok');this.destroy()}).on('error',e=>{console.log(e.code);process.exitCode=1})" | grep -qx ok
refuse docker exec "$ws" rm -f /run/fleet/cred.sock
docker exec "$ws" test -S /run/fleet/cred.sock

# Isolation: the key, fleet-host's /proc and its process.
test "$(docker exec "$host" stat -c '%a %u' /var/run/secrets/github-app/key.pem)" = "400 1001"
refuse docker exec -u 1000:1000 "$host" cat /var/run/secrets/github-app/key.pem
host_pid=$(docker exec "$host" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null | grep -q "fleet-host[.]mjs" && { echo ${p#/proc/}; break; }; done')
test -n "$host_pid"
docker exec "$host" test -r "/proc/$host_pid/environ"
refuse docker exec -u 1000:1000 "$host" cat "/proc/$host_pid/environ"
docker exec "$ws" test ! -e /var/run/secrets/github-app/key.pem
refuse docker exec "$ws" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n" | grep -q "fleet-host[.]mjs"'

# A host container restart leaves the workspace container and its broker alone.
ws_pid=$(docker inspect -f '{{.State.Pid}}' "$ws")
ino=$(docker exec "$ws" stat -c %i /run/fleet/broker.sock)
docker restart -t 15 "$host" >/dev/null
healthy
test "$(docker inspect -f '{{.State.Running}} {{.State.Pid}}' "$ws")" = "true $ws_pid"
test "$(docker exec "$ws" stat -c %i /run/fleet/broker.sock)" = "$ino"
docker logs "$host" 2>&1 | grep -q '"msg":"shutting down"'
echo "runner-host split pod: OK"
```

- [ ] **Step 4: Workflow.** In `.github/workflows/test-runner-images.yml`, after the *Smoke host image* step:

```yaml
      - name: Split-pod test
        run: bash docker/host/split.test.sh claude-fleet/runner-host:test
```

- [ ] **Step 5: Run locally if Docker is available, else in CI.**

Run (with Docker): `docker build -f docker/host/Dockerfile --build-arg BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest -t claude-fleet/runner-host:test . && bash docker/host/smoke.test.sh claude-fleet/runner-host:test && bash docker/host/split.test.sh claude-fleet/runner-host:test`
Expected: `runner-host smoke: OK`, `runner-host split pod: OK`. There is no Docker daemon in a claude-fleet workspace container; then push and read the `test-runner-images` job (`gh run watch`).

- [ ] **Step 6: SPEC.** §4 *Host images*:
  - Env defaults bullet: append "; users `fleet` (1000) and `fleet-host` (1001, home `/var/lib/fleet-host/state`), group `fleet-run` (1500, both users)".
  - Smoke bullet: replace "uid 1000" with "uid 1000 under `single`, the no-mode refusal, the `fleet-host` user" and append "`docker/host/split.test.sh` emulates the split pod with plain `docker run` (a pause container's netns, separate PID namespaces, `--group-add 1500`): socket modes, cross-container reach, the key and `/proc` refused to uid 1000, and a host restart that leaves the broker running. `test-runner-images.yml` runs it after the smoke test."

  - Delete §11 *Host container split* (now in the body).

- [ ] **Step 7: Commit**

```bash
git -C "$W" add docker/host/Dockerfile docker/host/smoke.test.sh docker/host/split.test.sh .github/workflows/test-runner-images.yml docs/SPEC.md
git -C "$W" commit -m "feat(host): fleet-host user and split-pod container test

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Gate, PR, infra handoff

**Files:** none new.

- [ ] **Step 1: Full gate**

Run, each separately: `npx vitest run src/host/`, `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npx tsc --noEmit -p tsconfig.host.json`, `(cd broker && go test -race ./...)`, `bash docker/host/fleet-host-entry.test.sh`, `bash docker/host/gh.test.sh`.
Expected: all pass.

- [ ] **Step 2: PR.** Push the branch and open one PR (factual body: what changed per task, the new env vars, that the image `CMD` now needs a mode, test commands, and that platform-ops#36 must switch to `args: ["fleet-host-entry", …]` with the spec §4 pod spec before it takes the new image). End the body with the Claude Code footer. `gh pr merge --auto --squash`.

- [ ] **Step 3: Infra handoff.** Append an entry to `/shared/remote-agent-design/threads/001-kickoff.md` with the PR URL, the image digest once published, and the spec §4 pod spec. Call out: (a) the current CMD-only pod spec stops working on the new image (exit 2) until #36 adds a mode; (b) the `migrate` Job needs the host's projected token and `AWS_ROLE_ARN` once Pod Identity is removed; (c) `fsGroup: 1000` is removed; (d) `FLEET_HOST_STATE` moves off EFS.
