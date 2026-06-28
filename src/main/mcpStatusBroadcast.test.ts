// Unit tests for the pure mcp:status broadcaster (mirrors
// observabilityBroadcast.test.ts). No electron — plain stub targets.

import { describe, expect, it, vi } from 'vitest';
import { broadcastMcpStatus, type BroadcastTarget } from './mcpStatusBroadcast.js';

function target(opts: { destroyed?: boolean; wcDestroyed?: boolean; throws?: boolean } = {}): {
  t: BroadcastTarget;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => {
    if (opts.throws) throw new Error('Render frame was disposed');
  });
  return {
    send,
    t: {
      isDestroyed: () => !!opts.destroyed,
      webContents: { isDestroyed: () => !!opts.wcDestroyed, send }
    }
  };
}

describe('broadcastMcpStatus', () => {
  it('sends the status to every live target on the mcp:status channel', () => {
    const a = target();
    const b = target();
    broadcastMcpStatus({ ok: false, detail: 'EADDRINUSE' }, [a.t, b.t]);
    expect(a.send).toHaveBeenCalledWith('mcp:status', { ok: false, detail: 'EADDRINUSE' });
    expect(b.send).toHaveBeenCalledWith('mcp:status', { ok: false, detail: 'EADDRINUSE' });
  });

  it('skips destroyed windows and destroyed webContents', () => {
    const dead = target({ destroyed: true });
    const wcDead = target({ wcDestroyed: true });
    broadcastMcpStatus({ ok: true }, [dead.t, wcDead.t]);
    expect(dead.send).not.toHaveBeenCalled();
    expect(wcDead.send).not.toHaveBeenCalled();
  });

  it('swallows a per-target send throw and keeps going', () => {
    const bad = target({ throws: true });
    const good = target();
    expect(() => broadcastMcpStatus({ ok: true }, [bad.t, good.t])).not.toThrow();
    expect(good.send).toHaveBeenCalledWith('mcp:status', { ok: true });
  });
});
