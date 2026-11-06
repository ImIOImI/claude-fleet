import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECLARE_RATE_PER_MIN,
  DECLARE_WAIT_MS,
  PortExposureService,
  isEphemeralPort,
  type PortExposureDeps,
  type PortPopup
} from './portExposure.js';
import type { ExposurePatch, ExposureRow, ExposureSink } from './portExposureStore.js';
import type { ServingPort } from './portforward.js';

class FakeSink implements ExposureSink {
  rows = new Map<string, ExposureRow>();
  async insert(r: ExposureRow): Promise<void> {
    this.rows.set(r.id, { ...r });
  }
  async update(id: string, p: ExposurePatch): Promise<void> {
    const r = this.rows.get(id);
    if (!r) throw new Error(`update before insert: ${id}`);
    Object.assign(r, p);
  }
  all(): ExposureRow[] {
    return [...this.rows.values()];
  }
}

const WS = 'W-CONTAINER';
const LOCAL = 'W-LOCAL';
const STOPPED = 'W-STOPPED';
const REMOTE = 'W-REMOTE';
const T0 = 1_000_000;

const sp = (port: number, over: Partial<ServingPort> = {}): ServingPort => ({
  port, pid: 1, cmdline: 'node vite', sessionId: 'tab-1', firstSeenAt: 0, ...over
});

function setup(over: Partial<PortExposureDeps> = {}) {
  const sink = new FakeSink();
  const popups: PortPopup[] = [];
  const labels: string[] = [];
  const svc = new PortExposureService({
    sink,
    workspace: async (id) =>
      id === WS ? { kind: 'container', running: true }
      : id === LOCAL ? { kind: 'local', running: true }
      : id === STOPPED ? { kind: 'container', running: false }
      : id === REMOTE ? { kind: 'remote', running: true }
      : null,
    onPopup: (p) => popups.push(p),
    onLabelsChanged: (id) => labels.push(id),
    undeclaredToastAfterSec: async () => 0,
    probeLocal: async () => false,
    localPollMs: 1_000,
    ...over
  });
  return { svc, sink, popups, labels };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isEphemeralPort', () => {
  it('covers 32768–60999 inclusive', () => {
    expect([32767, 32768, 60999, 61000].map(isEphemeralPort)).toEqual([false, true, true, false]);
  });
});

describe('declare validation', () => {
  it.each([
    [{ label: 'x' }, /port must be/],
    [{ port: 0, label: 'x' }, /port must be/],
    [{ port: 3000.5, label: 'x' }, /port must be/],
    [{ port: 45000, label: 'x' }, /ephemeral range/],
    [{ port: 3000 }, /label is required/],
    [{ port: 3000, label: '   ' }, /label is required/],
    [{ port: 3000, label: 'x'.repeat(81) }, /label is required/],
    [{ port: 3000, label: 'x', reason: 'r'.repeat(201) }, /reason must be/]
  ])('rejects %j', async (args, err) => {
    const { svc } = setup();
    await expect(svc.declare(WS, args)).rejects.toThrow(err);
  });

  it('accepts a numeric-string port', async () => {
    const { svc } = setup();
    await expect(svc.declare(WS, { port: '5173', label: 'Vite' })).resolves.toEqual({ status: 'waiting' });
  });

  it('rejects unknown, stopped and remote workspaces', async () => {
    const { svc } = setup();
    await expect(svc.declare('nope', { port: 3000, label: 'x' })).rejects.toThrow(/unknown workspace/);
    await expect(svc.declare(STOPPED, { port: 3000, label: 'x' })).rejects.toThrow(/not running/);
    await expect(svc.declare(REMOTE, { port: 3000, label: 'x' })).rejects.toThrow(/remote/);
  });

  it('rate-limits each workspace to DECLARE_RATE_PER_MIN calls per minute', async () => {
    const { svc } = setup();
    for (let i = 0; i < DECLARE_RATE_PER_MIN; i++) await svc.declare(WS, { port: 3000 + i, label: 'x' });
    await expect(svc.declare(WS, { port: 4000, label: 'x' })).rejects.toThrow(/rate limited/);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(svc.declare(WS, { port: 4000, label: 'x' })).resolves.toEqual({ status: 'waiting' });
  });
});

