import { describe, expect, it } from 'vitest';
import { channelAttrs, instrumentIpcHandle } from './perfIpc.js';

describe('instrumentIpcHandle', () => {
  it('wraps handlers, preserves args/return, and keeps channel registration', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = new Map<string, (...a: any[]) => unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { handle: (ch: string, fn: (...a: any[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:y', (_e: unknown, a: number, b: number) => a + b);
    expect(registered.has('x:y')).toBe(true);
    await expect(registered.get('x:y')!({}, 2, 3)).resolves.toBe(5);
  });

  it('propagates rejections', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = new Map<string, (...a: any[]) => unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { handle: (ch: string, fn: (...a: any[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:err', () => { throw new Error('nope'); });
    await expect(registered.get('x:err')!({})).rejects.toThrow('nope');
  });
});

describe('channelAttrs', () => {
  it('maps workspace/session args for mapped channels', () => {
    expect(channelAttrs('sessions:write', ['ws-1', { sessions: [] }]))
      .toEqual({ workspace_id: 'ws-1' });
    expect(channelAttrs('observability:summaryForBrokerSession', ['ws-1', 'bs-2']))
      .toEqual({ workspace_id: 'ws-1', session_id: 'bs-2' });
    expect(channelAttrs('observability:eventsForSession', ['sess-uuid', 0, 500]))
      .toEqual({ session_id: 'sess-uuid' });
    expect(channelAttrs('committee:post', ['ws-caller', 'ws-target', 'hello']))
      .toEqual({ workspace_id: 'ws-caller' });
  });

  it('returns undefined for unmapped channels and non-string args', () => {
    expect(channelAttrs('workspace:list', [])).toBeUndefined();
    expect(channelAttrs('sessions:write', [undefined, {}])).toBeUndefined();
    expect(channelAttrs('sessions:list', [undefined])).toBeUndefined(); // optional arg omitted
  });
});
