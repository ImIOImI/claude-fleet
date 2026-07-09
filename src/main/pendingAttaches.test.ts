import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumeForWorkspace,
  recordPendingAttach,
  removePendingAttach,
  pendingSnapshotForWorkspace,
  _resetForTests,
} from './pendingAttaches.js';

beforeEach(() => {
  _resetForTests();
});

describe('pendingAttaches', () => {
  it('returns the recorded broker session for a single matching workspace', () => {
    recordPendingAttach('ws-a', 'broker-1');
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
  });

  it('removes the entry on successful consume (one-shot)', () => {
    recordPendingAttach('ws-a', 'broker-1');
    consumeForWorkspace('ws-a');
    // Second consume sees nothing.
    expect(consumeForWorkspace('ws-a')).toBeNull();
  });

  it('returns null when nothing is pending for the workspace', () => {
    recordPendingAttach('ws-other', 'broker-x');
    expect(consumeForWorkspace('ws-a')).toBeNull();
  });

  // FIFO matching: when multiple are pending for the same workspace,
  // consume the oldest. Trades the rare race-induced swapped mapping
  // for the common case of N attaches + N JSONLs all mapped in order.
  it('returns the oldest pending attach when multiple are pending (FIFO)', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-2', 1_050);
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
    expect(consumeForWorkspace('ws-a')).toBe('broker-2');
    expect(consumeForWorkspace('ws-a')).toBeNull();
  });

  it('drains N pending attaches over N consume calls in insertion order', () => {
    recordPendingAttach('ws-a', 'broker-main', 1_000);
    recordPendingAttach('ws-a', 'broker-s2', 1_010);
    recordPendingAttach('ws-a', 'broker-s3', 1_020);
    expect(consumeForWorkspace('ws-a')).toBe('broker-main');
    expect(consumeForWorkspace('ws-a')).toBe('broker-s2');
    expect(consumeForWorkspace('ws-a')).toBe('broker-s3');
    expect(consumeForWorkspace('ws-a')).toBeNull();
  });

  // The actual user bug: a pending attach must survive long enough for
  // the user to come back and type. claude doesn't write its first
  // JSONL until the user types in the session, and that delay can be
  // minutes-to-hours. The previous 30s TTL was the cause of the
  // user-reported "main shows no observability data" symptom.
  it('keeps pending entries alive across arbitrarily long delays (no TTL)', () => {
    // Simulate: pending recorded an hour ago. Under the old 30s TTL
    // this would be pruned and return null. Under the no-TTL fix the
    // entry is still there.
    recordPendingAttach('ws-a', 'broker-1', Date.now() - 60 * 60_000);
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
  });

  it('isolates workspaces — multiple attaches across workspaces still resolve individually', () => {
    recordPendingAttach('ws-a', 'broker-a');
    recordPendingAttach('ws-b', 'broker-b');
    expect(consumeForWorkspace('ws-a')).toBe('broker-a');
    expect(consumeForWorkspace('ws-b')).toBe('broker-b');
  });

  it('dedupes re-records of the same (workspace, broker_session) into one entry', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-1', 1_100); // refresh, same id
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
    // No second entry to consume.
    expect(consumeForWorkspace('ws-a')).toBeNull();
  });

  it('does not dedupe distinct broker ids in the same workspace', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-a', 'broker-2', 1_001);
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
    expect(consumeForWorkspace('ws-a')).toBe('broker-2');
  });

  describe('removePendingAttach', () => {
    it('drops a specific pending entry without consuming it', () => {
      recordPendingAttach('ws-a', 'broker-1');
      recordPendingAttach('ws-a', 'broker-2');
      removePendingAttach('ws-a', 'broker-1');
      // First consume now skips past broker-1 and returns broker-2.
      expect(consumeForWorkspace('ws-a')).toBe('broker-2');
      expect(consumeForWorkspace('ws-a')).toBeNull();
    });

    it('is a no-op when the (workspace, broker_session) is not pending', () => {
      recordPendingAttach('ws-a', 'broker-1');
      removePendingAttach('ws-a', 'broker-not-here');
      removePendingAttach('ws-other', 'broker-1');
      // Original entry untouched.
      expect(consumeForWorkspace('ws-a')).toBe('broker-1');
    });
  });
});

describe('pendingSnapshotForWorkspace', () => {
  it('returns pending entries for the workspace only, oldest first, without consuming', () => {
    recordPendingAttach('ws-a', 'broker-1', 1_000);
    recordPendingAttach('ws-b', 'broker-x', 1_025);
    recordPendingAttach('ws-a', 'broker-2', 1_050);
    expect(pendingSnapshotForWorkspace('ws-a')).toEqual([
      { brokerSessionId: 'broker-1', recordedAt: 1_000 },
      { brokerSessionId: 'broker-2', recordedAt: 1_050 },
    ]);
    // Snapshot is a read — the queue is untouched.
    expect(consumeForWorkspace('ws-a')).toBe('broker-1');
  });

  it('returns [] when nothing is pending', () => {
    expect(pendingSnapshotForWorkspace('ws-a')).toEqual([]);
  });
});
