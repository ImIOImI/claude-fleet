import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type {
  CreateWorkspaceInput,
  PullProgress,
  RemoveWorkspaceOpts,
  PtyHandle
} from './docker.js';
import type { Workspace } from './workspaces.js';

const workspaces = new Map<string, Workspace>();

function seed(): void {
  const now = Date.now();
  workspaces.set('mock-alpha-id', {
    name: 'mock-alpha',
    workspaceRoot: '/tmp/mock-alpha',
    workspaceSubdir: '',
    profile: 'oauth',
    kind: 'container',
    image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    createdAt: now - 3600_000,
    lastUsedAt: now - 1800_000,
    state: 'running',
    containerId: 'mock-alpha-id',
    status: 'Up 1 hour'
  });
  workspaces.set('mock-beta-id', {
    name: 'mock-beta',
    workspaceRoot: '/tmp/mock-beta',
    workspaceSubdir: 'frontend',
    profile: 'default',
    kind: 'container',
    image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    createdAt: now - 7200_000,
    lastUsedAt: now - 7200_000,
    state: 'stopped',
    containerId: 'mock-beta-id',
    status: 'Exited (0) 2 minutes ago'
  });
}
seed();

export async function ping(): Promise<boolean> {
  return true;
}

export async function ensureImage(onProgress: (p: PullProgress) => void): Promise<void> {
  onProgress({ message: 'mock: runner image already present' });
}

export async function listLiveWorkspaces(): Promise<Workspace[]> {
  return Array.from(workspaces.values());
}

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  const id = `mock-${randomUUID().slice(0, 8)}`;
  const ws: Workspace = {
    name: spec.name,
    workspaceRoot: spec.workspaceRoot,
    workspaceSubdir: spec.workspaceSubdir,
    profile: spec.profile,
    kind: 'container',
    image: spec.image ?? 'ghcr.io/imioimi/claude-fleet/runner:latest',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: 'running',
    containerId: id,
    status: 'Up just now'
  };
  workspaces.set(id, ws);
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

export async function startWorkspace(name: string): Promise<string | null> {
  for (const [id, ws] of workspaces) {
    if (ws.name === name) {
      ws.state = 'running';
      ws.status = 'Up just now';
      ws.lastUsedAt = Date.now();
      return id;
    }
  }
  return null;
}

export async function pauseWorkspace(id: string): Promise<void> {
  const ws = workspaces.get(id);
  if (ws && ws.state === 'running') {
    ws.state = 'paused';
    ws.status = 'Paused (was running)';
  }
}

export async function stopWorkspace(id: string): Promise<void> {
  const ws = workspaces.get(id);
  if (ws) {
    ws.state = 'stopped';
    ws.status = 'Exited (0) just now';
  }
}

export async function removeWorkspace(id: string, _opts: RemoveWorkspaceOpts = {}): Promise<void> {
  workspaces.delete(id);
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

  constructor(private readonly workspaceName: string) {
    super();
    setTimeout(() => this.greet(), 150);
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
      this.push('  exit          end the session (shows the restart overlay)\r\n');
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
    if (cmd.startsWith('echo ')) {
      this.push(cmd.slice(5) + '\r\n');
      return;
    }
    this.push(`mock: unknown command '${cmd}' (try 'help')\r\n`);
  }
}

export async function attachPty(
  containerId: string,
  _cols: number,
  _rows: number
): Promise<PtyHandle> {
  const ws = workspaces.get(containerId);
  const shell = new FakeShell(ws?.name ?? containerId);
  return {
    stream: shell,
    resize: async () => undefined,
    detach: () => shell.destroy()
  };
}
