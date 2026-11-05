import { describe, it, expect, vi } from 'vitest';
import {
  broadcastObservabilitySummary,
  latestWins,
  type BroadcastTarget,
} from './observabilityBroadcast.js';

function fakeWindow(opts: {
  destroyed?: boolean;
  webContentsDestroyed?: boolean;
  sendThrows?: Error;
}): BroadcastTarget & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn((_channel: string, _payload: unknown) => {
    if (opts.sendThrows) throw opts.sendThrows;
  });
  return {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      isDestroyed: () => opts.webContentsDestroyed ?? false,
      send,
    },
    send,
  };
}

const PAYLOAD = { workspaceId: 'ws', summary: null };

describe('broadcastObservabilitySummary', () => {
  it('sends to every live window on the observability:summary channel', () => {
    const a = fakeWindow({});
    const b = fakeWindow({});
    broadcastObservabilitySummary(PAYLOAD, [a, b]);
    expect(a.send).toHaveBeenCalledWith('observability:summary', PAYLOAD);
    expect(b.send).toHaveBeenCalledWith('observability:summary', PAYLOAD);
  });

  it('skips windows whose isDestroyed() is true', () => {
    const dead = fakeWindow({ destroyed: true });
    const live = fakeWindow({});
    broadcastObservabilitySummary(PAYLOAD, [dead, live]);
    expect(dead.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledOnce();
  });

  it('skips windows whose webContents.isDestroyed() is true', () => {
    const dead = fakeWindow({ webContentsDestroyed: true });
    const live = fakeWindow({});
    broadcastObservabilitySummary(PAYLOAD, [dead, live]);
    expect(dead.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledOnce();
  });

  // The regression this fix is for: the render frame can be disposed
  // mid-teardown while both isDestroyed() guards still return false.
  // webContents.send then throws synchronously. Without the try/catch
  // the throw unwound the JsonlWatcher's 'ingest' emit and brought
  // down the whole broadcast.
  it('does not throw when a window send throws (disposed render frame)', () => {
    const flaky = fakeWindow({
      sendThrows: new Error(
        'Render frame was disposed before WebFrameMain could be accessed'
      ),
    });
    expect(() =>
      broadcastObservabilitySummary(PAYLOAD, [flaky])
    ).not.toThrow();
    expect(flaky.send).toHaveBeenCalledOnce();
  });

  it('continues broadcasting after one window throws', () => {
    const flaky = fakeWindow({ sendThrows: new Error('frame disposed') });
    const ok = fakeWindow({});
    broadcastObservabilitySummary(PAYLOAD, [flaky, ok]);
    expect(ok.send).toHaveBeenCalledWith('observability:summary', PAYLOAD);
  });

  it('no-ops when target list is empty', () => {
    expect(() => broadcastObservabilitySummary(PAYLOAD, [])).not.toThrow();
  });
});

describe('latestWins', () => {
  it('drops a push that resolves after a later one for the same key began', () => {
    const pushes = latestWins();
    const first = pushes.begin('ws');
    const second = pushes.begin('ws');
    const other = pushes.begin('ws2');
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    expect(other()).toBe(true);
  });
  it('a push is latest until another begins', () => {
    const pushes = latestWins();
    const only = pushes.begin('ws');
    expect(only()).toBe(true);
    pushes.begin('ws');
    expect(only()).toBe(false);
  });
});
