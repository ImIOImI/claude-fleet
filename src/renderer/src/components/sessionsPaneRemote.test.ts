// SessionsPane needs a DOM and window.api, so its remote wiring is asserted by
// source text (as main/ipcFederationWiring.test does).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./SessionsPane.tsx', import.meta.url), 'utf8');
const rail = readFileSync(new URL('./LeftRail.tsx', import.meta.url), 'utf8');

function menuSource(): string {
  const start = src.indexOf('{rowMenu &&');
  if (start < 0) throw new Error('SessionsPane.tsx: no row menu');
  return src.slice(start);
}

describe('SessionsPane remote rows', () => {
  it('gates Resume on remote rows, in the row title and the menu', () => {
    expect(src.match(/const resumable = isOpen \|\| canResumeHere\(s, remoteResume\);/g)).toHaveLength(2);
    expect(src).toContain('if (resumable) onResume(s);');
    expect(menuSource()).toContain('disabled={!resumable}');
    expect(rail).toContain('remoteResume={remoteResume}');
    expect(rail).toContain('useMemo(() => remoteResumeMap(workspaces), [workspaces])');
  });

  it('hides Rename and Delete on remote rows', () => {
    const menu = menuSource();
    const guard = menu.indexOf('{!isRemoteRow(s) && (');
    expect(guard).toBeGreaterThan(0);
    expect(menu.indexOf('<span>Rename</span>')).toBeGreaterThan(guard);
    expect(menu.indexOf('<span>Delete</span>')).toBeGreaterThan(guard);
  });

  it('replaces the merged remote state only through federation helpers', () => {
    const sets = [...src.matchAll(/setRemote\(([^;]*)\);/g)].map((m) => m[1]);
    expect(sets).toEqual([
      'r.pages.length ? mergeSessionPages(r.pages) : null',
      'null',
      '(cur) => refreshedRemote(cur, r, origin)',
      '(cur) => loadedMoreRemote(cur, r, origin, after)'
    ]);
    expect(src).not.toMatch(/\.\.\.remote\b|structuredClone|JSON\.(parse|stringify)\(remote/);
  });

  it('a remote push refreshes only its origin; a local push reloads local rows', () => {
    expect(src).toContain('if (remoteOrigins.current.has(workspaceId)) {');
    expect(src).toContain('void refreshOrigin(workspaceId);');
    expect(src).toContain('}, 5_000)');
  });

  it('renders remote text as React text only', () => {
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toMatch(/Markdown/);
  });
});
