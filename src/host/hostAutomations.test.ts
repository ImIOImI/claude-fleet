import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../main/automations/automationStore.js';
import { definitionToYaml } from '../main/automations/definition.js';
import { INBOX_TOOLS } from '../main/automations/runner.js';
import { InboxStore } from '../main/inbox/inboxDb.js';
import { callTool, initReadSource, releaseReadSource, setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import { isPg, openTestInbox, testPgSchema, type TestPg } from '../main/store/testStore.js';
import type { AutomationDef } from '../preload/inboxTypes.js';
import { createLogger } from './log.js';
import { fakeBroker } from './testFakes.js';
import { hostMcpArgs } from './hostMcp.js';
import { LeaseLostError } from './pgLease.js';
import { HOST_CONFIG_ORIGIN, startHostAutomations, type HostAutomations } from './hostAutomations.js';
import { automationOwner, type OwnerClaim } from './sessionOwners.js';
import { automationRpcChannels, runtimeOf } from './automationRpc.js';
import { dispatchRpc } from './rpc.js';
import type { Principal } from './attachHub.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const USER = { kind: 'user' as const, id: null };
const MCP_ARGS = hostMcpArgs({ unix: '/run/fleet/mcp.sock' });
const fresh = (name: string, extra: Record<string, unknown> = {}) => ({
  definition: { name, triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'review' } }], ...extra },
  enabled: true
});

let h: HostAutomations | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
  setInboxHandlers(null);
  setAutomationHandlers(null);
  releaseReadSource();
});

const names = async () => (await h!.automations.list()).map((a) => [a.name, a.enabled, a.version]).sort();
const def = (name: string, cron?: string): AutomationDef => ({
  name, triggers: [cron ? { schedule: { cron } } : { manual: {} }], concurrency: 'skip', steps: [{ id: 'go', prompt: { workspace: WS.id, mode: 'fresh', message: 'x' } }]
});
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const ann: Principal = { identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier: 'steer' };
const rid = (n: number) => `${String(n).padStart(8, '0')}-4b1c-4c2a-9a0e-1f2e3d4c5b6a`;
const act = (channel: string, body: Record<string, unknown>, n: number) =>
  dispatchRpc(automationRpcChannels(() => runtimeOf(h!, () => WS)), channel, { args: [{ requestId: rid(n), ...body }] }, ann);

async function start(inbox?: InboxStore) {
  const store = inbox ?? (await openTestInbox());
  const broker = fakeBroker([]);
  const published: Array<[string, unknown]> = [];
  const logs: string[] = [];
  h = await startHostAutomations({
    inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS,
    events: { publish: (c, p) => published.push([c, p]) }, log: createLogger((l) => logs.push(l)), tickMs: 60_000, settleMs: 50
  });
  return { broker, published, logs, store };
}

