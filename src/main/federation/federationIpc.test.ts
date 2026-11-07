import { describe, expect, it, vi } from 'vitest';
import { registerFederationIpc } from './federationIpc';

const A = '01JC0000000000000000000000';
function rig() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const reader = { listSessions: vi.fn(async () => ({ pages: [], unavailable: [] })), summary: vi.fn(), call: vi.fn() };
  registerFederationIpc({ handle: (c: string, f: never) => handlers.set(c, f) } as never, reader as never);
  return { h: handlers.get('sessions:listRemote')!, reader };
}

describe('sessions:listRemote', () => {
  it('first pages with no argument; one origin first page; one origin with a cursor', async () => {
    const { h, reader } = rig();
    await h({});
    expect(reader.listSessions).toHaveBeenLastCalledWith({});
    await h({}, { origin: A });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A });
    await h({}, { origin: A, after: { lastActiveAt: 3, id: 's' } });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A, after: { lastActiveAt: 3, id: 's' } });
  });
  it('refuses a malformed request', async () => {
    const { h } = rig();
    await expect(h({}, { origin: 'x', after: { lastActiveAt: 3, id: 's' } })).rejects.toThrow();
    await expect(h({}, { origin: A, after: { lastActiveAt: -1, id: 's' } })).rejects.toThrow();
  });
  it('refuses a cross-shaped or non-object request', async () => {
    const { h, reader } = rig();
    for (const bad of [{ origin: A, after: null }, { origin: A, after: { lastActiveAt: 1, id: 'a b' } }, { origin: A, after: { lastActiveAt: 1.5, id: 's' } }, 'x', 5, { after: { lastActiveAt: 1, id: 's' } }]) {
      await expect(h({}, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(reader.listSessions).not.toHaveBeenCalled();
  });
  it('passes only the parsed fields on', async () => {
    const { h, reader } = rig();
    await h({}, { origin: A, after: { lastActiveAt: 3, id: 's', workspaceId: 'x' }, limit: 9999 });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A, after: { lastActiveAt: 3, id: 's' } });
  });
});
