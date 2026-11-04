// Global constraint: src/main/identity/ is importable by fleet-host (no
// electron). Fail if any non-test module there imports electron or an
// electron-bound main module.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname);
const FORBIDDEN = [/from ['"]electron['"]/, /from ['"]\.\.\/vault\.js['"]/, /from ['"]\.\.\/config\.js['"]/, /from ['"]\.\.\/ipc\.js['"]/];

describe('src/main/identity has no electron dependency', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  it('has modules to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    it(`${f} imports nothing electron-bound`, () => {
      const src = readFileSync(join(DIR, f), 'utf8');
      for (const re of FORBIDDEN) expect(src).not.toMatch(re);
    });
  }
});
