// Icons for the portaled `.ws-chip-menu` dropdowns (#264) — previously
// duplicated per component (the pencil existed three times). All sized to a
// 12×12 viewBox so they sit on the menu's text baseline; `currentColor` lets
// each menu item pick up its hover/danger styling. Named by glyph, not by
// call-site action, since the same glyph serves different actions (the pencil
// is Edit… on a chip and Rename on a tab/row).

export function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M3 2 L10 6 L3 10 Z" />
    </svg>
  );
}
export function IconPause(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <rect x="3" y="2" width="2.4" height="8" rx="0.6" />
      <rect x="6.6" y="2" width="2.4" height="8" rx="0.6" />
    </svg>
  );
}
export function IconStop(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" rx="0.8" />
    </svg>
  );
}
export function IconEject(): JSX.Element {
  // Used for Close — eject is the natural "remove the media" sibling of
  // play/pause/stop, and reads as "take this out" instead of "delete."
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M6 2 L10 8 L2 8 Z" />
      <rect x="2" y="9" width="8" height="1.6" rx="0.4" />
    </svg>
  );
}
export function IconPencil(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M2 9 L9 2 L11 4 L4 11 L2 11 Z" />
    </svg>
  );
}
export function IconCopy(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="8" rx="0.8" />
      <path d="M2 8 V2 a1 1 0 0 1 1 -1 H8" />
    </svg>
  );
}
export function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M4 1 H8 V2 H11 V3 H1 V2 H4 Z M2 4 H10 L9 11 H3 Z" />
    </svg>
  );
}
export function IconRefresh(): JSX.Element {
  // Circular arrow — resume / refresh a session.
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 6 A4 4 0 1 1 8.6 3" />
      <path d="M10.4 1.6 L10.4 4 L8 4" />
    </svg>
  );
}
export function IconAuto(): JSX.Element {
  // A sparkle — "let Claude name it".
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M6 1 L7 4.5 L10.5 6 L7 7.5 L6 11 L5 7.5 L1.5 6 L5 4.5 Z" />
    </svg>
  );
}
