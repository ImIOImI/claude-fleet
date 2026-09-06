import { describe, expect, it, vi } from 'vitest';
import { makeTrailingRebroadcast } from './trailingBroadcast.js';

// Inject fake timers so tests run synchronously and without wall-clock delays.

describe('makeTrailingRebroadcast', () => {
  function fakeDeps() {
    const pending = new Map<number, { fn: () => void; at: number }>();
    let now = 0;
    let nextId = 1;

    const st = (fn: () => void, ms: number) => {
      const id = nextId++ as unknown as ReturnType<typeof globalThis.setTimeout>;
      pending.set(id as unknown as number, { fn, at: now + ms });
      return id;
    };
    const ct = (id: ReturnType<typeof globalThis.setTimeout>) => {
      pending.delete(id as unknown as number);
    };
    const advance = (ms: number) => {
      now += ms;
      for (const [id, { fn, at }] of [...pending.entries()]) {
        if (at <= now) {
          pending.delete(id);
          fn();
        }
      }
    };
    return { st, ct, advance, pending };
  }

  it('fires once after the delay when schedule is called once', () => {
    const { st, ct, advance } = fakeDeps();
    const fired: string[] = [];
    const rb = makeTrailingRebroadcast(3000, (id) => fired.push(id), { setTimeout: st, clearTimeout: ct });

    rb.schedule('ws-a');
    expect(fired).toEqual([]);
    advance(3000);
    expect(fired).toEqual(['ws-a']);
  });

  it('N rapid calls produce exactly one fire at delayMs after the last call', () => {
    const { st, ct, advance } = fakeDeps();
    const fired: string[] = [];
    const rb = makeTrailingRebroadcast(3000, (id) => fired.push(id), { setTimeout: st, clearTimeout: ct });

    rb.schedule('ws-b');
    advance(1000);
    rb.schedule('ws-b');
    advance(1000);
    rb.schedule('ws-b');
    // 1000ms after the third call — should NOT have fired yet
    advance(1000);
    expect(fired).toEqual([]);
    // Now advance the remaining 2000ms to reach delay after last call
    advance(2000);
    expect(fired).toEqual(['ws-b']);
    // No duplicate fire after further time passes
    advance(5000);
    expect(fired).toEqual(['ws-b']);
  });

  it('a call during the pending window resets the timer', () => {
    const { st, ct, advance } = fakeDeps();
    const fired: string[] = [];
    const rb = makeTrailingRebroadcast(3000, (id) => fired.push(id), { setTimeout: st, clearTimeout: ct });

    rb.schedule('ws-c');
    advance(2999); // almost at the delay
    rb.schedule('ws-c'); // reset
    advance(1); // original timer would have fired here — but it was cleared
    expect(fired).toEqual([]);
    advance(2999); // 3000ms after the second call
    expect(fired).toEqual(['ws-c']);
  });

  it('dispose cancels all pending timers', () => {
    const { st, ct, advance } = fakeDeps();
    const fired: string[] = [];
    const rb = makeTrailingRebroadcast(3000, (id) => fired.push(id), { setTimeout: st, clearTimeout: ct });

    rb.schedule('ws-d');
    rb.schedule('ws-e');
    rb.dispose();
    advance(10000);
    expect(fired).toEqual([]);
  });

  it('independent workspaces have independent timers', () => {
    const { st, ct, advance } = fakeDeps();
    const fired: string[] = [];
    const rb = makeTrailingRebroadcast(3000, (id) => fired.push(id), { setTimeout: st, clearTimeout: ct });

    rb.schedule('ws-x');
    advance(1000);
    rb.schedule('ws-y');
    advance(2000); // ws-x fires at 3000ms total; ws-y still pending
    expect(fired).toEqual(['ws-x']);
    advance(1000); // ws-y fires at 3000ms after its own call
    expect(fired).toEqual(['ws-x', 'ws-y']);
  });
});
