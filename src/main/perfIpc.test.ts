import { describe, expect, it } from 'vitest';
import { instrumentIpcHandle } from './perfIpc.js';

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
