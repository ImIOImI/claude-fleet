// fleet-host runs on plain Node: the graph reachable from cli.ts must not touch
// electron or the desktop's native modules, and may reach only the pure
// src/main modules listed here.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';

const SRC = resolve(__dirname, '..');
const ROOT = resolve(SRC, '..');
const ENTRIES = [join(SRC, 'host', 'cli.ts'), join(SRC, 'host', 'credMain.ts')];
const BARE_ALLOWED = new Set(['ws', 'yaml', 'ulid']);
const MAIN_ALLOWED = [/^main\/identity\/[^/]+\.ts$/, /^main\/broker\.ts$/, /^main\/claudeArgs\.ts$/, /^main\/vaultScopes\.ts$/, /^preload\/identityTypes\.ts$/];
const SPEC_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function walk(): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [...ENTRIES];
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

/** `.dockerignore` semantics: the last matching pattern wins, and a pattern also matches everything under a matched directory. */
function dockerIncluded(rules: string, file: string): boolean {
  const toRe = (glob: string): RegExp =>
    new RegExp(
      '^' +
        glob
          .replace(/^\//, '')
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\/?|\*|\?/g, (m) => (m.startsWith('**') ? '.*' : m === '*' ? '[^/]*' : '[^/]')) +
        '(/.*)?$'
    );
  let included = true;
  for (const line of rules.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (toRe(negated ? line.slice(1) : line).test(file)) included = negated;
  }
  return included;
}

describe('fleet-host build inputs', () => {
  const graph = walk().files.map((f) => `src/${f}`);
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

  it('every import-graph file is in the Docker build context', () => {
    const rules = read('.dockerignore');
    expect(graph.filter((f) => !dockerIncluded(rules, f))).toEqual([]);
    expect(dockerIncluded(rules, 'src/host/server.test.ts')).toBe(false);
  });

  it('every import-graph file triggers publish-runner, build-app and test-runner-images', () => {
    const paths = (parse(read('.github/workflows/publish-runner.yml')) as { on: { push: { paths: string[] } } }).on.push.paths;
    const globs = paths.map((g) => new RegExp('^' + g.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*') + '$'));
    expect(graph.filter((f) => !globs.some((re) => re.test(f)))).toEqual([]);
    const filter = /grep -qE '([^']+)'/.exec(read('.github/workflows/build-app.yml'))?.[1];
    expect(filter).toBeDefined();
    expect(graph.filter((f) => !new RegExp(filter!).test(f))).toEqual([]);
    const prPaths = (parse(read('.github/workflows/test-runner-images.yml')) as { on: { pull_request: { paths: string[] } } }).on.pull_request.paths;
    const prGlobs = prPaths.map((g) => new RegExp('^' + g.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*') + '$'));
    expect(graph.filter((f) => !prGlobs.some((re) => re.test(f)))).toEqual([]);
  });
});
