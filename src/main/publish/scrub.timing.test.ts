import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS } from '../identity/redact.js';
import { makeScrubber, SCRUB_PATTERNS, secretValuePattern } from './scrub.js';

const MiB = 1 << 20;
const PATTERN_BUDGET_MS = 500;
const PIPELINE_BUDGET_MS = 2000;

const fill = (unit: string): string => unit.repeat(Math.ceil(MiB / unit.length)).slice(0, MiB);
const run = (head: string, unit: string): string => head + fill(unit).slice(head.length);
const b64 = Buffer.from(Array.from({ length: MiB }, (_, i) => (i * 7919) & 255)).toString('base64').slice(0, MiB);

/** Generic shapes plus each pattern's own worst case; every pattern meets every shape. */
const SHAPES: Record<string, string> = {
  a: fill('a'),
  hex: fill('0123456789abcdef'),
  digits: fill('1'),
  slackRun: fill('xoxb-'),
  slackHyphenRun: fill('-xoxb'),
  slackWord: run('xoxb-', 'a-'),
  jwtDots: fill('eyJ.'),
  jwtSegments: fill('eyJaaaa.'),
  jwtLong: fill('.eyJaaaaaaaaaa'),
  hyphens: fill('-'),
  dots: fill('.'),
  base64: b64,
  spaces: run('a_KEY', ' '),
  urlScheme: fill('a.'),
  urlRun: fill('a://bbbbbbbbbb:'),
  urlUser: run('a://', 'b:'),
  pemRun: fill('-----BEGIN PRIVATE KEY-----'),
  pemHeader: run('-----BEGIN ', 'PRIVATE KEY '),
  bearerRun: fill('Bearer aaaaaaaaaaaaaaa '),
  bearerWord: fill('bearer' + 'a'.repeat(30) + '-'),
  bearerLong: run('Bearer ', 'a'),
  basicRun: fill('Basic aaaaaaaaaaa '),
  tokenRun: fill('token '),
  ansi: fill('\x1b[1;2'),
  ansiEscaped: fill('\\u001b[1;'),
  jsonEscapes: fill('\\n'),
  ghRun: fill('ghp_'),
  patRun: fill('github_pat_'),
  skAntRun: fill('sk-ant-'),
  awsRun: fill('AKIA'),
  assignUnderscore: fill('a_'),
  assignKey: fill('x_key'),
  assignExport: fill('export '),
  assignQuote: fill('a_KEY="'),
  assignSingle: run('a_KEY=\'', 'x'),
  label: fill('[redacted:'),
  labelRun: fill('[redacted'),
};

const VALUES = [
  { key: 'A', value: 'a'.repeat(12) + 'b' },
  { key: 'H', value: '0123456789abcdeg' },
  { key: 'S', value: 'xoxb-xoxb-xoxb-1' },
  { key: 'J', value: 'eyJ.eyJ.eyJ.x' },
  { key: 'D', value: '--------x' },
  { key: 'Q', value: 'a"b\\c\nd"e' },
  { key: 'R', value: 'redacted' },
];
const valuePatterns = {
  'secret values': secretValuePattern(VALUES)!.re,
  'secret values (escaped)': secretValuePattern(VALUES, (v) => JSON.stringify(v).slice(1, -1))!.re,
};

const REDACT_NAMES = ['PEM', 'URL credential', 'Bearer', 'Basic', 'token', 'gh*_', 'github_pat_', 'sk-ant-'];
const PATTERNS: Array<[string, RegExp]> = [
  ...Object.entries(valuePatterns),
  ...SECRET_PATTERNS.map(([re], i): [string, RegExp] => [`redactSecrets ${REDACT_NAMES[i] ?? re.source}`, re]),
  ...Object.entries(SCRUB_PATTERNS),
];

const elapsed = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe('scrub patterns are linear on 1 MiB input', () => {
  it.each(PATTERNS)(`%s stays under ${PATTERN_BUDGET_MS} ms on every shape`, (_name, re) => {
    // Stops at the first slow shape: a quadratic pattern takes minutes per shape.
    for (const [shape, s] of Object.entries(SHAPES)) {
      const ms = Math.round(elapsed(() => s.replace(re, '')));
      expect({ shape, ms }).toEqual({ shape, ms: expect.toSatisfy((n: number) => n <= PATTERN_BUDGET_MS) });
    }
  }, 120_000);

  it(`makeScrubber stays under ${PIPELINE_BUDGET_MS} ms per line on every shape`, () => {
    const s = makeScrubber(VALUES);
    for (const [shape, v] of Object.entries(SHAPES)) {
      for (const [form, line] of [['JSON', JSON.stringify({ t: v })], ['text', v]]) {
        const ms = Math.round(elapsed(() => s(line)));
        expect({ shape, form, ms }).toEqual({ shape, form, ms: expect.toSatisfy((n: number) => n <= PIPELINE_BUDGET_MS) });
      }
    }
  }, 300_000);
});
