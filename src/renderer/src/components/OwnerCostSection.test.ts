import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerCostList, OwnerCostSection } from './OwnerCostSection';

describe('OwnerCostSection', () => {
  it('starts collapsed', () => {
    const h = renderToStaticMarkup(createElement(OwnerCostSection, { workspaceId: '01JC0000000000000000000000', refreshKey: null }));
    expect(h).toContain('Cost by owner');
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('obs-owner-list');
  });
});

describe('OwnerCostList', () => {
  const html = (rows: Parameters<typeof OwnerCostList>[0]['rows']) => renderToStaticMarkup(createElement(OwnerCostList, { rows }));
  it('lists owners as text, unattributed included', () => {
    const h = html([
      { owner: { kind: 'user', provider: 'github', id: '7', login: 'ann', name: '<b>Ann</b>', avatarUrl: null }, sessions: 2, usd: 3 },
      { owner: null, sessions: 1, usd: 0.5 }
    ]);
    expect(h).toContain('&lt;b&gt;Ann&lt;/b&gt;');
    expect(h).toContain('2 sessions');
    expect(h).toContain('$3.00');
    expect(h).toContain('Unattributed');
    expect(h).toContain('1 session<');
  });
  it('says loading, unavailable or empty', () => {
    expect(html(undefined)).toContain('Loading');
    expect(html(null)).toContain('Host unavailable');
    expect(html([])).toContain('No cost recorded yet');
  });
});