describe('startHostAutomations', () => {
  it('records the run’s session as an automation owner before the broker starts it', async () => {
    const store = await openTestInbox();
    const broker = fakeBroker([]);
    const order: string[] = [];
    const claims: OwnerClaim[] = [];
    const create = broker.ops.create.bind(broker.ops);
    broker.ops.create = async (...a) => { order.push('create'); return create(...a); };
    h = await startHostAutomations({
      inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS, events: { publish: () => undefined },
      log: createLogger(() => undefined), tickMs: 60_000, settleMs: 50,
      owners: { record: async (c) => { order.push('record'); claims.push(c); return true; } }
    });
    await h.reconcile([fresh('a')]);
    const [a] = await h.automations.list();
    const run = await h.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await expect.poll(() => broker.created.length).toBe(1);
    const c = broker.created[0];
    expect(order).toEqual(['record', 'create']);
    expect(claims).toEqual([{
      brokerSessionId: `auto-${run.id}-go`, sessionId: c.args[c.args.indexOf('--session-id') + 1],
      owner: automationOwner(WS.id), startedAt: expect.any(Number)
    }]);
  });

  it('a broker refusal releases the automation’s owner row', async () => {
    const store = await openTestInbox();
    const broker = fakeBroker([]);
    broker.ops.create = async () => ({ ok: false, error: 'no capacity' });
    const claims: OwnerClaim[] = [];
    const released: Array<[string, string]> = [];
    h = await startHostAutomations({
      inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS, events: { publish: () => undefined },
      log: createLogger(() => undefined), tickMs: 60_000, settleMs: 50,
      owners: { record: async (c) => { claims.push(c); return true; }, release: async (b, sid) => { released.push([b, sid]); } }
    });
    await h.reconcile([fresh('a')]);
    const [a] = await h.automations.list();
    const run = await h.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await h.automations.settle();
    expect(released).toEqual([[`auto-${run.id}-go`, claims[0].sessionId]]);
    expect((await new AutomationStore(store.kysely).getRun(run.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/no capacity/) });
  });

  it('a failed owner write fails the step and starts nothing', async () => {
    const store = await openTestInbox();
    const broker = fakeBroker([]);
    h = await startHostAutomations({
      inbox: store, workspace: () => WS, ops: broker.ops, mcpArgs: MCP_ARGS, events: { publish: () => undefined },
      log: createLogger(() => undefined), tickMs: 60_000, settleMs: 50,
      owners: { record: async () => { throw new Error('fenced off'); } }
    });
    await h.reconcile([fresh('a')]);
    const [a] = await h.automations.list();
    const run = await h.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await h.automations.settle();
    expect(broker.created).toEqual([]);
    expect((await new AutomationStore(store.kysely).getRun(run.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/fenced off/) });
  });

  it('reconciles config definitions: create, update on change only, disable, remove', async () => {
    const { published, store } = await start();
    await h!.reconcile([fresh('a'), fresh('b')]);
    expect(await names()).toEqual([['a', true, 1], ['b', true, 1]]);
    const [a] = await h!.automations.list();
    expect((await new AutomationStore(store.kysely).get(a.id))!.origin).toEqual(HOST_CONFIG_ORIGIN);
    await h!.reconcile([fresh('a'), { ...fresh('b'), enabled: false }]);
    expect(await names()).toEqual([['a', true, 1], ['b', false, 1]]);
    await h!.reconcile([fresh('a', { description: 'changed' })]);
    expect(await names()).toEqual([['a', true, 2]]);
    expect(published.some(([c]) => c === 'automations:changed')).toBe(true);
  });

  it('skips an invalid definition, keeps its current row, and leaves other automations alone', async () => {
    const { logs } = await start();
    await h!.reconcile([fresh('a'), fresh('live')]);
    const live = { definition: { name: 'live', triggers: [{ manual: {} }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'live', message: 'x' } }] }, enabled: true };
    await h!.reconcile([fresh('a'), live]);
    expect(await names()).toEqual([['a', true, 1], ['live', true, 1]]);
    expect(logs.join('\n')).toMatch(/mode: live is not available on a remote host/);
  });

  it('adopts a same-name row with no origin, and disables every enabled row it does not own', async () => {
    const { store, logs } = await start();
    const s = new AutomationStore(store.kysely);
    const orphan = await s.create(def('a'), USER, Date.now());
    const loadout = await s.create(def('b'), USER, Date.now(), true, { loadoutId: 'x' });
    const stray = await s.create(def('stray', '* * * * *'), USER, Date.now());
    await h!.reconcile([fresh('a', { description: 'mine' }), fresh('b')]);
    const got = async (id: string) => { const r = (await s.get(id))!; return [r.name, r.enabled, r.version, r.origin]; };
    expect(await got(orphan.id)).toEqual(['a', true, 2, HOST_CONFIG_ORIGIN]);
    expect(await got(loadout.id)).toEqual(['b', false, 1, { loadoutId: 'x' }]);
    expect(await got(stray.id)).toEqual(['stray', false, 1, null]);
    expect(logs.join('\n')).toMatch(/name is taken/);
    expect(logs.filter((l) => /disabled an automation not from the host config/.test(l))).toHaveLength(2);
  });

  it('never runs a row whose origin is not the host config, by tick or by run_automation', async () => {
    const { store, broker } = await start();
    initReadSource(null);
    const s = new AutomationStore(store.kysely);
    const stray = await s.create(def('stray', '* * * * *'), USER, Date.now() - 10 * 60_000);
    await h!.tick();
    const r = await callTool({ name: 'run_automation', arguments: { id: 'stray' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(/stray can't run here: .*not from the host config/)]);
    await expect(h!.automations.run(stray.id, { kind: 'manual', by: USER, args: {} })).rejects.toThrow(/not from the host config/);
    await h!.automations.settle();
    expect([broker.created, await s.runs(stray.id, 10)]).toEqual([[], []]);
    await h!.reconcile([]);
    expect((await s.get(stray.id))!.enabled).toBe(false);
  });

  it('creates a config row with its origin and enabled state in one write', async () => {
    const { store } = await start();
    const setOrigin = vi.spyOn(AutomationStore.prototype, 'setOrigin');
    const setEnabled = vi.spyOn(AutomationStore.prototype, 'setEnabled');
    await h!.reconcile([{ ...fresh('off'), enabled: false }]);
    expect([setOrigin.mock.calls, setEnabled.mock.calls]).toEqual([[], []]);
    vi.restoreAllMocks();
    const [r] = await new AutomationStore(store.kysely).list();
    expect([r.enabled, r.version, r.origin]).toEqual([false, 1, HOST_CONFIG_ORIGIN]);
  });

  it('serializes reconciles, and one failing entry does not skip the rest', async () => {
    const { logs } = await start();
    const list = AutomationStore.prototype.list;
    const slow = vi.spyOn(AutomationStore.prototype, 'list').mockImplementation(async function (this: AutomationStore) {
      const rows = await list.call(this);
      await new Promise((r) => setTimeout(r, 20));
      return rows;
    });
    await Promise.all([h!.reconcile([fresh('a')]), h!.reconcile([fresh('a'), fresh('b')]), h!.reconcile([fresh('a'), fresh('b')])]);
    slow.mockRestore();
    expect(await names()).toEqual([['a', true, 1], ['b', true, 1]]);
    expect(logs.filter((l) => /host-config automation failed/.test(l))).toEqual([]);
    const spy = vi.spyOn(AutomationStore.prototype, 'create').mockImplementationOnce(async () => { throw new Error('disk on fire'); });
    try {
      await h!.reconcile([fresh('a'), fresh('b'), fresh('c'), fresh('d')]);
    } finally {
      spy.mockRestore();
    }
    expect(await names()).toEqual([['a', true, 1], ['b', true, 1], ['d', true, 1]]);
    expect(logs.join('\n')).toMatch(/host-config automation failed.*"name":"c".*disk on fire/);
    vi.spyOn(AutomationStore.prototype, 'create').mockImplementationOnce(async () => { throw new LeaseLostError('epoch moved'); });
    await expect(h!.reconcile([fresh('e'), fresh('f')])).rejects.toThrow(LeaseLostError);
    vi.restoreAllMocks();
  });

  it('runs a fresh step through the broker: the exact argv, a pinned session id, the MCP config as one argument', async () => {
    const { broker } = await start();
    await h!.reconcile([fresh('a')]);
    const [a] = await h!.automations.list();
    const run = await h!.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await expect.poll(() => broker.created.length).toBe(1);
    const c = broker.created[0];
    expect(c.id).toBe(`auto-${run.id}-go`);
    const sid = c.args[c.args.indexOf('--session-id') + 1];
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(c.args).toEqual(['-p', '--allowedTools', INBOX_TOOLS.join(','), ...MCP_ARGS, '--session-id', sid, '--', expect.stringMatching(/^review\n\n\(claude-fleet automation "a", run /)]);
    expect(MCP_ARGS).toHaveLength(1);
    expect(MCP_ARGS[0]).toMatch(/^--mcp-config=\{/);
  });

  it('re-checks the lease with a fenced write right before starting a session', async () => {
    const { broker, store } = await start();
    await h!.reconcile([fresh('a')]);
    const order: string[] = [];
    const create = broker.ops.create.bind(broker.ops);
    broker.ops.create = async (...a) => { order.push('create'); return create(...a); };
    const tx = store.kysely.transaction.bind(store.kysely);
    vi.spyOn(store.kysely, 'transaction').mockImplementation(() => { order.push('tx'); return tx(); });
    const [a] = await h!.automations.list();
    await h!.automations.run(a.id, { kind: 'manual', by: USER, args: {} });
    await expect.poll(() => order.includes('create')).toBe(true);
    expect(order.slice(order.indexOf('create') - 1, order.indexOf('create') + 1)).toEqual(['tx', 'create']);
    vi.restoreAllMocks();
  });

  it('passes a prompt that starts with - after --, and refuses one over 120 KiB', async () => {
    const { broker, store } = await start();
    await h!.reconcile([
      fresh('dash', { steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: '--model=x review' } }] }),
      fresh('big', { params: [{ name: 'x', type: 'string' }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: '{{args.x}}' } }] })
    ]);
    const s = new AutomationStore(store.kysely);
    const big = (await s.byName('big'))!;
    const run = await h!.automations.run(big.id, { kind: 'manual', by: USER, args: { x: 'y'.repeat(121 * 1024) } });
    await h!.automations.settle();
    expect(broker.created).toHaveLength(0);
    expect((await s.getRun(run.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/longer than 120 KiB/) });
    const dash = (await s.byName('dash'))!;
    await h!.automations.run(dash.id, { kind: 'manual', by: USER, args: {} });
    await expect.poll(() => broker.created.length).toBe(1);
    expect(broker.created[0].args.slice(-2)).toEqual(['--', expect.stringMatching(/^--model=x review/)]);
  });

  it('refuses script and live steps at run time, before any step runs', async () => {
    const { broker, store } = await start();
    const s = new AutomationStore(store.kysely);
    const defOf = (name: string, steps: AutomationDef['steps']): AutomationDef => ({ name, triggers: [{ manual: {} }], concurrency: 'skip', steps });
    const ok = { id: 'first', prompt: { workspace: WS.id, mode: 'fresh' as const, message: 'x' } };
    const live = await s.create(defOf('live', [ok, { id: 'go', prompt: { workspace: WS.id, mode: 'live', message: 'x' } }]), USER, Date.now(), true, { ...HOST_CONFIG_ORIGIN });
    const script = await s.create(defOf('script', [ok, { id: 'sh', script: { run: 'echo hi', runIn: WS.id } }]), USER, Date.now(), true, { ...HOST_CONFIG_ORIGIN });
    await expect(h!.automations.run(live.id, { kind: 'manual', by: USER, args: {} })).rejects.toThrow(/mode: live is not available on a remote host/);
    await expect(h!.automations.run(script.id, { kind: 'manual', by: USER, args: {} })).rejects.toThrow(/script steps are not available on a remote host/);
    await h!.automations.settle();
    expect(broker.created).toEqual([]);
  });

  it('serves the MCP inbox and automation tools as the hosted workspace, privileged', async () => {
    await start();
    initReadSource(null);
    await h!.reconcile([fresh('a')]);
    const list = await callTool({ name: 'list_automations', arguments: {} }, WS.id);
    expect(JSON.parse(text(list)).map((x: { name: string; canRun: boolean }) => [x.name, x.canRun])).toEqual([['a', true]]);
    const post = await callTool({ name: 'post_todo', arguments: { title: 'look at PR 1' } }, WS.id) as { isError?: boolean };
    expect(post.isError).toBeUndefined();
    const other = await callTool({ name: 'post_todo', arguments: { title: 'x' } }, 'SOMEONE-ELSE') as { isError?: boolean; content: Array<{ text: string }> };
    expect(other.isError).toBe(true);
  });

  it('takes definitions only from the config: a session proposal over MCP is a pending draft and never schedules', async () => {
    const { store } = await start();
    initReadSource(null);
    const yaml = 'name: sneaky\ntriggers:\n  - schedule: { cron: "* * * * *" }\nsteps:\n  - id: go\n    prompt: { workspace: $self, mode: fresh, message: x }\n';
    const r = await callTool({ name: 'propose_automation', arguments: { definition: yaml } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeUndefined();
    const id = (JSON.parse(text(r)) as { id: string; status: string }).id;
    expect(JSON.parse(text(await callTool({ name: 'get_proposal', arguments: { id } }, WS.id)))).toMatchObject({ status: 'pending' });
    const other = await callTool({ name: 'propose_automation', arguments: { definition: yaml.replace('sneaky', 'other') } }, 'SOMEONE-ELSE') as { isError?: boolean; content: Array<{ text: string }> };
    expect(other.isError).toBe(true);
    const p = await h!.proposals.mcp.propose(WS.id, { definition: yaml.replace('sneaky', 'sneaky2').replace('$self', 'review-bot') });
    expect(p).toMatchObject({ status: 'pending' });
    await h!.tick();
    expect(await new AutomationStore(store.kysely).list()).toEqual([]);
    await h!.reconcile([fresh('a')]);
    const edit = definitionToYaml({ name: 'a', description: 'edited by a session', triggers: [{ manual: {} }], concurrency: 'skip', steps: [{ id: 'go', prompt: { workspace: WS.id, mode: 'fresh', message: 'review' } }] });
    expect(await h!.proposals.mcp.proposeChange(WS.id, { id: 'a', definition: edit })).toMatchObject({ status: 'pending' });
    expect(await names()).toEqual([['a', true, 1]]);
  });

  it('RPC Run now: attributed to the person; disabled and non-config automations are refused and start nothing', async () => {
    const { store, broker } = await start();
    initReadSource(null);
    await h!.reconcile([fresh('a'), { ...fresh('off'), enabled: false }]);
    const byName = Object.fromEntries((await h!.automations.list()).map((a) => [a.name, a.id]));
    const ok = await act('automations:run', { id: byName.a }, 1);
    const runId = (ok.body as { result: { result: { runId: string } } }).result.result.runId;
    expect((await new AutomationStore(store.kysely).runs(byName.a, 10)).find((r) => r.id === runId)?.trigger.by).toEqual({ kind: 'user', id: 'ann' });
    await expect.poll(() => broker.created.length).toBe(1);
    expect((await act('automations:run', { id: byName.off }, 2)).body).toEqual({ ok: true, result: { replayed: false, result: null, error: 'off is disabled in the host config' } });
    const stray = await new AutomationStore(store.kysely).create(def('stray'), USER, Date.now());
    const r = await act('automations:run', { id: stray.id }, 3);
    expect((r.body as { result: { error: string } }).result.error).toMatch(/stray can't run here: .*not from the host config/);
    expect(broker.created).toHaveLength(1);
  });

  it('RPC todo create and update are recorded as the person', async () => {
    const { store } = await start();
    const c = await act('inbox:create', { input: { title: 'look' } }, 1);
    const id = (c.body as { result: { result: { id: string } } }).result.result.id;
    await act('inbox:update', { id, patch: { status: 'done' } }, 2);
    expect((await store.get(id))?.source).toEqual({ kind: 'user', id: 'ann' });
    expect((await store.events(id)).at(-1)?.actor).toEqual({ kind: 'user', id: 'ann' });
  });

  it('notify from a host session is a held notice the RPC feed serves; any other caller is refused (D131)', async () => {
    const { published } = await start();
    initReadSource(null);
    const r = await callTool({ name: 'notify', arguments: { title: 'nightly ok\nsecond line', body: 'all green', key: 'nightly' } }, WS.id);
    expect(JSON.parse(text(r))).toMatchObject({ delivered: false, heldReason: 'remote' });
    const other = await callTool({ name: 'notify', arguments: { title: 'x' } }, 'SOMEONE-ELSE') as { isError?: boolean };
    expect(other.isError).toBe(true);
    expect(published.filter(([c]) => c === 'notices:changed')).toEqual([['notices:changed', null]]);
    const feed = await dispatchRpc(automationRpcChannels(() => runtimeOf(h!, () => WS)), 'notices:feed', { args: [{ sinceTs: 0 }] }, { ...ann, tier: 'read' });
    const rows = (feed.body as { result: { rows: Array<Record<string, unknown>> } }).result.rows;
    expect(rows).toEqual([expect.objectContaining({
      kind: 'post', title: 'nightly ok second line', body: 'all green', dedupeKey: 'nightly', workspaceId: WS.id,
      source: { kind: 'workspace', id: WS.id }, delivered: false, heldReason: 'remote'
    })]);
  });

  it('notify shares the hourly post limit', async () => {
    await start();
    initReadSource(null);
    for (let i = 0; i < 60; i++) await callTool({ name: 'notify', arguments: { title: `n${i}` } }, WS.id);
    const r = await callTool({ name: 'notify', arguments: { title: 'one more' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(/post limit \(60\/hour\)/)]);
  });

  it('a todo posted with notify becomes a notice; one without does not', async () => {
    await start();
    initReadSource(null);
    await callTool({ name: 'post_todo', arguments: { title: 'look', notify: true } }, WS.id);
    await callTool({ name: 'post_todo', arguments: { title: 'quiet' } }, WS.id);
    const notes = await h!.notices.feed({ sinceTs: 0, limit: 100 });
    expect(notes.map((n) => [n.kind, n.title])).toEqual([['todo', 'look']]);
  });

  it('stop() unhooks the MCP handlers and is idempotent', async () => {
    await start();
    initReadSource(null);
    await h!.stop();
    await h!.stop();
    const r = await callTool({ name: 'post_todo', arguments: { title: 'x' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect([r.isError, text(r)]).toEqual([true, 'Error: the inbox is unavailable']);
  });
});

describe.skipIf(!isPg)('startHostAutomations on a fenced store', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    await h?.stop();
    h = null;
    await t?.drop();
    t = null;
  });

  it('every write goes through the fenced store, so a lost lease stops them all', async () => {
    t = await testPgSchema();
    await InboxStore.openPostgres(t.pool).then((s) => s.close().catch(() => undefined));
    let fenced = 0;
    let lost = false;
    const inbox = await InboxStore.openPostgres(t.pool, {
      migrate: false,
      afterBeginWrite: async () => {
        fenced++;
        if (lost) throw new LeaseLostError('lease lost');
      }
    });
    const { broker } = await start(inbox);
    initReadSource(null);
    await h!.reconcile([fresh('a')]);
    expect(fenced).toBeGreaterThan(0);
    lost = true;
    await expect(h!.reconcile([fresh('a', { description: 'changed' })])).rejects.toThrow(/lease lost/);
    await expect(h!.reconcile([fresh('a'), fresh('b')])).rejects.toThrow(/lease lost/);
    await expect(h!.reconcile([])).rejects.toThrow(/lease lost/);
    const post = await callTool({ name: 'post_todo', arguments: { title: 'x' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect([post.isError, text(post)]).toEqual([true, expect.stringMatching(/lease lost/)]);
    const run = await callTool({ name: 'run_automation', arguments: { id: 'a' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
    expect([run.isError, text(run)]).toEqual([true, expect.stringMatching(/lease lost/)]);
    expect(broker.created).toEqual([]);
    lost = false;
    expect((await h!.automations.list()).map((a) => [a.name, a.version])).toEqual([['a', 1]]);
    await inbox.close();
  });

  it('an RPC action under a lost lease answers 503, writes nothing, and its retry never runs it', async () => {
    t = await testPgSchema();
    await InboxStore.openPostgres(t.pool).then((s) => s.close().catch(() => undefined));
    let lost = false;
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false, afterBeginWrite: async () => { if (lost) throw new LeaseLostError('lease lost'); } });
    await start(inbox);
    lost = true;
    expect(await act('inbox:create', { input: { title: 'x' } }, 1)).toEqual({ status: 503, body: { ok: false, error: 'automations unavailable' } });
    lost = false;
    expect((await act('inbox:create', { input: { title: 'x' } }, 1)).body).toEqual({ ok: true, result: { replayed: true, result: null, error: null } });
    expect(await inbox.list({ status: 'all' })).toEqual([]);
    await inbox.close();
  });
});
