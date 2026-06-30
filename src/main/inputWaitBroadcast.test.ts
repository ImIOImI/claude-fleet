import { describe, it, expect, vi } from 'vitest';
import { broadcastInputWait } from './inputWaitBroadcast';

function win(destroyed = false, wcDestroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => wcDestroyed, send: vi.fn() }
  };
}

describe('broadcastInputWait', () => {
  it('sends inputwait:update to live targets', () => {
    const a = win(); const b = win();
    broadcastInputWait({ workspaceId: 'ws', waitingSessionIds: ['s1'] }, [a, b]);
    expect(a.webContents.send).toHaveBeenCalledWith('inputwait:update', { workspaceId: 'ws', waitingSessionIds: ['s1'] });
    expect(b.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('skips destroyed targets and survives a throwing one', () => {
    const dead = win(true);
    const boom = win(); boom.webContents.send = vi.fn(() => { throw new Error('disposed'); });
    const ok = win();
    expect(() => broadcastInputWait({ workspaceId: 'ws', waitingSessionIds: [] }, [dead, boom, ok])).not.toThrow();
    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(ok.webContents.send).toHaveBeenCalledTimes(1);
  });
});
