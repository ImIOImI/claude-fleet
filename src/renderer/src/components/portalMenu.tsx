// Shared mechanics for the portaled ⋮ dropdown menus (#264) — the workspace
// chips (WorkspaceTabStrip), session tabs (TerminalPane), and session rows
// (SessionsPane) all render the same `.ws-chip-menu` pattern: one open menu
// per component, `position: fixed` at viewport coordinates, closed on any
// outside click / Escape / layout disturbance. This module owns the anchor
// state, the close listeners, and the position math; menu *contents* stay in
// each component.

import { useEffect, useState } from 'react';

// Geometry shared by the anchor helpers. MENU_WIDTH is the widest rendered
// `.ws-chip-menu` (CSS min-width 160px + padding/border slack) — used to
// clamp a left-anchored menu fully on-screen.
const MENU_WIDTH = 188;
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

export interface MenuAnchor {
  /** Id of the chip / tab / row whose menu is open. */
  id: string;
  top: number;
  left?: number;
  right?: number;
}

/** The subset of DOMRect the anchor math reads — pure and unit-testable. */
export interface AnchorRect {
  left: number;
  right: number;
  bottom: number;
}

/** Anchor to the trigger's bottom-left corner, clamped on-screen. */
export function leftAnchor(rect: AnchorRect, innerWidth: number): { top: number; left: number } {
  return {
    top: rect.bottom + TRIGGER_GAP,
    left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, innerWidth - MENU_WIDTH))
  };
}

/** Anchor to the trigger's bottom-right corner (menu grows leftward). */
export function rightAnchor(rect: AnchorRect, innerWidth: number): { top: number; right: number } {
  return {
    top: rect.bottom + TRIGGER_GAP,
    right: Math.max(VIEWPORT_MARGIN, innerWidth - rect.right)
  };
}

/**
 * One-open-menu-at-a-time state for a portaled dropdown. `toggle` closes the
 * menu when it is already open for `id`, otherwise opens it anchored to the
 * trigger (left-anchored by default; `'right'` for right-aligned menus like
 * the workspace chips'). The trigger's click handler must stopPropagation so
 * the opening click doesn't reach the document-level close listener.
 */
export function usePortalMenu(): {
  menu: MenuAnchor | null;
  toggle: (trigger: HTMLElement, id: string, side?: 'left' | 'right') => void;
  close: () => void;
} {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  // Close the menu on any outside click / Escape / layout shift (the portal is
  // positioned in viewport coords, so we can't follow the trigger when it
  // moves). Scroll uses the capture phase: scroll events don't bubble, but
  // capture on window still sees descendant scrolls (the lists scroll, not
  // the window).
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const toggle = (trigger: HTMLElement, id: string, side: 'left' | 'right' = 'left'): void => {
    setMenu((prev) => {
      if (prev?.id === id) return null;
      const rect = trigger.getBoundingClientRect();
      return {
        id,
        ...(side === 'right' ? rightAnchor(rect, window.innerWidth) : leftAnchor(rect, window.innerWidth))
      };
    });
  };

  return { menu, toggle, close: () => setMenu(null) };
}
