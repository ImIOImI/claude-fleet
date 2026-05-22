import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type {
  FleetContainer,
  CreateContainerSpec,
  PullProgress,
  RemoveContainerOpts,
  PtyHandle
} from './docker.js';

const containers = new Map<string, FleetContainer>();

function seed(): void {
  const now = Date.now();
  containers.set('mock-alpha-id', {
    id: 'mock-alpha-id',
    name: 'mock-alpha',
    state: 'running',
    status: 'Up 1 hour',
    workspaceSubdir: '',
    profile: 'oauth',
    createdAt: now - 3600_000
  });
  containers.set('mock-beta-id', {
    id: 'mock-beta-id',
    name: 'mock-beta',
    state: 'exited',
    status: 'Exited (0) 2 minutes ago',
    workspaceSubdir: 'frontend',
    profile: 'default',
    createdAt: now - 7200_000
  });
}
seed();

export async function ping(): Promise<boolean> {
  return true;
}

export async function ensureImage(onProgress: (p: PullProgress) => void): Promise<void> {
  onProgress({ message: 'mock: runner image already present' });
}

export async function listContainers(): Promise<FleetContainer[]> {
  return Array.from(containers.values());
}

export async function createContainer(spec: CreateContainerSpec): Promise<FleetContainer> {
  const id = `mock-${randomUUID().slice(0, 8)}`;
  const ct: FleetContainer = {
    id,
    name: spec.name,
    state: 'running',
    status: 'Up just now',
    workspaceSubdir: spec.workspaceSubdir,
    profile: spec.profile,
    createdAt: Date.now()
  };
  containers.set(id, ct);
  return ct;
}

export async function stopContainer(id: string): Promise<void> {
  const ct = containers.get(id);
  if (ct) {
    ct.state = 'exited';
    ct.status = 'Exited (0) just now';
  }
}

export async function removeContainer(id: string, _opts: RemoveContainerOpts = {}): Promise<void> {
  containers.delete(id);
}

class FakeShell extends Duplex {
  private lineBuf = '';
  private readonly prompt = '\x1b[32m>\x1b[0m ';

  constructor(private readonly containerName: string) {
    super();
    setTimeout(() => this.greet(), 150);
  }

  private greet(): void {
    this.push('\x1b[1;36mclaude-fleet mock terminal\x1b[0m\r\n');
    this.push(`container: ${this.containerName}\r\n`);
    this.push("Type 'help' to see available mock commands.\r\n\r\n");
    this.push(this.prompt);
  }

  _read(_size: number): void {
    /* push-driven; no-op */
  }

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const ch of str) {
      if (ch === '\r' || ch === '\n') {
        this.push('\r\n');
        this.runCmd(this.lineBuf.trim());
        this.lineBuf = '';
        this.push(this.prompt);
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
      return;
    }
    if (cmd === 'clear') {
      this.push('\x1b[2J\x1b[H');
      return;
    }
    if (cmd === 'whoami') {
      this.push(`claude (mock, container=${this.containerName})\r\n`);
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
  const ct = containers.get(containerId);
  const shell = new FakeShell(ct?.name ?? containerId);
  return {
    stream: shell,
    resize: async () => undefined,
    detach: () => shell.destroy()
  };
}
