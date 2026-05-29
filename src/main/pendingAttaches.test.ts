import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumeForWorkspace,
  recordPendingAttach,
  _resetForTests,
  DEFAULT_WINDOW_MS,
} from './pendingAttaches.js';

beforeEach(() => {
  _resetForTests();
});

describe('pendingAttaches', () => {
  it('returns the recorded broker session for a single matching workspace', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    expect(consumeForWorkspace('ws-a', 1_500)).toBe('broker-1');
  });

  it('removes the entry on successful consume (one-shot)', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    consumeForWorkspace('ws-a', 1_500);
    // Second consume sees nothing.
    expect(consumeForWorkspace('ws-a', 1_600)).toBeNull();
  });

  it('returns null when nothing is pending for the workspace', () => {
    recordPendingAttach('ws-other', 'broker-x', 1_000);
    expect(consumeForWorkspace('ws-a', 1_500)).toBeNull();
  });

  // The conservative disambiguation rule: multiple concurrent attaches
  // for the same workspace cannot be reliably paired with arriving
  // JSONLs in order (broker goroutines race), so we skip mapping
  // entirely. The caller's fallback (summaryForWorkspace) keeps the UI
  // working — wrong mapping is strictly worse than no mapping.
  it('returns null when more than one attach is pending for the same workspace', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-2', 1_050);
    expect(consumeForWorkspace('ws-a', 1_500)).toBeNull();
    // Both entries remain pending — neither was consumed.
    expect(consumeForWorkspace('ws-a', 1_600)).toBeNull();
  });

  it('ignores expired entries (older than the window)', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    const now = 1_000 + DEFAULT_WINDOW_MS + 1;
    expect(consumeForWorkspace('ws-a', now)).toBeNull();
  });

  it('prunes expired entries even when not consumed', () => {
    recordPendingAttach('ws-a', 'broker-old', 1_000);
    recordPendingAttach('ws-a', 'broker-new', 1_000 + DEFAULT_WINDOW_MS + 100);
    // Older one is expired by the time we consume; the newer one is
    // alone and gets returned. Without pruning, this would fail the
    // single-match rule.
    expect(consumeForWorkspace('ws-a', 1_000 + DEFAULT_WINDOW_MS + 500)).toBe(
      'broker-new'
    );
  });

  it('isolates workspaces — multiple attaches across workspaces still resolve individually', () => {
    recordPendingAttach('ws-a', 'broker-a', 1_000);
    recordPendingAttach('ws-b', 'broker-b', 1_001);
    expect(consumeForWorkspace('ws-a', 1_500)).toBe('broker-a');
    expect(consumeForWorkspace('ws-b', 1_500)).toBe('broker-b');
  });

  it('dedupes re-records of the same (workspace, broker_session) into one entry', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-1', 1_100); // refresh, same id
    // Still one entry → single-match rule passes.
    expect(consumeForWorkspace('ws-a', 1_500)).toBe('broker-1');
  });

  it('does not dedupe distinct broker ids in the same workspace', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-2', 1_001);
    // Two entries → single-match rule fails.
    expect(consumeForWorkspace('ws-a', 1_500)).toBeNull();
  });
});
