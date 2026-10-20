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

describe('notifications wiring (#407 Phase 2)', () => {
  function setupWithNotify(manifests: Record<string, { inbox?: InboxConfig }>) {
    const store = InboxStore.memory();
    const posted: Array<[string, string, boolean]> = [];
    const requests: Array<Record<string, unknown>> = [];
    const svc = createInboxService(store, {
      manifest: async (id) => manifests[id] ?? null,
      notifyChanged: () => {},
      notifications: {
        onTodoPosted: (t, action, flag) => { posted.push([t.title, action, flag]); return null; },
        request: (r) => { requests.push(r as never); return { id: 'N1', delivered: false, heldReason: 'pause' } as never; }
      }
    });
    return { svc, posted, requests };
  }
  it('post_todo hands the todo, action and notify flag to notifications', async () => {
    const { svc, posted } = setupWithNotify({ W1: {} });
    await svc.mcp.post('W1', { title: 'a', notify: true });
    await svc.mcp.post('W1', { title: 'b' });
    expect(posted).toEqual([['a', 'created', true], ['b', 'created', false]]);
  });
  it('notify validates, gates on posting rights, scopes todo links, and reports the outcome', async () => {
    const { svc, requests } = setupWithNotify({ W1: {}, W2: {}, OFF: { inbox: { canPost: false } } });
    expect(await svc.mcp.notify('W1', { title: 'nightly ok', key: 'nightly', tags: ['CI'] })).toEqual({ id: 'N1', delivered: false, heldReason: 'pause' });
    expect(requests[0]).toMatchObject({ kind: 'post', title: 'nightly ok', priority: 'normal', source: { kind: 'workspace', id: 'W1' }, dedupeKey: 'nightly', tags: ['ci'] });
    await expect(svc.mcp.notify('W1', {})).rejects.toThrow(/title is required/);
    await expect(svc.mcp.notify('OFF', { title: 'x' })).rejects.toThrow(/not allowed to post/);
    const { id } = (await svc.mcp.post('W1', { title: 'mine' })) as { id: string };
    await expect(svc.mcp.notify('W2', { title: 'x', todo_id: id })).rejects.toThrow(/not found/);
  });
});

describe('automation attribution (#407 Phase 3)', () => {
  it('a post with a live run_id becomes the automation\'s; a bad run_id is refused', async () => {
    const store = InboxStore.memory();
    const svc = createInboxService(store, {
      manifest: async () => ({}),
      notifyChanged: () => {},
      attribution: (runId, caller) => (runId === 'R1' && caller === 'W1' ? { automationId: 'A1' } : null)
    });
    const p = (await svc.mcp.post('W1', { title: 'from a run', key: 'k', run_id: 'R1' })) as { id: string };
    const t = (await svc.ipc.get(p.id))!.todo;
    expect(t).toMatchObject({ source: { kind: 'automation', id: 'A1' }, viaWorkspace: 'W1', sourceRunId: 'R1', workspaceId: 'W1' });
    expect((await svc.mcp.update('W1', { id: p.id, status: 'done' }) as { status: string }).status).toBe('done');
    await expect(svc.mcp.post('W2', { title: 'x', run_id: 'R1' })).rejects.toThrow(/not an active automation run/);
    await expect(svc.mcp.post('W1', { title: 'x', run_id: 7 })).rejects.toThrow(/run_id must be a string/);
  });
});