describe('container lifecycle', () => {
  it('scan first: silent until declared, then one labeled popup', async () => {
    const { svc, sink, popups, labels } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    expect(popups).toEqual([]);
    expect(await svc.declare(WS, { port: 5173, label: 'Vite dev server', reason: 'UI changes' })).toEqual({ status: 'shown' });
    expect(popups).toEqual([
      { workspaceId: WS, port: 5173, label: 'Vite dev server', reason: 'UI changes', cmdline: 'node vite', declared: true }
    ]);
    expect(labels).toEqual([WS]);
    expect(svc.labelFor(WS, 5173)).toBe('Vite dev server');
    await svc.flush();
    expect(sink.all()).toEqual([
      expect.objectContaining({
        port: 5173, source: 'both', firstScannedAt: T0, declaredAt: T0, popupShownAt: T0, sessionId: 'tab-1', outcome: null
      })
    ]);
  });

  it('declare first: waiting, then the popup fires when the scan admits the port', async () => {
    const { svc, sink, popups } = setup();
    expect(await svc.declare(WS, { port: 3000, label: 'Docs' })).toEqual({ status: 'waiting' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(popups).toEqual([]);
    svc.onSnapshot(WS, [sp(3000)]);
    expect(popups.map((p) => [p.port, p.label, p.declared])).toEqual([[3000, 'Docs', true]]);
    await vi.advanceTimersByTimeAsync(DECLARE_WAIT_MS);
    await svc.flush();
    expect(sink.all()).toEqual([
      expect.objectContaining({ source: 'both', declaredAt: T0, firstScannedAt: T0 + 5_000, endedAt: null })
    ]);
  });

  it('a declared port that never serves ends as not_serving', async () => {
    const { svc, sink, popups } = setup();
    await svc.declare(WS, { port: 3000, label: 'Docs' });
    await vi.advanceTimersByTimeAsync(DECLARE_WAIT_MS);
    await svc.flush();
    expect(popups).toEqual([]);
    expect(sink.all()).toEqual([expect.objectContaining({ outcome: 'not_serving', endedAt: T0 + DECLARE_WAIT_MS })]);
    expect(svc.labelFor(WS, 3000)).toBeNull();
  });

  it('repeat declares before any scan never open a second row', async () => {
    const { svc, sink } = setup();
    await svc.declare(WS, { port: 3000, label: 'Docs' });
    await svc.declare(WS, { port: 3000, label: 'Docs v2' });
    await svc.declare(WS, { port: 3000, label: 'Docs v3' });
    await svc.flush();
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]).toMatchObject({ label: 'Docs v3' });
  });

  it('re-declaring a shown port updates the label without a second popup', async () => {
    const { svc, popups } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    await svc.declare(WS, { port: 5173, label: 'Vite' });
    expect(await svc.declare(WS, { port: 5173, label: 'Storybook' })).toEqual({ status: 'shown' });
    expect(popups).toHaveLength(1);
    expect(svc.labelFor(WS, 5173)).toBe('Storybook');
  });

  it('never records or pops up an ephemeral-range scanned port', async () => {
    const { svc, sink, popups } = setup({ undeclaredToastAfterSec: async () => 1 });
    svc.onSnapshot(WS, [sp(45000)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await svc.flush();
    expect(sink.all()).toEqual([]);
    expect(popups).toEqual([]);
  });

  it('a port that stops listening ends its row; its return opens a new row', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    svc.onSnapshot(WS, []);
    svc.onSnapshot(WS, [sp(8080)]);
    await svc.flush();
    const rows = sink.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: 'ignored', endedAt: T0 });
    expect(rows[1]).toMatchObject({ outcome: null, endedAt: null });
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it('updates owner attribution in place', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080, { sessionId: null })]);
    svc.onSnapshot(WS, [sp(8080, { sessionId: 'tab-2' })]);
    await svc.flush();
    expect(sink.all()).toEqual([expect.objectContaining({ sessionId: 'tab-2', endedAt: null })]);
  });
});

describe('outcomes', () => {
  it('dismiss then open: opened wins; first via and the count are kept', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(5173)]);
    await svc.declare(WS, { port: 5173, label: 'Vite' });
    svc.recordDismiss(WS, 5173);
    svc.recordOpen(WS, 5173, 'rail');
    svc.recordOpen(WS, 5173, 'popup');
    svc.recordDismiss(WS, 5173);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ outcome: 'opened', openedVia: 'rail', openCount: 2 });
  });

  it('an undeclared port opened from the rail is the missed-declaration signal', async () => {
    const { svc, sink } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    svc.recordOpen(WS, 8080, 'rail');
    svc.onSnapshot(WS, []);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ source: 'scanned', declaredAt: null, openCount: 1, outcome: 'opened', endedAt: T0 });
  });

  it('ignores opens and dismisses for ports it does not track', async () => {
    const { svc, sink } = setup();
    svc.recordOpen(WS, 1234, 'rail');
    svc.recordDismiss(WS, 1234);
    await svc.flush();
    expect(sink.all()).toEqual([]);
  });
});

describe('undeclared fallback', () => {
  it('pops up an undeclared port after N seconds when configured', async () => {
    const { svc, popups } = setup({ undeclaredToastAfterSec: async () => 60 });
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(popups).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(popups).toEqual([{ workspaceId: WS, port: 8080, label: null, reason: null, cmdline: 'node vite', declared: false }]);
  });

  it('a declaration before the deadline replaces the fallback', async () => {
    const { svc, popups } = setup({ undeclaredToastAfterSec: async () => 60 });
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await svc.declare(WS, { port: 8080, label: 'API' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(popups.map((p) => p.declared)).toEqual([true]);
  });

  it('is off at 0', async () => {
    const { svc, popups } = setup();
    svc.onSnapshot(WS, [sp(8080)]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(popups).toEqual([]);
  });
});

describe('local workspaces', () => {
  it('polls the host probe and pops up once the port answers', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { svc, sink, popups } = setup({ probeLocal: probe });
    expect(await svc.declare(LOCAL, { port: 5173, label: 'Vite' })).toEqual({ status: 'waiting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(popups).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(popups.map((p) => [p.workspaceId, p.port])).toEqual([[LOCAL, 5173]]);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ source: 'declared', firstScannedAt: T0 + 1_000 });
  });

  it('ends after two consecutive failed probes', async () => {
    let up = true;
    const { svc, sink } = setup({ probeLocal: async () => up });
    await svc.declare(LOCAL, { port: 5173, label: 'Vite' });
    await vi.advanceTimersByTimeAsync(0);
    up = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(false);
    await svc.flush();
    expect(sink.all()[0]).toMatchObject({ outcome: 'ignored', endedAt: T0 + 2_000 });
  });

  it('container snapshots never end a local row', async () => {
    const { svc } = setup({ probeLocal: async () => true });
    await svc.declare(LOCAL, { port: 5173, label: 'Vite' });
    await vi.advanceTimersByTimeAsync(0);
    svc.onSnapshot(LOCAL, []);
    expect(svc.isLocalServing(LOCAL, 5173)).toBe(true);
    svc.dispose();
  });
});
