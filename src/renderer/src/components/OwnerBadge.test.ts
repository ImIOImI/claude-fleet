import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerBadge } from './OwnerBadge';
import type { SessionOwner } from '../../../preload/sessionOwner';

const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann Example', avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' };
const html = (owner: SessionOwner) => renderToStaticMarkup(createElement(OwnerBadge, { owner }));

describe('OwnerBadge', () => {
  it('shows the avatar, name and @login', () => {
    const h = html(ann);
    expect(h).toContain('src="https://avatars.githubusercontent.com/u/7?v=4"');
    expect(h).toMatch(/referrerpolicy="no-referrer"/i);
    expect(h).toContain('>Ann Example<');
    expect(h).toContain('>@ann<');
  });

  it('renders hostile text as text, and never loads an off-host avatar', () => {
    const h = html({ ...ann, name: '<img src=x onerror=alert(1)>', avatarUrl: 'https://evil.io/a.png' });
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).not.toContain('evil.io');
    expect(h).toContain('owner-initial');
  });

  it('automation runs read "automation", with no handle', () => {
    const h = html({ kind: 'automation', provider: 'fleet-host', id: '01JC0000000000000000000000', login: 'automation', name: null, avatarUrl: null });
    expect(h).toContain('>automation<');
    expect(h).not.toContain('@automation');
  });
});

// SessionsPane needs a DOM to mount, so D122's wiring is asserted by source text.
describe('SessionsPane Mine / Everyone wiring', () => {
  const pane = readFileSync(new URL('./SessionsPane.tsx', import.meta.url), 'utf8');
  it('defaults to Everyone, keeps the choice in component state only, and never sends it anywhere', () => {
    expect(pane).toContain("useState<OwnerFilter>('everyone')");
    const uses = pane.split('\n').filter((l) => /ownerFilter|ownerShown/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).not.toMatch(/window\.api|localStorage|sessionStorage|uiPrefs/);
  });
});
