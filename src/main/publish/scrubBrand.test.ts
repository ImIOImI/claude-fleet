import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const ALLOWED = new Set([join('main', 'publish', 'scrub.ts'), join('main', 'publish', 'scrubBrand.test.ts')]);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );

/** Every `x as T` / `<T>x` whose T mentions ScrubbedLine; annotations and generic arguments elsewhere aren't casts. */
function brandCasts(text: string, name = 'x.ts'): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && /\bScrubbedLine\b/.test(n.type.getText(sf))) out.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('ScrubbedLine brand', () => {
  it.each([
    'x as ScrubbedLine',
    'x as unknown as ScrubbedLine',
    'b as PublishBatch<ScrubbedLine>',
    'b as unknown as PublishBatch<ScrubbedLine>',
    'l as Array<ScrubbedLine>',
    '<ScrubbedLine>x',
    'l as readonly ScrubbedLine[]',
    'l as [ScrubbedLine]',
    'x as (ScrubbedLine)',
    'x as Foo<{ a: x; b: ScrubbedLine }>',
    'x as { a: string; b: ScrubbedLine }',
    'f as (s: string) => ScrubbedLine',
    'x as ScrubbedLine | null',
    'const y = (\n  x as\n    ScrubbedLine\n);'
  ])('the check catches %s', (src) => expect(brandCasts(src)).toHaveLength(1));

  it.each([
    'const b: PublishBatch<ScrubbedLine> = plan();',
    'function f(b: PublishBatch<ScrubbedLine>): void {}',
    'import { a as b } from "x"; let l: ScrubbedLine[];',
    'const s = makeScrubber([]) as (l: string) => string; type T = ScrubbedLine;',
    'const c = x as const; // stored as a ScrubbedLine',
    'publish(batch: PublishBatch<ScrubbedLine>): Promise<PublishAck>;'
  ])('the check allows %s', (src) => expect(brandCasts(src)).toEqual([]));

  it('is cast only inside scrub.ts', () => {
    const casts = files(SRC)
      .filter((f) => !ALLOWED.has(relative(SRC, f)))
      .flatMap((f) => brandCasts(readFileSync(f, 'utf8'), f).map((c) => `${relative(SRC, f)}: ${c}`));
    expect(casts).toEqual([]);
  }, 60_000);
});
