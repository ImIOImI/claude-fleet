import { describe, expect, it } from 'vitest';
import { instrumentIpcHandle } from './perfIpc.js';

describe('instrumentIpcHandle', () => {
  it('wraps handlers, preserves args/return, and keeps channel registration', async () => {
    const registered = new Map<string, (...a: unknown[]) => unknown>();
    const fake = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:y', (_e: unknown, a: number, b: number) => a + b);
    expect(registered.has('x:y')).toBe(true);
    await expect(registered.get('x:y')!({}, 2, 3)).resolves.toBe(5);
  });

  it('propagates rejections', async () => {
    const registered = new Map<string, (...a: unknown[]) => unknown>();
    const fake = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:err', () => { throw new Error('nope'); });
    await expect(registered.get('x:err')!({})).rejects.toThrow('nope');
  });
});
