import { Duplex } from 'node:stream';
import { rm } from 'node:fs/promises';
import type {
  CreateWorkspaceInput,
  PullProgress,
  RemoveWorkspaceOpts,
  PtyHandle
} from './docker.js';
import { workspaceStateDir } from './paths.js';
import type { Workspace } from './workspaces.js';
import { FACTORY_MIRROR } from './workspaces.js';

// In mock mode the workspace id doubles as the containerId. Real backend
// uses `cf-<id>` for the docker name, but lookups are by label so the
// renderer never sees the prefix either way.
const workspaces = new Map<string, Workspace>();

function seed(): void {
  const now = Date.now();
  workspaces.set('01MOCKALPHA000000000000000', {
    id: '01MOCKALPHA000000000000000',
    name: 'mock-alpha',
    labels: ['dev'],
    workspaceRoot: '/tmp/mock-alpha',
    workspaceSubdir: '',
    kind: 'container',
    image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    createdAt: now - 3600_000,
    lastUsedAt: now - 1800_000,
    mirror: FACTORY_MIRROR,
    state: 'running',
    containerId: '01MOCKALPHA000000000000000',
    status: 'Up 1 hour'
  });
  workspaces.set('01MOCKBETA0000000000000000', {
    id: '01MOCKBETA0000000000000000',
    name: 'mock-beta',
    labels: [],
    workspaceRoot: '/tmp/mock-beta',
    workspaceSubdir: 'frontend',
    kind: 'container',
    image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    createdAt: now - 7200_000,
    lastUsedAt: now - 7200_000,
    mirror: FACTORY_MIRROR,
    state: 'running',
    containerId: '01MOCKBETA0000000000000000',
    status: 'Up 2 hours'
  });
  // `fail-*` workspaces simulate the broker-socket-missing failure mode
  // (stale runner image, pre-broker). attachPty throws synchronously for
  // these so Playwright can assert the attach-error overlay surfaces the
  // diagnostic message instead of hiding it behind the generic "session
  // ended" card.
  workspaces.set('01MOCKFAIL0000000000000000', {
    id: '01MOCKFAIL0000000000000000',
    name: 'fail-broker-missing',
    labels: [],
    workspaceRoot: '/tmp/mock-fail',
    workspaceSubdir: '',
    kind: 'container',
    image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    createdAt: now - 60_000,
    lastUsedAt: now - 60_000,
    mirror: FACTORY_MIRROR,
    state: 'running',
    containerId: '01MOCKFAIL0000000000000000',
    status: 'Up 1 minute'
  });
}
seed();

export async function ping(): Promise<boolean> {
  return true;
}

export async function ensureImage(
  onProgress: (p: PullProgress) => void,
  imageRef?: string
): Promise<void> {
  const ref = imageRef?.trim();
  onProgress({ message: ref ? `mock: ensured ${ref}` : 'mock: runner image already present' });
}

export async function listLiveWorkspaces(): Promise<Workspace[]> {
  return Array.from(workspaces.values());
}

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  const isLocal = spec.kind === 'local';
  const ws: Workspace = {
    id: spec.id,
    name: spec.name,
    labels: [],
    // Local honors the user-chosen host dir; container gets a mock fleet path.
    workspaceRoot: isLocal ? spec.workspaceRoot ?? '/tmp/mock-local' : `/tmp/mock-fleet/${spec.id}`,
    workspaceSubdir: spec.workspaceSubdir,
    kind: isLocal ? 'local' : 'container',
    image: isLocal ? undefined : spec.image ?? 'ghcr.io/imioimi/claude-fleet/runner:latest',
    authMode: spec.authMode,
    env: spec.env,
    resources: spec.resources,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    mirror: FACTORY_MIRROR,
    state: 'running',
    containerId: spec.id,
    status: 'Up just now'
  };
  workspaces.set(spec.id, ws);
  return ws;
}

/**
 * Mock inspect — returns a static label set for any ref so the image
 * library has something to record in mock mode.
 */
export async function inspectImage(ref: string): Promise<{
  ref: string;
  digest?: string;
  labels: Record<string, string>;
}> {
  return {
    ref,
    digest: 'sha256:mock0000mock0000mock0000mock0000mock0000mock0000mock0000mock0000',
    labels: {
      'org.opencontainers.image.source': 'https://github.com/ImIOImI/claude-fleet',
      'com.claude-fleet.kind': 'runner',
      'com.claude-fleet.language': 'node'
    }
  };
}

