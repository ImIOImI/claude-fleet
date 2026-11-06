import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecursiveDirWatcher } from './recursiveDirWatcher';

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let root: string;
let w: RecursiveDirWatcher;
let events: Array<[string, string]>;
const seen = (ev: string, p: string) => events.some(([e, q]) => e === ev && q === p);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rdw-'));
  w = new RecursiveDirWatcher({ depth: 2 });
  events = [];
  for (const ev of ['add', 'change', 'unlink'] as const) w.on(ev, (p: string) => events.push([ev, p]));
});
afterEach(async () => {
  await w.close();
  rmSync(root, { recursive: true, force: true });
});

describe('RecursiveDirWatcher', () => {
  it('emits add for existing files up to depth on add(), not deeper', async () => {
    mkdirSync(join(root, 's', 'subagents', 'deep'), { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), '1\n');
    writeFileSync(join(root, 's', 'subagents', 'agent.jsonl'), '1\n');
    writeFileSync(join(root, 's', 'subagents', 'deep', 'too-deep.jsonl'), '1\n');
    w.add(root);
    await waitFor(() => seen('add', join(root, 'a.jsonl')) && seen('add', join(root, 's', 'subagents', 'agent.jsonl')));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen('add', join(root, 's', 'subagents', 'deep', 'too-deep.jsonl'))).toBe(false);
  });

  it('emits change for created and appended files, including in new subdirs, and unlink on delete', async () => {
    w.add(root);
    await new Promise((r) => setTimeout(r, 100));
    const f = join(root, 'b.jsonl');
    writeFileSync(f, '1\n');
    await waitFor(() => seen('change', f) || seen('add', f));
    events = [];
    appendFileSync(f, '2\n');
    await waitFor(() => seen('change', f));
    mkdirSync(join(root, 'n', 'subagents'), { recursive: true });
    const g = join(root, 'n', 'subagents', 'agent-x.jsonl');
    writeFileSync(g, '1\n');
    await waitFor(() => seen('change', g) || seen('add', g));
    unlinkSync(f);
    await waitFor(() => seen('unlink', f));
  });

  it('stops emitting for a root after unwatch()', async () => {
    w.add(root);
    await new Promise((r) => setTimeout(r, 100));
    w.unwatch(root);
    writeFileSync(join(root, 'c.jsonl'), '1\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
  });

  it('reports a missing root as an error, not a throw', async () => {
    const errors: unknown[] = [];
    w.on('error', (e) => errors.push(e));
    w.add(join(root, 'missing'));
    await waitFor(() => errors.length > 0);
  });
});
