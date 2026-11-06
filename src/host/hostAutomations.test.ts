import { afterEach, describe, expect, it } from 'vitest';
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
import { HOST_CONFIG_ORIGIN, startHostAutomations, type HostAutomations } from './hostAutomations.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const USER = { kind: 'user' as const, id: null };
const MCP_ARGS = hostMcpArgs('/run/fleet/mcp.sock');
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
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

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

  it('never touches an automation it did not create', async () => {
    const { store, logs } = await start();
    const other = await new AutomationStore(store.kysely).create(
      { name: 'a', triggers: [{ manual: {} }], concurrency: 'skip', steps: [{ id: 'go', prompt: { workspace: WS.id, mode: 'fresh', message: 'x' } }] }, USER, Date.now()
    );
    await h!.reconcile([fresh('a', { description: 'mine' })]);
    await h!.reconcile([]);
    expect((await new AutomationStore(store.kysely).get(other.id))!.version).toBe(1);
    expect(logs.join('\n')).toMatch(/name is taken/);
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
    expect(c.args).toEqual(['-p', expect.stringMatching(/^review\n\n\(claude-fleet automation "a", run /), '--allowedTools', INBOX_TOOLS.join(','), '--session-id', sid, ...MCP_ARGS]);
    expect(MCP_ARGS).toHaveLength(1);
    expect(MCP_ARGS[0]).toMatch(/^--mcp-config=\{/);
  });

  it('refuses script and live steps at run time, before any step runs', async () => {
    const { broker, store } = await start();
    const s = new AutomationStore(store.kysely);
    const def = (name: string, steps: AutomationDef['steps']): AutomationDef => ({ name, triggers: [{ manual: {} }], concurrency: 'skip', steps });
    const ok = { id: 'first', prompt: { workspace: WS.id, mode: 'fresh' as const, message: 'x' } };
    const live = await s.create(def('live', [ok, { id: 'go', prompt: { workspace: WS.id, mode: 'live', message: 'x' } }]), USER, Date.now());
    const script = await s.create(def('script', [ok, { id: 'sh', script: { run: 'echo hi', runIn: WS.id } }]), USER, Date.now());
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

  it('takes definitions only from the config: session proposals are refused and never schedule', async () => {
    const { store } = await start();
    initReadSource(null);
    const yaml = 'name: sneaky\ntriggers:\n  - schedule: { cron: "* * * * *" }\nsteps:\n  - id: go\n    prompt: { workspace: review-bot, mode: fresh, message: x }\n';
    for (const name of ['propose_automation', 'propose_automation_change']) {
      const r = await callTool({ name, arguments: { definition: yaml, name: 'sneaky' } }, WS.id) as { isError?: boolean; content: Array<{ text: string }> };
      expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(/from the host config/)]);
    }
    const p = await h!.proposals.mcp.propose(WS.id, { definition: yaml });
    expect(p).toMatchObject({ status: 'pending' });
    await h!.tick();
    expect(await new AutomationStore(store.kysely).list()).toEqual([]);
    await h!.reconcile([fresh('a')]);
    const edit = definitionToYaml({ name: 'a', description: 'edited by a session', triggers: [{ manual: {} }], concurrency: 'skip', steps: [{ id: 'go', prompt: { workspace: WS.id, mode: 'fresh', message: 'review' } }] });
    expect(await h!.proposals.mcp.proposeChange(WS.id, { id: 'a', definition: edit })).toMatchObject({ status: 'pending' });
    expect(await names()).toEqual([['a', true, 1]]);
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
        if (lost) throw new Error('lease lost');
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
});