export async function startWorkspace(id: string): Promise<string | null> {
  const ws = workspaces.get(id);
  if (!ws) return null;
  ws.state = 'running';
  ws.status = 'Up just now';
  ws.lastUsedAt = Date.now();
  return ws.containerId ?? id;
}

export async function isResumeImageStale(): Promise<boolean> {
  // No registry in mock mode — resume never forces a recreate.
  return false;
}

export async function pauseWorkspace(containerId: string): Promise<void> {
  const ws = workspaces.get(containerId);
  if (!ws) return;
  // Match the real backend's idempotent `docker pause` semantics explicitly:
  //   running → paused   (the only real transition)
  //   paused  → paused   (no-op; already frozen)
  //   stopped → paused   (no-op; docker returns 409, treated as no-op)
  // Making the no-ops explicit stops a renderer bug that assumes a state
  // change always happens from passing against the mock yet failing in prod.
  if (ws.state === 'running') {
    ws.state = 'paused';
    ws.status = 'Paused (was running)';
  }
}

export async function stopWorkspace(containerId: string): Promise<void> {
  const ws = workspaces.get(containerId);
  if (ws) {
    ws.state = 'stopped';
    ws.status = 'Exited (0) just now';
  }
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  // In mock the map is keyed by id (== containerId for live mock entries).
  // A saved workspace isn't in the map at all; its only trace is the on-disk
  // manifest, so honor deleteState by wiping the state dir keyed off the ULID.
  const id = opts.id || containerId;
  if (containerId) workspaces.delete(containerId);
  if (opts.id) workspaces.delete(opts.id);
  if (opts.deleteState && id) {
    await rm(workspaceStateDir(id), { recursive: true, force: true });
  }
}

class FakeShell extends Duplex {
  private lineBuf = '';
  private readonly prompt = '\x1b[32m>\x1b[0m ';
  // `exit`/`quit` end the readable side via push(null). Without gating
  // subsequent pushes (e.g., the prompt that would otherwise be written
  // right after runCmd returns), we'd push after end — which Node treats
  // as an error and which would suppress the 'end' event the renderer
  // is waiting on. Underscored to avoid the type collision with Duplex's
  // own public `closed` property.
  private _closed = false;

  constructor(
    private readonly workspaceName: string,
    private cols = 80
  ) {
    super();
    setTimeout(() => this.greet(), 150);
  }

  /** Mirrors pty resize so width-sensitive commands (`wide`) emit rows at
   *  the terminal's true current width, like a real TUI would. */
  setCols(cols: number): void {
    if (cols > 0) this.cols = cols;
  }

  private greet(): void {
    if (this._closed) return;
    this.push('\x1b[1;36mclaude-fleet mock terminal\x1b[0m\r\n');
    this.push(`workspace: ${this.workspaceName}\r\n`);
    this.push("Type 'help' to see available mock commands.\r\n\r\n");
    this.push(this.prompt);
  }

