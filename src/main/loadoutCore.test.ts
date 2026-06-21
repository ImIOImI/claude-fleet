// Unit tests for the pure loadout core (#16-followup): parse a loadout folder
// and apply/revert it to a workspace dir. Temp dirs only — no electron.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLoadout,
  applyLoadoutFiles,
  revertLoadoutFiles,
  applyLoadoutMerges,
  revertLoadoutMerges,
  stripBlock
} from './loadoutCore.js';

let root = '';
let src = '';
let target = '';

async function write(p: string, content: string): Promise<void> {
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content, 'utf8');
}
async function present(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loadout-core-'));
  src = join(root, 'rust-pro');
  target = join(root, 'workspace');
  await mkdir(target, { recursive: true });
  // A loadout folder: loadout.md + a skill + a command + a CLAUDE.md block.
  await write(
    join(src, 'loadout.md'),
    `---
title: Rust Pro
description: Idiomatic Rust.
tags: [skill, rust]
dependencies:
  loadouts: [base-dev]
scripts:
  - label: tools
    run: cargo install cargo-nextest
---
Installs the idiomatic-rust skill and a /clippy command.`
  );
  await write(join(src, 'skills', 'idiomatic-rust', 'SKILL.md'), '# idiomatic rust');
  await write(join(src, 'commands', 'clippy.md'), '# /clippy');
  await write(join(src, 'CLAUDE.md'), 'Run cargo clippy before done.');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseLoadout', () => {
  it('reads frontmatter + body; id defaults to folder name', async () => {
    const m = await parseLoadout(src);
    expect(m).toMatchObject({
      id: 'rust-pro',
      title: 'Rust Pro',
      description: 'Idiomatic Rust.',
      tags: ['skill', 'rust']
    });
    expect(m.dependencies?.loadouts).toEqual(['base-dev']);
    expect(m.scripts?.[0]).toMatchObject({ label: 'tools', run: 'cargo install cargo-nextest' });
    expect(m.instructions).toContain('idiomatic-rust skill');
  });

  it('falls back to defaults when frontmatter is missing', async () => {
    const bare = join(root, 'bare');
    await write(join(bare, 'loadout.md'), 'just a body, no frontmatter');
    const m = await parseLoadout(bare);
    expect(m).toMatchObject({ id: 'bare', title: 'bare', description: '', tags: [] });
    expect(m.instructions).toBe('just a body, no frontmatter');
  });
});

describe('applyLoadoutFiles / revertLoadoutFiles', () => {
  it('drops convention files into .claude/ and appends a marked CLAUDE.md block', async () => {
    const rec = await applyLoadoutFiles(src, target, 'rust-pro');
    expect(rec.files.sort()).toEqual(
      ['.claude/commands/clippy.md', '.claude/skills/idiomatic-rust/SKILL.md'].sort()
    );
    expect(rec.claudeMd).toBe(true);
    expect(rec.skipped).toEqual([]);
    expect(await present(join(target, '.claude/skills/idiomatic-rust/SKILL.md'))).toBe(true);
    const cm = await readFile(join(target, 'CLAUDE.md'), 'utf8');
    expect(cm).toContain('<!-- loadout:rust-pro start -->');
    expect(cm).toContain('Run cargo clippy before done.');
    expect(cm).toContain('<!-- loadout:rust-pro end -->');
  });

  it('preserves pre-existing CLAUDE.md content and never clobbers existing files', async () => {
    await writeFile(join(target, 'CLAUDE.md'), '# my project notes', 'utf8');
    await mkdir(join(target, '.claude/commands'), { recursive: true });
    await writeFile(join(target, '.claude/commands/clippy.md'), 'MINE', 'utf8');

    const rec = await applyLoadoutFiles(src, target, 'rust-pro');
    // existing command file is skipped (reported), not overwritten
    expect(rec.skipped).toContain('.claude/commands/clippy.md');
    expect(await readFile(join(target, '.claude/commands/clippy.md'), 'utf8')).toBe('MINE');
    // CLAUDE.md keeps the user's notes AND gains the block
    const cm = await readFile(join(target, 'CLAUDE.md'), 'utf8');
    expect(cm).toContain('# my project notes');
    expect(cm).toContain('<!-- loadout:rust-pro start -->');
  });

  it('uninstall removes exactly the dropped files and strips the block, keeping user content', async () => {
    await writeFile(join(target, 'CLAUDE.md'), '# my project notes', 'utf8');
    const rec = await applyLoadoutFiles(src, target, 'rust-pro');
    await revertLoadoutFiles(target, { files: rec.files, claudeMd: rec.claudeMd }, 'rust-pro');

    expect(await present(join(target, '.claude/skills/idiomatic-rust/SKILL.md'))).toBe(false);
    const cm = await readFile(join(target, 'CLAUDE.md'), 'utf8');
    expect(cm).toContain('# my project notes');
    expect(cm).not.toContain('loadout:rust-pro');
  });

  it('reinstall replaces the block rather than duplicating it', async () => {
    await applyLoadoutFiles(src, target, 'rust-pro');
    await applyLoadoutFiles(src, target, 'rust-pro');
    const cm = await readFile(join(target, 'CLAUDE.md'), 'utf8');
    expect(cm.match(/loadout:rust-pro start/g)).toHaveLength(1);
  });
});

