import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const ALLOWED = new Set([join('main', 'publish', 'scrub.ts'), join('main', 'publish', 'scrubBrand.test.ts')]);
const CAST_RE = /\bas\s+(unknown\s+as\s+)?ScrubbedLine\b|(?<![\w$])<ScrubbedLine>|\bas\s+(?:unknown\s+as\s+)?[\w$.]+\s*<[^;]*?\bScrubbedLine\b/;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );

describe('ScrubbedLine brand', () => {
  it.each([
    'x as ScrubbedLine',
    'x as unknown as ScrubbedLine',
    'b as PublishBatch<ScrubbedLine>',
    'b as unknown as PublishBatch<ScrubbedLine>',
    'l as Array<ScrubbedLine>',
    '<ScrubbedLine>x'
  ])('the check catches %s', (src) => expect(CAST_RE.test(src)).toBe(true));

  it.each(['const b: PublishBatch<ScrubbedLine> = plan();', 'function f(b: PublishBatch<ScrubbedLine>): void {}', 'import { a as b } from "x"; let l: ScrubbedLine[];'])(
    'the check allows %s',
    (src) => expect(CAST_RE.test(src)).toBe(false)
  );

  it('is cast only inside scrub.ts', () => {
    const casts = files(SRC)
      .filter((f) => !ALLOWED.has(relative(SRC, f)) && CAST_RE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(casts).toEqual([]);
  }, 30_000);
});
