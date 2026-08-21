import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPtyCapture, captureDir } from './ptyCapture';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptycap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_FLEET_CAPTURE_PTY;
});

const base = { handleId: 'h1', workspaceId: 'ws1', brokerSessionId: 'bs1', cols: 107, rows: 45 };

/** The sink is a WriteStream, so give the flush a beat before reading. */
async function readCapture(d: string): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 40; i++) {
    const files = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')) : [];
    if (files.length) {
      const txt = readFileSync(join(d, files[0]), 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      if (lines.length) return lines.map((l) => JSON.parse(l));
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

describe('ptyCapture (#268 diagnostics)', () => {
  it('is off by default — no env var, no capture, no files', async () => {
    expect(captureDir()).toBeNull();
    expect(createPtyCapture({ ...base })).toBeNull();
  });

  it('is off when the env var is empty or whitespace', () => {
    process.env.CLAUDE_FLEET_CAPTURE_PTY = '   ';
    expect(captureDir()).toBeNull();
    expect(createPtyCapture({ ...base })).toBeNull();
  });

  it('records the spawn geometry in an open event', async () => {
    const cap = createPtyCapture({ ...base, dir })!;
    expect(cap).not.toBeNull();
    cap.close();
    const ev = await readCapture(dir);
    expect(ev[0]).toMatchObject({
      k: 'open',
      cols: 107,
      rows: 45,
      workspaceId: 'ws1',
      brokerSessionId: 'bs1'
    });
  });

  it('records data chunks as base64, byte-exact', async () => {
    const cap = createPtyCapture({ ...base, dir })!;
    // Deliberately includes a multi-byte sequence split across chunks, the
    // case a naive string capture would corrupt.
    const utf8 = Buffer.from('⏵ accept edits');
    cap.data(utf8.subarray(0, 2));
    cap.data(utf8.subarray(2));
    cap.close();

    const ev = await readCapture(dir);
    const chunks = ev.filter((e) => e.k === 'data').map((e) => Buffer.from(e.b64 as string, 'base64'));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('⏵ accept edits');
    expect(cap.bytes).toBe(utf8.length);
  });

  it('records the resize timeline', async () => {
    const cap = createPtyCapture({ ...base, dir })!;
    cap.resize(115, 45);
    cap.resize(120, 50);
    cap.close();

    const ev = await readCapture(dir);
    expect(ev.filter((e) => e.k === 'resize')).toEqual([
      expect.objectContaining({ k: 'resize', cols: 115, rows: 45 }),
      expect.objectContaining({ k: 'resize', cols: 120, rows: 50 })
    ]);
  });

  it('stamps every event with a monotonic offset from open', async () => {
    let t = 1000;
    const cap = createPtyCapture({ ...base, dir, now: () => t })!;
    t = 1250;
    cap.data(Buffer.from('x'));
    t = 1600;
    cap.resize(90, 30);
    cap.close();

    const ev = await readCapture(dir);
    expect(ev.map((e) => e.t)).toEqual([0, 250, 600, 600]);
  });

  it('caps data volume but keeps recording geometry', async () => {
    const cap = createPtyCapture({ ...base, dir, maxBytes: 10 })!;
    cap.data(Buffer.alloc(8, 0x61));
    cap.data(Buffer.alloc(8, 0x62)); // would exceed the cap -> dropped
    cap.resize(115, 45); // geometry still matters after the cap
    cap.close();

    const ev = await readCapture(dir);
    expect(ev.filter((e) => e.k === 'data')).toHaveLength(1);
    expect(ev.some((e) => e.k === 'capped')).toBe(true);
    expect(ev.some((e) => e.k === 'resize')).toBe(true);
    expect(cap.bytes).toBe(8);
  });

  it('writes nothing more after close', async () => {
    const cap = createPtyCapture({ ...base, dir })!;
    cap.close();
    cap.data(Buffer.from('late'));
    cap.resize(1, 1);

    const ev = await readCapture(dir);
    expect(ev.filter((e) => e.k === 'data')).toHaveLength(0);
    expect(ev[ev.length - 1]).toMatchObject({ k: 'close' });
  });

  it('keeps hostile ids inside the capture directory', async () => {
    const cap = createPtyCapture({
      ...base,
      dir,
      handleId: '../../escape',
      workspaceId: '../../../etc'
    })!;
    cap.close();
    await readCapture(dir);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('..');
  });
});
