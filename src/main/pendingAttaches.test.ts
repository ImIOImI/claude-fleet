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

  // FIFO matching: when multiple are pending for the same workspace,
  // consume the oldest. The previous "skip when count > 1" rule left
  // the user-reported "open new workspace, type in main → no
  // observability data" scenario broken; FIFO trades the rare
  // race-induced swapped mapping for the common case of N attaches +
  // N JSONLs all mapped correctly in order.
  it('returns the oldest pending attach when multiple are pending (FIFO)', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-2', 1_050);
    expect(consumeForWorkspace('ws-a', 1_500)).toBe('broker-1');
    // broker-2 still queued; next consume returns it.
    expect(consumeForWorkspace('ws-a', 1_600)).toBe('broker-2');
    // Now empty.
    expect(consumeForWorkspace('ws-a', 1_700)).toBeNull();
  });

  it('drains N pending attaches over N consume calls in insertion order', () => {
    // The exact pattern from the user-reported bug: 3 tabs created in
    // quick succession, 3 JSONLs follow. Each new-session fires
    // consumeForWorkspace; under FIFO all three pair up correctly.
    recordPendingAttach('ws-a', 'broker-main', 1_000);
    recordPendingAttach('ws-a', 'broker-s2', 1_010);
    recordPendingAttach('ws-a', 'broker-s3', 1_020);
    expect(consumeForWorkspace('ws-a', 1_100)).toBe('broker-main');
    expect(consumeForWorkspace('ws-a', 1_110)).toBe('broker-s2');
    expect(consumeForWorkspace('ws-a', 1_120)).toBe('broker-s3');
    expect(consumeForWorkspace('ws-a', 1_130)).toBeNull();
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
    // Two entries → FIFO returns the older one; the second consume
    // returns the second one.
    expect(consumeForWorkspace('ws-a', 1_500)).toBe('broker-1');
    expect(consumeForWorkspace('ws-a', 1_600)).toBe('broker-2');
  });
});
