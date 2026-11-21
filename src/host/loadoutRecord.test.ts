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
    ['a missing field', JSON.stringify({ version: 1, loadouts: [{ id: 'demo' }] }), `${RECORD_PATH} is malformed`],
    ['a non-string id', JSON.stringify({ version: 1, loadouts: [rec({ id: 7 as unknown as string })] }), `${RECORD_PATH} is malformed`],
    ['files that are a string', JSON.stringify({ version: 1, loadouts: [rec({ files: 'abc' as unknown as string[] })] }), `${RECORD_PATH} is malformed`],
    ['a hook without an event', JSON.stringify({ version: 1, loadouts: [rec({ hooks: [{ entry: 1 } as unknown as PinnedRecord['hooks'][0]] })] }), `${RECORD_PATH} is malformed`]
  ])('refuses %s', async (_what, body, message) => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, RECORD_PATH), body);
    await expect(readRecord(dir)).rejects.toThrow(message);
  });

  it('refuses an unreadable record rather than reading it as empty', async () => {
    await mkdir(join(dir, RECORD_PATH), { recursive: true });
    await expect(readRecord(dir)).rejects.toThrow(`cannot read ${RECORD_PATH}: EISDIR`);
  });
});
