import { describe, expect, it } from 'vitest';
import { leftAnchor, rightAnchor } from './portalMenu';

// Anchor math for the portaled ⋮ menus (#264). Geometry contract:
// MENU_WIDTH=188 (the widest .ws-chip-menu incl. padding/border slack),
// VIEWPORT_MARGIN=8, TRIGGER_GAP=4 — values carried over verbatim from the
// three pre-extraction copies (WorkspaceTabStrip / TerminalPane / SessionsPane).

const rect = (left: number, right: number, bottom: number) => ({ left, right, bottom });

describe('leftAnchor', () => {
  it('passes the trigger left edge through when the menu fits', () => {
    expect(leftAnchor(rect(100, 120, 50), 1000)).toEqual({ top: 54, left: 100 });
  });

  it('clamps so the menu cannot overflow the right viewport edge', () => {
    // innerWidth 1000 - MENU_WIDTH 188 = 812 max left.
    expect(leftAnchor(rect(900, 920, 50), 1000).left).toBe(812);
  });

  it('floors at the viewport margin on a viewport narrower than the menu', () => {
    // innerWidth 100 → innerWidth - 188 is negative → floor at 8.
    expect(leftAnchor(rect(50, 70, 50), 100).left).toBe(8);
  });

  it('drops the menu below the trigger with a 4px gap', () => {
    expect(leftAnchor(rect(0, 20, 33), 1000).top).toBe(37);
  });
});

describe('rightAnchor', () => {
  it('mirrors the trigger right edge as a distance from the viewport right edge', () => {
    expect(rightAnchor(rect(900, 950, 50), 1000)).toEqual({ top: 54, right: 50 });
  });

  it('floors at the viewport margin when the trigger touches the right edge', () => {
    expect(rightAnchor(rect(960, 998, 50), 1000).right).toBe(8);
  });
});
