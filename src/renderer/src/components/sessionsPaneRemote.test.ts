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
      'null',
      '(cur) => reloadedRemote(cur, r)',
      '(cur) => refreshedRemote(cur, r, origin)',
      '(cur) => loadedMoreRemote(cur, r, origin, after)'
    ]);
    expect(src).not.toMatch(/\.\.\.remote\b|structuredClone|JSON\.(parse|stringify)\(remote/);
  });

  it('a full reload that a newer one overtook is dropped', () => {
    const body = src.slice(src.indexOf('const loadRemote = useCallback'), src.indexOf('const refreshOrigin = useCallback'));
    expect(body).toContain('const seq = ++remoteSeq.current;');
    expect(body.indexOf('if (seq !== remoteSeq.current) return;')).toBeLessThan(body.indexOf('setRemote('));
  });

  it('scopes the unavailable note and Load older buttons like the rows', () => {
    expect(src).toContain('unavailableText(remoteForScope(unavailable, scope, selectedWorkspaceId))');
    expect(src).toContain('remoteForScope(remote.more, scope, selectedWorkspaceId).map(');
    expect(src).not.toContain('remote?.more.map(');
  });

  it('a remote push refreshes only its origin; a local push reloads local rows', () => {
    expect(src).toContain('window.api.sessions.listRemote({ origin })');
    expect(src).toContain('if (remoteOrigins.current.has(workspaceId)) {');
    expect(src).toContain('void refreshOrigin(workspaceId);');
    expect(src).toContain('}, 5_000)');
  });

  it('renders remote text as React text only', () => {
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toMatch(/Markdown/);
  });
});

function callArgs(text: string, callee: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(callee)) {
    let i = text.indexOf('(', m.index + m[0].length - 1);
    if (i < 0) continue;
    const start = i;
    for (let depth = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(text.slice(start, i + 1));
  }
  return out;
}

describe('SessionsPane Mine / Everyone wiring (D122)', () => {
  it('defaults to Everyone', () => {
    expect(src).toContain("useState<OwnerFilter>('everyone')");
  });

  it('keeps the choice in component state: no storage, no prefs, never an IPC argument', () => {
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    const ipc = callArgs(src, /window\.api\.[\w.]+\(/g);
    expect(ipc.length).toBeGreaterThan(5);
    for (const a of ipc) expect(a).not.toMatch(/ownerFilter|ownerShown|filterByOwner/);
  });

  it('the filter value only selects rows and styles the toggle', () => {
    const uses = [...src.matchAll(/\bownerFilter\b|\bownerShown\b/g)].map((m) => src.slice(m.index, src.indexOf('\n', m.index)));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(
        /^ownerFilter, setOwnerFilter\] = useState|^ownerFilter : 'everyone';|^ownerShown: OwnerFilter = |^ownerShown, me\);|^ownerShown === '(everyone|mine)'/
      );
    }
  });
});
