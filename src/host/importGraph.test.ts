// fleet-host runs on plain Node: the graph reachable from cli.ts must not touch
// electron or the desktop's native modules, and may reach only the pure
// src/main modules listed here.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const ENTRY = join(SRC, 'host', 'cli.ts');
const BARE_ALLOWED = new Set(['ws', 'yaml', 'ulid']);
const MAIN_ALLOWED = [/^main\/identity\/[^/]+\.ts$/, /^main\/broker\.ts$/, /^main\/claudeArgs\.ts$/, /^main\/vaultScopes\.ts$/, /^preload\/identityTypes\.ts$/];
const SPEC_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function walk(): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [ENTRY];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bare.add(spec.split('/')[0]);
        continue;
      }
      const ts = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!existsSync(ts)) throw new Error(`${relative(SRC, file)} imports missing ${spec}`);
      stack.push(ts);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')), bare };
}

describe('fleet-host import graph', () => {
  const { files, bare } = walk();

  it('uses only allowlisted packages (never electron)', () => {
    expect([...bare].filter((b) => !BARE_ALLOWED.has(b))).toEqual([]);
  });

  it('reaches only pure src/main modules', () => {
    const outside = files.filter((f) => !f.startsWith('host/') && !MAIN_ALLOWED.some((re) => re.test(f)));
    expect(outside).toEqual([]);
  });

  it('never ships test fakes', () => {
    expect(files.filter((f) => /test/i.test(f))).toEqual([]);
  });
});
