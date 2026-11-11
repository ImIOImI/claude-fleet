// Against the real Go broker, with `cat` standing in for claude. Runs only when
// FLEET_BROKER_BIN points at a built broker (CI's unit job sets it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameType } from '../main/broker.js';
import { AttachHub } from './attachHub.js';
import { brokerOps } from './brokerOps.js';
import { inputFrame, jsonFrame, person, sinkRecorder } from './testFakes.js';

const BIN = process.env.FLEET_BROKER_BIN;

describe.runIf(BIN)('fleet-host against the real broker', () => {
  let proc: ChildProcess;
  let socket: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-broker-'));
    socket = join(dir, 'broker.sock');
    const fake = join(dir, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nexec cat\n');
    chmodSync(fake, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_FLEET_BROKER_SOCKET: socket, CLAUDE_FLEET_BROKER_CLAUDE: fake };
    delete env.CLAUDE_FLEET_BROKER_TCP_PORT;
    proc = spawn(BIN!, [], { env, stdio: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(() => {
    proc?.kill();
  });

  it('CREATE, two viewers, steer input echoes to both, read input is dropped', async () => {
    const hub = new AttachHub(brokerOps(socket));
    const a = sinkRecorder();
    const b = sinkRecorder();
    const owner = hub.viewer({ identity: person('owner', 1), tier: 'session' }, a.sink);
    const watcher = hub.viewer({ identity: person('watcher', 2), tier: 'read' }, b.sink);
    await owner.receive(jsonFrame(FrameType.CREATE, { id: 'it1', cols: 80, rows: 24 }));
    expect(a.frames.at(-1)?.json).toMatchObject({ ok: true });
    await owner.receive(jsonFrame(FrameType.ATTACH, { id: 'it1', channel: 1 }));
    await watcher.receive(jsonFrame(FrameType.ATTACH, { id: 'it1', channel: 9 }));
    await watcher.receive(inputFrame(9, 'from-watcher\r'));
    await owner.receive(inputFrame(1, 'from-owner\r'));
    const text = (r: ReturnType<typeof sinkRecorder>) =>
      r.frames.filter((f) => f.type === FrameType.OUTPUT || f.type === FrameType.HISTORY).map((f) => String(f.body)).join('');
    await expect.poll(() => text(b), { timeout: 5000 }).toContain('from-owner');
    expect(text(a)).toContain('from-owner');
    expect(text(a) + text(b)).not.toContain('from-watcher');
    await owner.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(a.frames.at(-1)?.json).toMatchObject({ ok: true });
    await watcher.dispose();
  });
});

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.runIf(BIN)('fleet-host against the real broker on TCP behind the mesh guard', () => {
  let proc: ChildProcess;
  let ready: HttpServer;
  let port = 0;
  let dir: string;

  beforeAll(async () => {
    ready = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => ready.listen(0, '127.0.0.1', () => r()));
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'fh-broker-tcp-'));
    const fake = join(dir, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nexec cat\n');
    chmodSync(fake, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_FLEET_BROKER_TCP_PORT: String(port),
      CLAUDE_FLEET_BROKER_REQUIRE_MESH: '1',
      FLEET_MESH_READY_URL: `http://127.0.0.1:${(ready.address() as AddressInfo).port}/healthz/ready`,
      CLAUDE_FLEET_BROKER_CLAUDE: fake
    };
    proc = spawn(BIN!, [], { env, stdio: 'ignore' });
    const ops = brokerOps({ host: '127.0.0.1', port });
    for (let i = 0; i < 50; i++) {
      try {
        await ops.list();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`broker did not come up on :${port}`);
  });

  afterAll(() => {
    proc?.kill();
    ready?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and lists a session over TCP', async () => {
    const ops = brokerOps({ host: '127.0.0.1', port });
    expect(await ops.create('tcp1', 80, 24, [])).toMatchObject({ ok: true });
    expect(await ops.list()).toContainEqual(expect.objectContaining({ id: 'tcp1', alive: true }));
  });
});
