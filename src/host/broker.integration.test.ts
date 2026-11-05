// Against the real Go broker, with `cat` standing in for claude. Runs only when
// FLEET_BROKER_BIN points at a built broker (CI's unit job sets it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