  _read(_size: number): void {
    /* push-driven; no-op */
  }

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this._closed) {
      cb();
      return;
    }
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const ch of str) {
      if (this._closed) break;
      if (ch === '\r' || ch === '\n') {
        this.push('\r\n');
        this.runCmd(this.lineBuf.trim());
        this.lineBuf = '';
        if (!this._closed) this.push(this.prompt);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuf.length > 0) {
          this.lineBuf = this.lineBuf.slice(0, -1);
          this.push('\b \b');
        }
      } else if (ch === '\x03') {
        this.lineBuf = '';
        this.push('^C\r\n');
        this.push(this.prompt);
      } else if (ch >= ' ') {
        this.lineBuf += ch;
        this.push(ch);
      }
    }
    cb();
  }

  private runCmd(cmd: string): void {
    if (!cmd) return;
    if (cmd === 'help') {
      this.push('Mock shell commands:\r\n');
      this.push('  help          show this list\r\n');
      this.push('  clear         clear the screen\r\n');
      this.push('  echo <text>   print text\r\n');
      this.push('  whoami        print the fake claude identity\r\n');
      this.push('  oauth         simulate a Claude.ai OAuth login URL print\r\n');
      this.push('  emoji         print a sample line with keycap + flag + ZWJ emoji\r\n');
      this.push('  wide <n>      print n rows exactly terminal-width wide (reflow repro)\r\n');
      this.push('  exit          end the session (shows the restart overlay)\r\n');
      return;
    }
    if (cmd === 'emoji') {
      // Mix of grapheme-cluster classes that historically tripped xterm:
      // keycap (digit + VS-16 + combining enclosing keycap), regional
      // indicators (flag), ZWJ-joined family + skin-tone modifier, and
      // a single-codepoint wide CJK char as a sanity check.
      this.push('Sample: 1️⃣ 2️⃣ — flags 🇺🇸 ');
      this.push('— family 👨‍👩‍👧 ');
      this.push('— wave 👋🏽 — CJK 漢字\r\n');
      return;
    }
    if (cmd === 'clear') {
      this.push('\x1b[2J\x1b[H');
      return;
    }
    if (cmd === 'whoami') {
      this.push(`claude (mock, workspace=${this.workspaceName})\r\n`);
      return;
    }
    if (cmd === 'exit' || cmd === 'quit') {
      // Simulate the real claude CLI exiting — closes the duplex so the
      // pty.onEnd listener in TerminalPane fires the "session ended"
      // overlay, the same way `/exit` does inside a real container.
      this.push('exiting…\r\n');
      this._closed = true;
      this.push(null);
      return;
    }
    if (cmd === 'oauth') {
      // Realistic-shaped Claude.ai OAuth URL. Definitely wraps at 80 cols;
      // exercises the multi-line link provider in TerminalPane.
      const url =
        'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-mock-test' +
        '&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2F' +
        'callback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=' +
        '7Z9q4R3xLgPmK2vN8wB6tY1uH5sD0fA-mockChallenge_aBcDeFgHiJ&code_challenge_method=S256' +
        '&state=mock-state-token-9c8b7a6d5e4f3210fedcba9876543210abcdef1234567890';
      this.push('Browse to the following URL and paste the code Claude.ai gives you:\r\n\r\n');
      this.push(`  ${url}\r\n\r\n`);
      this.push('Paste code: ');
      return;
    }
    if (cmd.startsWith('wide')) {
      // Full-width rows that are NOT genuinely wrapped — the shape Claude's
      // Ink TUI leaves in scrollback, and the input xterm's resize reflow
      // corrupts (#330). Row starts are marked `row-`, the fill is `x`, the
      // tail is `####`; the reflow e2e asserts no rendered line ever starts
      // with a fill/tail fragment.
      const n = Math.min(parseInt(cmd.slice(4).trim(), 10) || 20, 500);
      for (let i = 0; i < n; i++) {
        const head = `row-${String(i).padStart(3, '0')} `.padEnd(Math.max(this.cols - 4, 10), 'x');
        this.push(`${head}####\r\n`);
      }
      return;
    }
    if (cmd.startsWith('echo ')) {
      this.push(cmd.slice(5) + '\r\n');
      return;
    }
    this.push(`mock: unknown command '${cmd}' (try 'help')\r\n`);
  }
}

export async function attachPty(
  containerId: string,
  _sessionId: string,
  cols: number,
  _rows: number,
  _resumeOf?: string
): Promise<PtyHandle> {
  // Mock mode doesn't run a real broker — sessionId is accepted so the
  // signature matches the real backend, but each attach gets a fresh
  // FakeShell instead of looking up a persistent broker session. The
  // mock's whole point is iterating on UI without the runner image
  // plumbing, so the in-memory-context-preserved promise is naturally
  // out of scope here.
  const ws = workspaces.get(containerId);
  // Workspaces whose name starts with `fail-` simulate the real-world
  // "stale runner image, broker socket missing" failure mode (the bug
  // surfaced by the empty docker-logs investigation). Lets Playwright
  // assert the TerminalSession overlay actually surfaces the error
  // message instead of masking it behind the generic "session ended"
  // card.
  if (ws?.name?.startsWith('fail-')) {
    throw new Error(
      `broker socket not reachable at /mock/${ws.name}/broker.sock: ENOENT. ` +
        `Is the runner image new enough to include the broker?`
    );
  }
  const shell = new FakeShell(ws?.name ?? containerId, cols);
  return {
    stream: shell,
    resize: async (c: number) => shell.setCols(c),
    detach: () => shell.destroy(),
    close: async () => {
      shell.destroy();
    }
  };
}

/**
 * Mock has no real broker container, so there are no logs to surface.
 * Returns empty so `ipc.ts` doesn't have to branch on mode.
 */
export async function getBrokerLogs(_containerId: string, _tailLines?: number): Promise<string> {
  return '';
}

/** Mock committee post (#120): no broker, so just acknowledge for a known
 *  workspace. Lets the authorization + dispatch path be exercised in mock
 *  e2e; the real broker round-trip is docker-only. */
export async function committeePost(
  workspaceId: string,
  _text: string
): Promise<{ brokerSessionId: string }> {
  if (!workspaces.get(workspaceId)) throw new Error(`no such workspace ${workspaceId}`);
  return { brokerSessionId: `mock-broker-${workspaceId}` };
}
