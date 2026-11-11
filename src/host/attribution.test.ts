import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNNER_HOOK_SETTINGS, RUNNER_HOOKS } from '../main/claudeArgs.js';
import type { SessionOwner } from '../preload/sessionOwner.js';
import { attributionFor, CLAUDE_COAUTHOR, coAuthorName, sessionSettings, withAttribution } from './attribution.js';

const UUID = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '12345', login: 'ann', name: 'Ann Example', avatarUrl: null };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HOSTILE = [
  'line\nCo-authored-by: Mallory <m@x.io>', 'a\rb', 'a\u2028b\u2029c', 'a\u0085b', 'a\u000bb\u000cc', '","hooks":{},"x":"',
  '\\u000a', '\u202eevil', 'a\u200db', '\u3164', '\u0301\u0301', `${'\u{1D400}'.repeat(70)}`, 'Ann\u0000Example', '$(id)'
];

describe('RUNNER_HOOKS', () => {
  it('is docker/runner/hooks.settings.json', () => {
    expect(RUNNER_HOOKS).toEqual(JSON.parse(readFileSync(resolve(__dirname, '../../docker/runner/hooks.settings.json'), 'utf8')));
  });
});

describe('coAuthorName', () => {
  it.each([
    ['Ann Example', 'Ann Example'],
    ['  Zoë   Ŝmith-Jones Jr. ', 'Zoë Ŝmith-Jones Jr.'],
    ['Ann <ann@evil.io>', 'Ann annevil.io'],
    ['$(rm -rf ~)`id`', 'rm -rf id'],
    ['a"b\\c\'d', 'abcd'],
    ['line\nCo-authored-by: Mallory <m@x.io>', 'line Co-authored-by Mallory mx.io'],
    ['\u202eevil', 'evil'],
    ['x'.repeat(100), 'x'.repeat(64)],
    ['Zoe\u0301', 'Zoé'],
    ['a\u200db', 'ab'],
    ['', 'ann'],
    [null, 'ann'],
    ['<>"', 'ann'],
    ['\u3164', 'ann'],
    ['\u0301', 'ann'],
    ['- . -', 'ann']
  ])('%j → %j', (name, want) => {
    expect(coAuthorName({ login: 'ann', name: name as string | null })).toBe(want);
  });

  it('caps by code point, never splitting a surrogate pair', () => {
    const n = coAuthorName({ login: 'ann', name: '\u{1D400}'.repeat(70) });
    expect(Array.from(n)).toHaveLength(64);
    expect(n).not.toMatch(LONE_SURROGATE);
  });
});

describe('attributionFor', () => {
  it('credits a GitHub person: Claude, then the person; and the PR line', () => {
    expect(attributionFor(ann)).toEqual({
      commit: `${CLAUDE_COAUTHOR}\nCo-authored-by: Ann Example <12345+ann@users.noreply.github.com>`,
      pr: '🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @ann'
    });
  });

  it('the person trailer is always exactly one line, whatever the name', () => {
    for (const name of HOSTILE) {
      const a = attributionFor({ ...ann, name })!;
      const lines = a.commit.split(/\r\n|[\n\r\u0085\u2028\u2029\u000b\u000c]/);
      expect(lines, JSON.stringify(name)).toHaveLength(2);
      expect(lines[0]).toBe(CLAUDE_COAUTHOR);
      expect(lines[1]).toMatch(/^Co-authored-by: [\p{L}\p{M}\p{N} .-]+ <12345\+ann@users\.noreply\.github\.com>$/u);
      expect(a.pr).toBe('🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @ann');
    }
  });

  it('gives machines, automation runs, publishers and malformed owners nothing', () => {
    expect(attributionFor({ ...ann, kind: 'machine', login: 'acme-bot[bot]' })).toBeNull();
    expect(attributionFor({ kind: 'automation', provider: 'fleet-host', id: '01JC0000000000000000000000', login: 'automation', name: null, avatarUrl: null })).toBeNull();
    expect(attributionFor({ ...ann, kind: 'publisher' })).toBeNull();
    expect(attributionFor({ ...ann, provider: 'oidc' })).toBeNull();
    expect(attributionFor({ ...ann, login: '-ann' })).toBeNull();
    expect(attributionFor({ ...ann, login: 'ann@evil' })).toBeNull();
    expect(attributionFor({ ...ann, login: 'ann\nx' })).toBeNull();
    expect(attributionFor({ ...ann, id: '0' })).toBeNull();
    expect(attributionFor({ ...ann, id: '12345 ' })).toBeNull();
    expect(attributionFor({ ...ann, id: '12345\n' })).toBeNull();
  });
});

describe('sessionSettings / withAttribution', () => {
  it('is the runner hooks plus attribution, and nothing else', () => {
    const s = JSON.parse(sessionSettings(ann)!);
    expect(Object.keys(s).sort()).toEqual(['attribution', 'hooks']);
    expect(s.hooks).toEqual(RUNNER_HOOKS.hooks);
    expect(Object.keys(s.attribution).sort()).toEqual(['commit', 'pr']);
    expect(typeof s.attribution.commit).toBe('string');
    expect(typeof s.attribution.pr).toBe('string');
  });

  it('a hostile name stays inside one string value; the hooks are always there', () => {
    const s = JSON.parse(sessionSettings({ ...ann, name: '","hooks":{"SessionStart":[]},"x":"' })!);
    expect(Object.keys(s).sort()).toEqual(['attribution', 'hooks']);
    expect(s.hooks).toEqual(RUNNER_HOOKS.hooks);
    expect(s.attribution.commit).toBe(`${CLAUDE_COAUTHOR}\nCo-authored-by: hooksSessionStartx <12345+ann@users.noreply.github.com>`);
    for (const name of HOSTILE) {
      const t = JSON.parse(sessionSettings({ ...ann, name })!);
      expect(Object.keys(t).sort(), JSON.stringify(name)).toEqual(['attribution', 'hooks']);
      expect(t.hooks).toEqual(RUNNER_HOOKS.hooks);
    }
  });

  it('no settings for an owner that gets no attribution', () => {
    expect(sessionSettings(null)).toBeNull();
    expect(sessionSettings({ ...ann, kind: 'machine', login: 'acme-bot[bot]' })).toBeNull();
  });

  it('swaps only the gated hooks pair, and only for a person; never a second --settings', () => {
    const args = ['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID];
    expect(withAttribution(args, ann)).toEqual(['--settings', sessionSettings(ann), '--session-id', UUID]);
    expect(withAttribution(args, ann).filter((a) => a === '--settings')).toHaveLength(1);
    expect(withAttribution(args, { ...ann, kind: 'machine', login: 'acme-bot[bot]' })).toEqual(args);
    expect(withAttribution(args, { kind: 'automation', provider: 'fleet-host', id: '01JC0000000000000000000000', login: 'automation', name: null, avatarUrl: null })).toEqual(args);
    expect(withAttribution(args, null)).toEqual(args);
    expect(withAttribution(['--resume', UUID], ann)).toEqual(['--resume', UUID]);
  });
});
