// Global constraint: src/main/identity/ is importable by fleet-host (no
// electron). Every module specifier in every non-test module under this
// directory (recursively) must be on an explicit allowlist:
//   - relative `.js` siblings that stay inside src/main/identity/;
//   - `../vaultScopes.js` (pure);
//   - `../../preload/identityTypes.js`, type-only (`import type` / `export type`);
//   - `node:*` builtins.
// Anything else — electron, electron/main, ../vault.js, ../db.js, a bare
// package, an extensionless path, a non-literal import()/require() — fails.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

interface Specifier {
  spec: string;
  typeOnly: boolean;
}

const Q = `['"\`]`;
const LIT = `${Q}([^'"\`]+)${Q}`;
const PATTERNS: Array<{ re: RegExp; typeOnly?: (m: RegExpExecArray) => boolean }> = [
  // import … from '…' / export … from '…' (incl. multi-line, `type`, `* as`)
  { re: new RegExp(`\\b(import|export)\\s+(type\\s+)?[^'"\`;]*?\\bfrom\\s*${LIT}`, 'g'), typeOnly: (m) => !!m[2] },
  // side-effect import '…'
  { re: new RegExp(`\\bimport\\s*${LIT}`, 'g') },
  // require('…')
  { re: new RegExp(`\\brequire\\s*\\(\\s*${LIT}\\s*\\)`, 'g') },
  // dynamic import('…')
  { re: new RegExp(`\\bimport\\s*\\(\\s*${LIT}`, 'g') }
];
// import(x) / require(x) with a non-literal argument can't be checked.
const NON_LITERAL = /\b(?:import|require)\s*\(\s*(?![\s'"`])/g;

function extractSpecifiers(src: string): Specifier[] {
  const out: Specifier[] = [];
  for (const { re, typeOnly } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.push({ spec: m[m.length - 1], typeOnly: typeOnly ? typeOnly(m) : false });
    }
  }
  NON_LITERAL.lastIndex = 0;
  for (let m = NON_LITERAL.exec(src); m; m = NON_LITERAL.exec(src)) out.push({ spec: '<non-literal>', typeOnly: false });
  return out;
}

// Virtual posix layout so the check is OS-independent.
const ROOT = '/src/main/identity';
const VAULT_SCOPES = '/src/main/vaultScopes.js';
const PRELOAD_TYPES = '/src/preload/identityTypes.js';

/** Null when allowed; otherwise why not. `fileRel` is the importing file's path relative to identity/. */
function violation(fileRel: string, s: Specifier): string | null {
  if (s.spec.startsWith('node:')) return null;
  if (!s.spec.startsWith('./') && !s.spec.startsWith('../')) return `bare specifier ${s.spec}`;
  if (!s.spec.endsWith('.js')) return `relative specifier ${s.spec} must end in .js`;
  const resolved = posix.resolve(posix.dirname(posix.join(ROOT, fileRel)), s.spec);
  if (resolved.startsWith(`${ROOT}/`)) return null;
  if (resolved === VAULT_SCOPES) return null;
  if (resolved === PRELOAD_TYPES) return s.typeOnly ? null : `${s.spec} must be imported type-only`;
  return `${s.spec} leaves src/main/identity/`;
}

const check = (src: string, fileRel = 'x.ts'): string[] =>
  extractSpecifiers(src)
    .map((s) => violation(fileRel, s))
    .filter((v): v is string => v !== null);

describe('identity import guard (extractor + allowlist)', () => {
  it.each([
    ['electron', `import { app } from 'electron';`],
    ['electron/main', `import { safeStorage } from "electron/main";`],
    ['side-effect electron', `import 'electron';`],
    ['require electron', `const e = require('electron');`],
    ['dynamic electron', `const e = await import('electron');`],
    ['template-literal dynamic electron', 'const e = await import(`electron`);'],
    ['non-literal dynamic import', `const e = await import(name);`],
    ['../db.js', `import { db } from '../db.js';`],
    ['../vault without .js', `import { vault } from '../vault';`],
    ['an extensionless sibling', `import { a } from './types';`],
    ['../vault.js', `import { vault } from '../vault.js';`],
    ['../config.js', `export { x } from '../config.js';`],
    ['../ipc.js re-export star', `export * from '../ipc.js';`],
    ['multi-line import', `import {\n  a,\n  b\n} from '../ipc.js';`],
    ['bare builtin without node:', `import { createHash } from 'crypto';`],
    ['value import of preload types', `import { AccountStatus } from '../../preload/identityTypes.js';`],
    ['escaping via a sibling path', `import x from './../db.js';`]
  ])('catches %s', (_label, src) => {
    expect(check(src)).not.toEqual([]);
  });

  it('catches ../db.js from a subdirectory reaching out two levels', () => {
    expect(check(`import { db } from '../../db.js';`, 'sub/a.ts')).not.toEqual([]);
  });

  it.each([
    ['a sibling', `import { a } from './types.js';`],
    ['a type-only sibling', `import type { Identity } from './types.js';`],
    ['../vaultScopes.js', `import { GITHUB_IDENTITY_SCOPE } from '../vaultScopes.js';`],
    ['type-only preload types', `import type { AccountStatus } from '../../preload/identityTypes.js';`],
    ['type-only preload re-export', `export type { AccountStatus } from '../../preload/identityTypes.js';`],
    ['a node: builtin', `import { createHash } from 'node:crypto';`],
    ['words in comments', `// imports it unchanged; require a token\nconst x = 1;`]
  ])('allows %s', (_label, src) => {
    expect(check(src)).toEqual([]);
  });

  it('allows a subdirectory module importing its parent sibling', () => {
    expect(check(`import { a } from '../types.js';`, 'sub/a.ts')).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(?:[mc]?ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('src/main/identity has no electron dependency', () => {
  const files = walk(__dirname);
  it('has modules to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    const rel = relative(__dirname, file).split(sep).join('/');
    it(`${rel} imports only allowlisted modules`, () => {
      expect(check(readFileSync(file, 'utf8'), rel)).toEqual([]);
    });
  }
});
