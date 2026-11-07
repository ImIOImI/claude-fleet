import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, type FSWatcher } from 'node:fs';
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

describe('RecursiveDirWatcher recovery', () => {
  it('rescans the root as change events when an event has no filename (buffer overflow)', async () => {
    let listener: ((ev: string, f: string | null) => void) | null = null;
    const fake = Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as FSWatcher;
    const rw = new RecursiveDirWatcher({ depth: 2, watchFn: (_root, l) => { listener = l; return fake; } });
    const got: string[] = [];
    rw.on('change', (p: string) => got.push(p));
    writeFileSync(join(root, 'd.jsonl'), '1\n');
    rw.add(root);
    await new Promise((r) => setTimeout(r, 50));
    listener!('rename', null);
    await waitFor(() => got.includes(join(root, 'd.jsonl')));
    await rw.close();
  });

  it('rescans when an event filename does not resolve under the root', async () => {
    let listener: ((ev: string, f: string | null) => void) | null = null;
    const fake = Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as FSWatcher;
    const rw = new RecursiveDirWatcher({ depth: 2, watchFn: (_root, l) => { listener = l; return fake; } });
    const got: Array<[string, string]> = [];
    for (const ev of ['change', 'unlink'] as const) rw.on(ev, (p: string) => got.push([ev, p]));
    rw.add(root);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(root, 'f.jsonl'), '1\n');
    listener!('rename', join('ce', 'f.jsonl'));
    await waitFor(() => got.some(([e, p]) => e === 'change' && p === join(root, 'f.jsonl')));
    expect(got.some(([e]) => e === 'unlink')).toBe(false);
    await rw.close();
  });

  it('retries a root that was missing at add() and watches it once it exists', async () => {
    const missing = join(root, 'later');
    const rw = new RecursiveDirWatcher({ depth: 2, retryMs: 50 });
    const got: Array<[string, string]> = [];
    rw.on('error', () => undefined);
    for (const ev of ['add', 'change'] as const) rw.on(ev, (p: string) => got.push([ev, p]));
    rw.add(missing);
    await new Promise((r) => setTimeout(r, 120));
    mkdirSync(missing);
    writeFileSync(join(missing, 'e.jsonl'), '1\n');
    await waitFor(() => got.some(([, p]) => p === join(missing, 'e.jsonl')));
    await rw.close();
  });

  it('re-watches a root after a watcher error', async () => {
    const fakes: EventEmitter[] = [];
    const rw = new RecursiveDirWatcher({
      depth: 2, retryMs: 50,
      watchFn: () => { const f = Object.assign(new EventEmitter(), { close: () => undefined }); fakes.push(f); return f as unknown as FSWatcher; }
    });
    rw.on('error', () => undefined);
    rw.add(root);
    fakes[0].emit('error', new Error('EPERM'));
    await waitFor(() => fakes.length === 2);
    rw.unwatch(root);
    fakes[1].emit('error', new Error('EPERM'));
    await new Promise((r) => setTimeout(r, 150));
    expect(fakes).toHaveLength(2);
  });
});
