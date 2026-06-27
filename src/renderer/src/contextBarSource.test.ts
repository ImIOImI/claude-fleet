import { describe, it, expect } from 'vitest';
import { contextBarSummary } from './contextBarSource';

// Stand-in summaries — only identity matters for the selection decision.
const workspaceSummary = { lastTurnContextTokens: 5000, contextWindowTokens: 200_000 };
const activeTabSummary = { lastTurnContextTokens: 120_000, contextWindowTokens: 200_000 };

describe('contextBarSummary', () => {
  // #148: the selected workspace's terminal context bar must reflect the ACTIVE
  // TAB's session (like the observability rail), not the workspace-level summary
  // that is identical across every tab.
  it('selected pane uses the active-tab summary when it has one', () => {
    expect(contextBarSummary(true, activeTabSummary, workspaceSummary, false)).toBe(activeTabSummary);
    // …regardless of whether the tab is fresh.
    expect(contextBarSummary(true, activeTabSummary, workspaceSummary, true)).toBe(activeTabSummary);
  });

  it('off-screen (non-selected) panes keep the workspace summary', () => {
    expect(contextBarSummary(false, activeTabSummary, workspaceSummary, false)).toBe(workspaceSummary);
  });

  // #148 fallback rules (mirroring the rail): when the per-tab summary hasn't
  // resolved yet, a fresh (+-created) tab shows the empty/identity state, while
  // an inventory/loaded tab falls back to the workspace summary so the bar
  // still surfaces activity until the broker_sessions mapping catches up.
  it('selected fresh tab with no per-tab summary shows identity (null)', () => {
    expect(contextBarSummary(true, null, workspaceSummary, true)).toBeNull();
  });

  it('selected inventory tab with no per-tab summary falls back to the workspace summary', () => {
    expect(contextBarSummary(true, null, workspaceSummary, false)).toBe(workspaceSummary);
  });
});
