import { describe, expect, it } from 'vitest';
import { recordHandlers, type HandlerHost } from './ipcHandlerScope.js';

class FakeIpc implements HandlerHost {
  readonly handlers = new Map<string, unknown>();
  handle(channel: string, listener: unknown): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

describe('recordHandlers', () => {
  it('records what fn registers, and dispose() lets the same service register again', () => {
    const ipc = new FakeIpc();
    ipc.handle('other:keep', () => 0);
    const register = (): number => { ipc.handle('inbox:list', () => 1); ipc.handle('inbox:create', () => 2); return 7; };
    const a = recordHandlers(ipc, register);
    expect(a.result).toBe(7);
    expect(a.channels).toEqual(['inbox:list', 'inbox:create']);
    expect(() => register()).toThrow(/second handler/);
    a.dispose();
    expect([...ipc.handlers.keys()]).toEqual(['other:keep']);
    const b = recordHandlers(ipc, register);
    expect(b.channels).toEqual(['inbox:list', 'inbox:create']);
    expect([...ipc.handlers.keys()].sort()).toEqual(['inbox:create', 'inbox:list', 'other:keep']);
  });

  it('restores handle afterwards, including a patched own handle (instrumentIpcHandle)', () => {
    const ipc = new FakeIpc();
    const seen: string[] = [];
    const raw = ipc.handle.bind(ipc);
    ipc.handle = (c: string, l: unknown) => { seen.push(c); raw(c, l); };
    const patched = ipc.handle;
    recordHandlers(ipc, () => ipc.handle('a', () => 0));
    expect(ipc.handle).toBe(patched);
    expect(seen).toEqual(['a']);
    const plain = new FakeIpc();
    recordHandlers(plain, () => undefined);
    expect(Object.prototype.hasOwnProperty.call(plain, 'handle')).toBe(false);
  });

  it('restores handle when fn throws', () => {
    const ipc = new FakeIpc();
    expect(() => recordHandlers(ipc, () => { throw new Error('boom'); })).toThrow('boom');
    expect(Object.prototype.hasOwnProperty.call(ipc, 'handle')).toBe(false);
  });
});
