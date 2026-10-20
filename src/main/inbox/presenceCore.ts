// Pure desktop-presence rules (#407 Phase 2b): the "needs you" count and which
// tray / taskbar-overlay image, tooltip and dock badge show it. One rule
// everywhere: 1 → dot, ≥2 → count (tray stays dot-only); red if anything
// urgent, otherwise violet. Ordinary open todos never count.
import type { InboxCounts } from '../../preload/inboxTypes.js';

export interface NeedsYou {
  count: number;
  severity: 'urgent' | 'wait' | 'none';
  urgent: number;
  waiting: number;
  approvals: number;
}

export function needsYou(urgentTodos: number, waitingWorkspaces: number, approvals = 0): NeedsYou {
  const count = urgentTodos + waitingWorkspaces + approvals;
  return { count, severity: urgentTodos > 0 ? 'urgent' : count > 0 ? 'wait' : 'none', urgent: urgentTodos, waiting: waitingWorkspaces, approvals };
}

/** Windows taskbar overlay image name (resources/presence/<name>.png), or null for none. */
export function overlayAsset(n: NeedsYou): string | null {
  if (n.severity === 'none') return null;
  if (n.count === 1) return `overlay-${n.severity}`;
  return `overlay-${n.severity}-${n.count > 9 ? '9plus' : n.count}`;
}

export function trayAsset(n: NeedsYou, px: 16 | 32): string {
  return `tray-${n.severity}-${px}`;
}

export function dockBadge(n: NeedsYou): string {
  return n.count > 0 ? String(n.count) : '';
}

export function tooltip(product: string, n: NeedsYou, counts: InboxCounts, quiet: string | null): string {
  const parts = [counts.open ? `${counts.open} open` : 'nothing open'];
  if (counts.urgent) parts.push(`${counts.urgent} urgent`);
  if (n.waiting) parts.push(`${n.waiting} waiting for input`);
  if (n.approvals) parts.push(`${n.approvals} to approve`);
  return `${product}: ${parts.join(' · ')}${quiet ? ` · ${quiet}` : ''}`;
}

export function overlayDescription(n: NeedsYou): string {
  if (n.severity === 'none') return '';
  return `${n.count} ${n.count === 1 ? 'thing needs' : 'things need'} you${n.urgent ? `, ${n.urgent} urgent` : ''}`;
}
