import { describe, it, expect } from 'vitest';
import { needsYou, overlayAsset, trayAsset, dockBadge, tooltip, overlayDescription } from './presenceCore.js';

describe('needs you', () => {
  it('counts urgent todos, waiting workspaces and approvals; red when anything is urgent', () => {
    expect(needsYou(0, 0)).toEqual({ count: 0, severity: 'none', urgent: 0, waiting: 0, approvals: 0 });
    expect(needsYou(0, 1)).toMatchObject({ count: 1, severity: 'wait' });
    expect(needsYou(1, 2, 1)).toMatchObject({ count: 4, severity: 'urgent' });
  });
  it('one item is a dot, two or more a count, capped at 9+', () => {
    expect(overlayAsset(needsYou(0, 0))).toBeNull();
    expect(overlayAsset(needsYou(0, 1))).toBe('overlay-wait');
    expect(overlayAsset(needsYou(1, 0))).toBe('overlay-urgent');
    expect(overlayAsset(needsYou(0, 3))).toBe('overlay-wait-3');
    expect(overlayAsset(needsYou(12, 0))).toBe('overlay-urgent-9plus');
  });
  it('the tray is always a dot; the dock shows the number', () => {
    expect(trayAsset(needsYou(0, 0), 16)).toBe('tray-none-16');
    expect(trayAsset(needsYou(0, 5), 32)).toBe('tray-wait-32');
    expect(dockBadge(needsYou(0, 0))).toBe('');
    expect(dockBadge(needsYou(1, 3))).toBe('4');
  });
  it('words the tooltip and overlay description', () => {
    expect(tooltip('claude-fleet', needsYou(1, 2), { open: 7, urgent: 1, high: 0 }, 'paused until 15:30'))
      .toBe('claude-fleet: 7 open · 1 urgent · 2 waiting for input · paused until 15:30');
    expect(tooltip('claude-fleet', needsYou(0, 0), { open: 0, urgent: 0, high: 0 }, null)).toBe('claude-fleet: nothing open');
    expect(overlayDescription(needsYou(1, 2))).toBe('3 things need you, 1 urgent');
    expect(overlayDescription(needsYou(0, 1))).toBe('1 thing needs you');
  });
});

import { existsSync } from 'node:fs';
import path from 'node:path';

describe('presence assets', () => {
  it('every image name presenceCore can return exists in resources/presence (and the app icon)', () => {
    const dir = path.resolve(__dirname, '../../../resources/presence');
    const names = new Set<string>();
    for (let u = 0; u <= 12; u++) for (let w = 0; w <= 12; w++) {
      const n = needsYou(u, w);
      const o = overlayAsset(n);
      if (o) names.add(o);
      names.add(trayAsset(n, 16));
      names.add(trayAsset(n, 32));
    }
    names.add('window-256');
    const missing = [...names].filter((n) => !existsSync(path.join(dir, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(existsSync(path.resolve(__dirname, '../../../resources/icon.png'))).toBe(true);
  });
});
