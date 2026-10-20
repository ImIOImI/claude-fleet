import { describe, it, expect } from 'vitest';
import { InboxStore } from './inboxDb.js';
import { createInboxService } from './inboxService.js';
import type { InboxConfig } from '../../preload/inboxTypes.js';

function setup(manifests: Record<string, { inbox?: InboxConfig }>) {
  const store = InboxStore.memory();
  let changed = 0;
  let t = 1000;
  const svc = createInboxService(store, {
    manifest: async (id) => manifests[id] ?? null,
    notifyChanged: () => { changed++; },
    now: () => t
  });
  return { store, svc, changed: () => changed, tick: (ms: number) => { t += ms; } };
}

describe('inbox MCP handlers', () => {
  it('post_todo creates, dedupes and reports the action; links the caller by default', async () => {
    const { svc, changed } = setup({ W1: {} });
    const a = (await svc.mcp.post('W1', { title: 'disk 91%', key: 'disk', priority: 'high' })) as { id: string; action: string };
    expect(a.action).toBe('created');
    const b = (await svc.mcp.post('W1', { title: 'disk 92%', key: 'disk' })) as { id: string; action: string };
    expect(b).toMatchObject({ id: a.id, action: 'updated' });
    expect(changed()).toBe(2);
    const list = (await svc.mcp.list('W1', {})) as Array<{ id: string; workspaceId: string; seenCount: number }>;
    expect(list[0]).toMatchObject({ id: a.id, workspaceId: 'W1', seenCount: 2 });
  });

  it('rejects unknown callers, disabled posting, and posts over the hourly cap', async () => {
    const { svc } = setup({ OFF: { inbox: { canPost: false } }, CAP: { inbox: { maxPostsPerHour: 2 } } });
    await expect(svc.mcp.post('NOPE', { title: 'x' })).rejects.toThrow(/unknown workspace/);
    await expect(svc.mcp.post('OFF', { title: 'x' })).rejects.toThrow(/not allowed to post/);
    await svc.mcp.post('CAP', { title: '1' });
    await svc.mcp.post('CAP', { title: '2' });
    await expect(svc.mcp.post('CAP', { title: '3' })).rejects.toThrow(/post limit \(2\/hour\).*retryAfterMs=\d+/);
  });

  it('update_todo is limited to the caller’s own todos; list is scoped', async () => {
    const { svc } = setup({ W1: {}, W2: {}, ALL: { inbox: { canReadAll: true } } });
    const { id } = (await svc.mcp.post('W1', { title: 'mine' })) as { id: string };
    await expect(svc.mcp.update('W2', { id, status: 'done' })).rejects.toThrow(/not permitted/);
    const u = (await svc.mcp.update('W1', { id, status: 'done', tags_add: ['ops'] })) as { status: string; tags: string[] };
    expect(u).toMatchObject({ status: 'done', tags: ['ops'] });
    expect(await svc.mcp.list('W2', { status: 'all' })).toEqual([]);
    expect((await svc.mcp.list('ALL', { status: 'all' }) as unknown[]).length).toBe(1);
    await expect(svc.mcp.update('W1', { id: 'missing' })).rejects.toThrow(/not found/);
  });
});

describe('inbox IPC handlers', () => {
  it('create posts as the user; update may change anything; counts reflect open items', async () => {
    const { svc } = setup({ W1: {} });
    const t = await svc.ipc.create({ title: 'From me', priority: 'urgent', tags: ['Health'] });
    expect(t).toMatchObject({ source: { kind: 'user', id: null }, priority: 'urgent', tags: ['health'] });
    const ws = (await svc.mcp.post('W1', { title: 'from ws' })) as { id: string };
    await svc.ipc.update(ws.id, { status: 'dismissed' });
    expect(await svc.ipc.counts()).toEqual({ open: 1, urgent: 1, high: 0 });
    const detail = await svc.ipc.get(t.id);
    expect(detail?.events.map((e) => e.kind)).toEqual(['created']);
    expect(await svc.ipc.get('missing')).toBeNull();
    expect((await svc.ipc.list({ status: 'all' })).length).toBe(2);
  });
});
