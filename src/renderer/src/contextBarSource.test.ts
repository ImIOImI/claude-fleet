import { describe, it, expect } from 'vitest';
import { contextBarSummary } from './contextBarSource';

// Stand-in summaries — only identity matters for the selection decision.
const workspaceSummary = { lastTurnContextTokens: 5000, contextWindowTokens: 200_000 };
const activeTabSummary = { lastTurnContextTokens: 120_000, contextWindowTokens: 200_000 };

describe('contextBarSummary', () => {
  // #148: the selected workspace's terminal context bar must reflect the ACTIVE
  // TAB's session (like the observability rail), not the workspace-level summary
  // that is identical across every tab.
  it('selected pane uses the active-tab summary, not the workspace summary', () => {
    expect(contextBarSummary(true, activeTabSummary, workspaceSummary)).toBe(activeTabSummary);
  });

  it('off-screen (non-selected) panes keep the workspace summary', () => {
    expect(contextBarSummary(false, activeTabSummary, workspaceSummary)).toBe(workspaceSummary);
  });

  it('selected pane shows null (fresh/unmapped tab) rather than the workspace value', () => {
    // A just-created tab has no per-tab summary yet — matching the rail, the bar
    // shows the empty/identity state instead of borrowing the workspace number.
    expect(contextBarSummary(true, null, workspaceSummary)).toBeNull();
  });
});
