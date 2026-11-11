import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const ALLOWED = new Set([join('main', 'publish', 'scrub.ts'), join('main', 'publish', 'scrubBrand.test.ts')]);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );

describe('ScrubbedLine brand', () => {
  it('is cast only inside scrub.ts', () => {
    const casts = files(SRC)
      .filter((f) => !ALLOWED.has(relative(SRC, f)) && /\bas\s+(unknown\s+as\s+)?ScrubbedLine\b|<ScrubbedLine>/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(casts).toEqual([]);
  }, 30_000);
});
