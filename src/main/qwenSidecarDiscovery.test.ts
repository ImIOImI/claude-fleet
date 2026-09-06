// Unit test for the sidecar's project-root discovery helpers.
//
// Creates real tmp directories — no mocking — so the test exercises the
// actual readdirSync / statSync logic in discover.mjs. Pattern mirrors the
// mkdtemp usage in config.test.ts.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — discover.mjs is a plain ESM script in docker/qwen/, not part of the TS build.
// Vitest resolves .mjs imports at runtime; there is no @types stub.
import { listChatsFiles, listChatsDirs } from '../../docker/qwen/discover.mjs';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-qwen-discovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeProject(projectsRoot: string, projName: string, sids: string[]): Promise<string[]> {
  const chatsDir = join(projectsRoot, projName, 'chats');
  await mkdir(chatsDir, { recursive: true });
  const paths: string[] = [];
  for (const sid of sids) {
    const p = join(chatsDir, `${sid}.jsonl`);
    await writeFile(p, '');
    paths.push(p);
  }
  return paths;
}

// ── listChatsFiles ────────────────────────────────────────────────────────────

describe('listChatsFiles', () => {
  it('returns empty array when projects root does not exist', () => {
    const missing = join(root, 'no-such-dir');
    expect(listChatsFiles(missing)).toEqual([]);
  });

  it('returns empty array when projects root exists but has no subdirs', async () => {
    const projectsRoot = join(root, 'projects');
    await mkdir(projectsRoot, { recursive: true });
    expect(listChatsFiles(projectsRoot)).toEqual([]);
  });

  it('returns empty array when a project dir has no chats/ child', async () => {
    const projectsRoot = join(root, 'projects');
    await mkdir(join(projectsRoot, '-workspace'), { recursive: true }); // no chats/ inside
    expect(listChatsFiles(projectsRoot)).toEqual([]);
  });

  it('discovers *.jsonl files under a single project dir', async () => {
    const projectsRoot = join(root, 'projects');
    const [f1, f2] = await makeProject(projectsRoot, '-workspace', ['sid-aaa', 'sid-bbb']);
    const found = listChatsFiles(projectsRoot);
    expect(found).toHaveLength(2);
    expect(found).toContain(f1);
    expect(found).toContain(f2);
  });

  it('discovers *.jsonl files across multiple project dirs', async () => {
    const projectsRoot = join(root, 'projects');
    const [f1] = await makeProject(projectsRoot, '-workspace', ['sid-111']);
    const [f2] = await makeProject(projectsRoot, '-other', ['sid-222']);
    const found = listChatsFiles(projectsRoot);
    expect(found).toHaveLength(2);
    expect(found).toContain(f1);
    expect(found).toContain(f2);
  });

  it('ignores non-.jsonl files in chats/', async () => {
    const projectsRoot = join(root, 'projects');
    const chatsDir = join(projectsRoot, '-workspace', 'chats');
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(chatsDir, 'notes.txt'), '');
    await writeFile(join(chatsDir, 'sid-abc.jsonl'), '');
    const found = listChatsFiles(projectsRoot);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('sid-abc.jsonl');
  });

  it('ignores a chats entry that is a file, not a dir', async () => {
    const projectsRoot = join(root, 'projects');
    await mkdir(join(projectsRoot, '-workspace'), { recursive: true });
    // Write 'chats' as a plain file, not a directory.
    await writeFile(join(projectsRoot, '-workspace', 'chats'), '');
    expect(listChatsFiles(projectsRoot)).toEqual([]);
  });
});

// ── listChatsDirs ─────────────────────────────────────────────────────────────

describe('listChatsDirs', () => {
  it('returns empty array when projects root does not exist', () => {
    expect(listChatsDirs(join(root, 'nowhere'))).toEqual([]);
  });

  it('returns only dirs that have a chats/ subdirectory', async () => {
    const projectsRoot = join(root, 'projects');
    const chatsA = join(projectsRoot, 'proj-a', 'chats');
    await mkdir(chatsA, { recursive: true });
    await mkdir(join(projectsRoot, 'proj-b'), { recursive: true }); // no chats/
    const dirs = listChatsDirs(projectsRoot);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(chatsA);
  });

  it('returns one entry per project dir that has chats/', async () => {
    const projectsRoot = join(root, 'projects');
    const chatsA = join(projectsRoot, '-workspace', 'chats');
    const chatsB = join(projectsRoot, '-other', 'chats');
    await mkdir(chatsA, { recursive: true });
    await mkdir(chatsB, { recursive: true });
    const dirs = listChatsDirs(projectsRoot);
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain(chatsA);
    expect(dirs).toContain(chatsB);
  });
});
