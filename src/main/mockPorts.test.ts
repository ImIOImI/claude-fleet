import { describe, it, expect, vi } from 'vitest';
import { MockServingPorts } from './mockPorts.js';
import type { ServingPort } from './portforward.js';

describe('MockServingPorts', () => {
  it('emits fake ports on schedule and clears on departure', () => {
    vi.useFakeTimers();
    const changes: Array<{ id: string; ports: ServingPort[] }> = [];
    const mock = new MockServingPorts((id, ports) => changes.push({ id, ports }), () => 0);

    mock.reconcile(['ws1']);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(changes).toHaveLength(1);
    expect(changes[0].ports.map((p) => p.port)).toEqual([3000]);
    expect(changes[0].ports[0].pid).not.toBeNull();
    expect(changes[0].ports[0].cmdline).toContain('vite');

    vi.advanceTimersByTime(15_000);
    expect(changes).toHaveLength(2);
    expect(changes[1].ports.map((p) => p.port)).toEqual([3000, 8765]);
    expect(mock.snapshot()).toEqual([{ workspaceId: 'ws1', ports: changes[1].ports }]);

    mock.reconcile([]); // workspace stopped
    expect(changes).toHaveLength(3);
    expect(changes[2].ports).toEqual([]);
    expect(mock.snapshot()).toEqual([]);

    mock.dispose();
    vi.useRealTimers();
  });

  it('reconcile is idempotent (no duplicate timers)', () => {
    vi.useFakeTimers();
    const changes: unknown[] = [];
    const mock = new MockServingPorts(() => changes.push(1), () => 0);
    mock.reconcile(['ws1']);
    mock.reconcile(['ws1']);
    vi.advanceTimersByTime(60_000);
    expect(changes).toHaveLength(2); // one per fake port, not four
    mock.dispose();
    vi.useRealTimers();
  });

  it('kill removes the port and emits', () => {
    vi.useFakeTimers();
    const changes: Array<{ ports: ServingPort[] }> = [];
    const mock = new MockServingPorts((_id, ports) => changes.push({ ports }), () => 0);
    mock.reconcile(['ws1']);
    vi.advanceTimersByTime(30_000); // both fakes live
    const res = mock.kill('ws1', 3000);
    expect(res.ok).toBe(true);
    expect(changes.at(-1)!.ports.map((p) => p.port)).toEqual([8765]);
    mock.dispose();
    vi.useRealTimers();
  });
});