describe('applyLoadoutMerges / revertLoadoutMerges', () => {
  it('merges settings keys, mcp servers, and hooks; revert removes exactly those, keeping user content', async () => {
    await write(
      join(src, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'echo hi' },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] }
      })
    );
    await write(join(src, '.mcp.json'), JSON.stringify({ mcpServers: { mytool: { command: 'x' } } }));
    // pre-existing user settings (a model + their own hook)
    await write(
      join(target, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] } })
    );

    const rec = await applyLoadoutMerges(src, target);
    expect(rec.settingsKeys).toEqual(['statusLine']);
    expect(rec.mcpServers).toEqual(['mytool']);
    expect(rec.hooks).toHaveLength(1);

    const s = JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf8'));
    expect(s.model).toBe('opus'); // user key preserved
    expect(s.statusLine).toBeDefined();
    expect(s.hooks.PreToolUse).toHaveLength(2); // user's + loadout's
    const mcp = JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.mytool).toBeDefined();

    await revertLoadoutMerges(target, rec);
    const s2 = JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf8'));
    expect(s2.model).toBe('opus'); // user content survives
    expect(s2.statusLine).toBeUndefined();
    expect(s2.hooks.PreToolUse).toHaveLength(1); // back to the user's hook only
    // .mcp.json held only the loadout's server → removed entirely on revert
    expect(await present(join(target, '.mcp.json'))).toBe(false);
  });

  it('skips a colliding settings key / mcp server without overwriting', async () => {
    await write(join(src, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    await write(join(src, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'new' } } }));
    await write(join(target, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    await write(join(target, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'old' } } }));

    const rec = await applyLoadoutMerges(src, target);
    expect(rec.skipped).toEqual(expect.arrayContaining(['settings.json:model', '.mcp.json:dup']));
    expect(rec.settingsKeys).toEqual([]);
    expect(rec.mcpServers).toEqual([]);
    expect(JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf8')).model).toBe('opus');
    expect(JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')).mcpServers.dup.command).toBe('old');
  });
});

describe('stripBlock', () => {
  it('removes only the matching id block', () => {
    const t = `head
<!-- loadout:a start -->
A
<!-- loadout:a end -->
<!-- loadout:b start -->
B
<!-- loadout:b end -->
tail`;
    const out = stripBlock(t, 'a');
    expect(out).not.toContain('loadout:a');
    expect(out).toContain('loadout:b');
    expect(out).toContain('head');
    expect(out).toContain('tail');
  });
});
