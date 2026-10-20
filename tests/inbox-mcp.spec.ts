// Inbox MCP tools (#407) end-to-end on the real app: workspaces post / dedupe /
// reopen / update / list over their own MCP socket; permissions and the hourly
// cap are enforced host-side; the result shows up in the Inbox UI.
import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, connectMcp, callTestIpc, type RpcClient } from './_helpers.js';

function text(res: { result?: unknown }): { isError?: boolean; value: unknown; raw: string } {
  const r = res.result as { isError?: boolean; content?: Array<{ text?: string }> };
  const raw = r?.content?.[0]?.text ?? '';
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* error text */ }
  return { isError: r?.isError, value, raw };
}

test('Inbox MCP: post, dedupe, reopen, scope, permissions, cap (#407)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-inbox-mcp-'));
  const A = '01INBOXTESTWS00000000000WA', B = '01INBOXTESTWS00000000000WB', C = '01INBOXTESTWS00000000000WC';
  const seed = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(path.join(userDataDir, 'state', id), { recursive: true });
    writeFileSync(path.join(userDataDir, 'state', id, 'workspace.json'), JSON.stringify({
      id, name, labels: [], workspaceRoot: '/tmp/fleet-inbox', workspaceSubdir: '', kind: 'container',
      image: 'mock', authMode: 'oauth', env: { plain: {}, secretKeys: [] }, createdAt: Date.now(), lastUsedAt: Date.now(), ...extra
    }));
  };
  seed(A, 'inbox-a');
  seed(B, 'inbox-b', { inbox: { canPost: false } });
  seed(C, 'inbox-c', { inbox: { maxPostsPerHour: 2 } });

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  const clients: RpcClient[] = [];
  const call = (c: RpcClient, name: string, args: Record<string, unknown>) =>
    c.call('tools/call', { name, arguments: args }).then(text);
  try {
    const a = await connectMcp(A, userDataDir); clients.push(a);
    const b = await connectMcp(B, userDataDir); clients.push(b);
    const c = await connectMcp(C, userDataDir); clients.push(c);
    for (const cl of clients) await cl.call('initialize', { protocolVersion: '2024-11-05' });

    const tools = await a.call('tools/list');
    const names = (tools.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['post_todo', 'update_todo', 'list_todos']));

    const p1 = await call(a, 'post_todo', { title: 'disk 91% on build-01', priority: 'high', key: 'disk:build-01', tags: ['ops'] });
    expect(p1.value).toMatchObject({ action: 'created' });
    const id = (p1.value as { id: string }).id;
    const p2 = await call(a, 'post_todo', { title: 'disk 93% on build-01', priority: 'urgent', key: 'disk:build-01' });
    expect(p2.value).toMatchObject({ id, action: 'updated', seenCount: 2 });
    const det = await callTestIpc<{ todo: { priority: string; seenCount: number } }>(app, 'inbox:get', [id]);
    expect(det.todo).toMatchObject({ priority: 'urgent', seenCount: 2 });

    expect((await call(a, 'update_todo', { id, status: 'done' })).value).toMatchObject({ status: 'done' });
    expect((await call(a, 'post_todo', { title: 'disk 95%', key: 'disk:build-01' })).value).toMatchObject({ id, action: 'reopened' });

    const listA = (await call(a, 'list_todos', {})).value as Array<{ id: string }>;
    expect(listA.map((t) => t.id)).toEqual([id]);
    expect((await call(b, 'list_todos', { status: 'all' })).value).toEqual([]);

    const denied = await call(b, 'post_todo', { title: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.raw).toMatch(/not allowed to post/);
    const foreign = await call(b, 'update_todo', { id, status: 'done' });
    expect(foreign.isError).toBe(true);
    expect(foreign.raw).toMatch(/not permitted/);

    await call(c, 'post_todo', { title: 'c1' });
    await call(c, 'post_todo', { title: 'c2' });
    const capped = await call(c, 'post_todo', { title: 'c3' });
    expect(capped.isError).toBe(true);
    expect(capped.raw).toMatch(/post limit \(2\/hour\).*retryAfterMs=\d+/);

    await window.locator('.inbox-chip .ws-chip').click();
    const row = window.locator('.todo-row', { hasText: 'disk 91% on build-01' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('inbox-a');
    await expect(row).toContainText('seen 3×');
    await expect(row).toContainText('recurred');
    await expect(window.locator('.inbox-chip .ws-chip-sub')).toHaveText('3 open · 1 urgent');
  } finally {
    for (const cl of clients) cl.close();
    await app.close();
  }
});

test('Notifications over MCP: notify, hold while paused, one digest on resume (#407)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-notify-mcp-'));
  const A = '01NOTIFYTESTWS0000000000WA';
  mkdirSync(path.join(userDataDir, 'state', A), { recursive: true });
  writeFileSync(path.join(userDataDir, 'state', A, 'workspace.json'), JSON.stringify({
    id: A, name: 'notify-a', labels: [], workspaceRoot: '/tmp/fleet-notify', workspaceSubdir: '', kind: 'container',
    image: 'mock', authMode: 'oauth', env: { plain: {}, secretKeys: [] }, createdAt: Date.now(), lastUsedAt: Date.now()
  }));
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  const a = await connectMcp(A, userDataDir);
  const call = (name: string, args: Record<string, unknown>) => a.call('tools/call', { name, arguments: args }).then(text);
  try {
    await a.call('initialize', { protocolVersion: '2024-11-05' });
    const names = ((await a.call('tools/list')).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('notify');

    expect((await call('notify', { title: 'nightly ok' })).value).toMatchObject({ delivered: true, heldReason: null });

    await callTestIpc(app, 'notifications:pause', [{ until: null, letUrgent: false }]);
    expect((await call('notify', { title: 'held one', priority: 'high' })).value).toMatchObject({ delivered: false, heldReason: 'pause' });
    expect((await call('post_todo', { title: 'urgent thing', priority: 'urgent' })).value).toMatchObject({ action: 'created' });
    const q = await callTestIpc<{ heldSinceQuiet: number }>(app, 'notifications:quietState', []);
    expect(q.heldSinceQuiet).toBe(2);

    await callTestIpc(app, 'notifications:resume', []);
    const all = await callTestIpc<Array<{ title: string; delivered: boolean; heldReason: string | null }>>(app, 'notifications:list', ['all']);
    expect(all.find((n) => n.title.startsWith('Notifications resumed'))).toMatchObject({ title: 'Notifications resumed: 2 held', delivered: true });
    expect(all.find((n) => n.title === 'Urgent · urgent thing')).toMatchObject({ delivered: false, heldReason: 'pause' });

    await window.locator('.inbox-chip .ws-chip').click();
    const view = window.locator('.inbox-view');
    await view.getByRole('tab', { name: 'Activity' }).click();
    await view.getByRole('tab', { name: 'Held back' }).click();
    await expect(view.locator('.nl-row', { hasText: 'held one' })).toContainText('held: notifications were paused');
    await expect(view.locator('.nl-row', { hasText: 'held one' })).toContainText('notify-a');
  } finally {
    a.close();
    await app.close();
  }
});
