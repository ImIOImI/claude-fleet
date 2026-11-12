import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from '../main/automations/automationStore.js';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { setAutomationHandlers, setInboxHandlers } from '../main/mcpCore.js';
import { openTestInbox } from '../main/store/testStore.js';
import type { Principal } from './attachHub.js';
import { automationRpcChannels, rejectedNote, runtimeOf } from './automationRpc.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';
import { ProposalStore } from '../main/automations/proposalStore.js';
import { CONFIG_APPLIED_NOTE, MAX_PENDING_HOST_PROPOSALS, markConfigApplied, selfDefinition } from './hostProposals.js';
import { createLogger } from './log.js';
import { dispatchRpc } from './rpc.js';
import { fakeBroker } from './testFakes.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const yaml = (name: string, cron = '0 3 * * *', ws = '$self') =>
  `name: ${name}\ntriggers:\n  - schedule: { cron: "${cron}" }\nsteps:\n  - id: go\n    prompt: { workspace: ${ws}, mode: fresh, message: review }\n`;
const cfg = (name: string, cron = '0 3 * * *', message = 'review') =>
  ({ definition: { name, triggers: [{ schedule: { cron } }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message } }] }, enabled: true });
const ann: Principal = { identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier: 'steer' };

type Handlers = NonNullable<Parameters<typeof setAutomationHandlers>[0]>;

describe('host proposals are config drafts (D126)', () => {
  let inbox: InboxStore | null = null;
  let h: HostAutomations | null = null;
  afterEach(async () => {
    await h?.stop();
    await inbox?.close();
    h = null;
    inbox = null;
    setAutomationHandlers(null);
    setInboxHandlers(null);
  });

  async function setup() {
    let handlers: Handlers | null = null;
    const published: Array<[string, unknown]> = [];
    inbox = await openTestInbox();
    h = await startHostAutomations({
      inbox, workspace: () => WS, ops: fakeBroker([]).ops, mcpArgs: [], events: { publish: (c, p) => published.push([c, p]) },
      log: createLogger(() => undefined), tickMs: 3_600_000, settleMs: 10,
      onHandlers: (x) => { handlers = x; }
    });
    return { mcp: () => handlers!, published };
  }

  it('a session proposes with $self; the draft is pending, never auto-applied, and creates no automation', async () => {
    const { mcp } = await setup();
    const r = await mcp().propose(WS.id, { definition: yaml('triage'), rationale: 'r' }) as { status: string };
    expect(r.status).toBe('pending');
    expect(await h!.automations.list()).toEqual([]);
    const [p] = await h!.proposals.list();
    expect((p.items[0].after.steps[0] as { prompt: { workspace: string } }).prompt.workspace).toBe(WS.id);
    expect(p.proposer).toEqual({ kind: 'workspace', id: WS.id });
    await expect(mcp().propose('SOMEONE-ELSE', { definition: yaml('x') })).rejects.toThrow(/unknown workspace/);
    await expect(mcp().proposeChange('SOMEONE-ELSE', { id: 'triage', definition: yaml('triage') })).rejects.toThrow(/unknown workspace/);
  });

  it('refuses script and live steps with the host refusals', async () => {
    const { mcp } = await setup();
    const live = yaml('x').replace('mode: fresh', 'mode: live');
    await expect(mcp().propose(WS.id, { definition: live })).rejects.toThrow(/live is not available on a remote host/);
    const script = 'name: s\ntriggers:\n  - manual: {}\nsteps:\n  - id: sh\n    script: { run: "echo hi", runIn: $self }\n';
    await expect(mcp().propose(WS.id, { definition: script })).rejects.toThrow(/script steps are not available on a remote host/);
    expect(await h!.proposals.list()).toEqual([]);
  });

  it('a draft may not name another workspace, by name or id, in a new or a change proposal', async () => {
    const { mcp } = await setup();
    await expect(mcp().propose(WS.id, { definition: yaml('x', '0 3 * * *', 'other-bot') })).rejects.toThrow(/other-bot/);
    await expect(mcp().propose(WS.id, { definition: yaml('x', '0 3 * * *', '01JC0000000000000000000009') })).rejects.toThrow(/01JC0000000000000000000009/);
    await h!.reconcile([cfg('nightly')]);
    await expect(mcp().proposeChange(WS.id, { id: 'nightly', definition: yaml('nightly', '0 4 * * *', 'other-bot') })).rejects.toThrow(/other-bot/);
    await expect(mcp().proposeChange(WS.id, { batch: [{ id: 'nightly', definition: yaml('nightly', '0 4 * * *', 'other-bot') }] })).rejects.toThrow(/other-bot/);
    expect(await h!.proposals.list()).toEqual([]);
  });

  it('a change proposal binds $self in each batch item and stays pending', async () => {
    const { mcp } = await setup();
    await h!.reconcile([cfg('nightly')]);
    const r = await mcp().proposeChange(WS.id, { batch: [{ id: 'nightly', definition: yaml('nightly', '0 5 * * *') }] }) as { status: string };
    expect(r.status).toBe('pending');
    const [p] = await h!.proposals.list();
    expect((p.items[0].after.steps[0] as { prompt: { workspace: string } }).prompt.workspace).toBe(WS.id);
    expect((await h!.automations.list())[0].definition.triggers).toEqual([{ schedule: { cron: '0 3 * * *' } }]);
  });

  it(`caps pending drafts at ${MAX_PENDING_HOST_PROPOSALS}, concurrent proposals included`, async () => {
    const { mcp } = await setup();
    const all = await Promise.allSettled(Array.from({ length: MAX_PENDING_HOST_PROPOSALS + 3 }, (_, i) => mcp().propose(WS.id, { definition: yaml(`d${i}`) })));
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_PENDING_HOST_PROPOSALS);
    await expect(mcp().propose(WS.id, { definition: yaml('one-more') })).rejects.toThrow(/20 pending/);
    await expect(mcp().proposeChange(WS.id, { id: 'd0', definition: yaml('d0') })).rejects.toThrow(/20 pending/);
    expect(await h!.proposals.list()).toHaveLength(MAX_PENDING_HOST_PROPOSALS);
  });

  it('a draft becomes approved once the host config holds the same definition; a different one stays pending', async () => {
    const { mcp, published } = await setup();
    await mcp().propose(WS.id, { definition: yaml('triage') });
    await mcp().propose(WS.id, { definition: yaml('other') });
    published.length = 0;
    await h!.reconcile([cfg('triage'), cfg('other', '0 4 * * *')]);
    const ps = await h!.proposals.list();
    const triage = ps.find((p) => p.items[0].name === 'triage')!;
    const other = ps.find((p) => p.items[0].name === 'other')!;
    expect(triage).toMatchObject({ status: 'approved', note: CONFIG_APPLIED_NOTE, decidedAt: expect.any(Number) });
    expect(triage.items[0].decision).toBe('accepted');
    expect(triage.items[0].automationId).toBe((await h!.automations.list()).find((a) => a.name === 'triage')!.id);
    expect(other.status).toBe('pending');
    expect(published.filter(([c]) => c === 'proposals:changed')).toEqual([['proposals:changed', null]]);
  });

  it('compares canonically: the workspace by name and reordered keys still match; a same-name row not from the config does not', async () => {
    const { mcp } = await setup();
    const reordered = 'steps:\n  - prompt: { message: review, mode: fresh, workspace: review-bot }\n    id: go\ntriggers:\n  - schedule: { cron: "0 3 * * *" }\nname: triage\n';
    await mcp().propose(WS.id, { definition: reordered });
    await mcp().propose(WS.id, { definition: yaml('stray') });
    const s = new AutomationStore(inbox!.kysely);
    const def = (await h!.proposals.list()).find((p) => p.items[0].name === 'stray')!.items[0].after;
    await s.create(def, { kind: 'user', id: null }, Date.now(), true, { source: 'loadout' });
    await h!.reconcile([cfg('triage')]);
    const ps = await h!.proposals.list();
    expect(ps.find((p) => p.items[0].name === 'triage')!.status).toBe('approved');
    expect(ps.find((p) => p.items[0].name === 'stray')!.status).toBe('pending');
  });

  it('a change draft settles when the config catches up; a decided draft is left alone', async () => {
    const { mcp } = await setup();
    await h!.reconcile([cfg('nightly')]);
    await mcp().proposeChange(WS.id, { id: 'nightly', definition: yaml('nightly', '0 5 * * *') });
    await h!.reconcile([cfg('nightly', '0 4 * * *')]);
    expect((await h!.proposals.list())[0].status).toBe('pending');
    await h!.reconcile([cfg('nightly', '0 5 * * *')]);
    expect((await h!.proposals.list())[0]).toMatchObject({ status: 'approved', note: CONFIG_APPLIED_NOTE });
    await h!.reconcile([cfg('nightly', '0 5 * * *', 'again')]);
    await mcp().proposeChange(WS.id, { id: 'nightly', definition: yaml('nightly', '0 6 * * *') });
    const pending = (await h!.proposals.list()).find((p) => p.status === 'pending')!;
    await h!.proposals.reject(pending.id, 'no');
    await h!.reconcile([cfg('nightly', '0 6 * * *')]);
    expect((await h!.proposals.list()).find((p) => p.id === pending.id)).toMatchObject({ status: 'rejected', note: 'no' });
  });

  it('a Reject landing between the applied mark\'s read and its save wins', async () => {
    const { mcp } = await setup();
    const r = await mcp().propose(WS.id, { definition: yaml('triage') }) as { id: string };
    const store = new ProposalStore(inbox!.kysely);
    const def = (await store.get(r.id))!.items[0].after;
    const automations = new AutomationStore(inbox!.kysely);
    await automations.create(def, { kind: 'user', id: null }, Date.now(), true, { source: 'loadout' });
    const racing = Object.assign(Object.create(store) as ProposalStore, {
      pending: async () => { const ps = await store.pending(); await h!.proposals.reject(r.id, 'no'); return ps; }
    });
    expect(await markConfigApplied({ proposals: racing, automations, now: Date.now, isConfig: () => true })).toBe(0);
    expect(await store.get(r.id)).toMatchObject({ status: 'rejected', note: 'no' });
  });

  it('a Reject whose read precedes the applied mark refuses rather than overwrite it', async () => {
    const { mcp } = await setup();
    const r = await mcp().propose(WS.id, { definition: yaml('triage') }) as { id: string };
    const stale = (await new ProposalStore(inbox!.kysely).get(r.id))!;
    await h!.reconcile([cfg('triage')]);
    stale.status = 'rejected';
    stale.note = 'no';
    expect(await new ProposalStore(inbox!.kysely).saveIfPending(stale)).toBe(false);
    await expect(h!.proposals.reject(r.id, 'no')).rejects.toThrow(/already approved/);
    expect((await h!.proposals.list())[0]).toMatchObject({ status: 'approved', note: CONFIG_APPLIED_NOTE });
  });

  it('Reject over RPC is recorded under the person, and the session reads the note', async () => {
    const { mcp } = await setup();
    const r = await mcp().propose(WS.id, { definition: yaml('triage') }) as { id: string };
    const reg = automationRpcChannels(() => runtimeOf(h!, () => WS));
    const res = await dispatchRpc(reg, 'proposals:reject', { args: [{ requestId: '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a', id: r.id, note: 'too often' }] }, ann);
    expect(res.body).toMatchObject({ ok: true, result: { replayed: false, result: { id: r.id, status: 'rejected' } } });
    expect(await mcp().getProposal(WS.id, { id: r.id })).toMatchObject({ status: 'rejected', note: 'Rejected by @ann: too often' });
    await expect(mcp().getProposal('SOMEONE-ELSE', { id: r.id })).rejects.toThrow(/not found/);
  });

  it('a maximal Reject note fits under the prefix whole, so the stored note ends with the user\'s own text', async () => {
    const { mcp } = await setup();
    const r = await mcp().propose(WS.id, { definition: yaml('triage') }) as { id: string };
    const note = `${'a'.repeat(1990)}tail-words`;
    const want = rejectedNote(note, { kind: 'user', id: 'ann' });
    expect(want.length).toBe(2000);
    expect(want.startsWith('Rejected by @ann: aaa')).toBe(true);
    expect(rejectedNote('  short  ', { kind: 'user', id: null })).toBe('Rejected by host operator: short');
    expect(rejectedNote(' ', { kind: 'user', id: 'ann' })).toBe('Rejected by @ann');
    const reg = automationRpcChannels(() => runtimeOf(h!, () => WS));
    await dispatchRpc(reg, 'proposals:reject', { args: [{ requestId: '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6b', id: r.id, note }] }, ann);
    expect((await mcp().getProposal(WS.id, { id: r.id }) as { note: string }).note).toBe(want);
  });

  it('selfDefinition binds $self in text and objects and passes unparseable text through', () => {
    expect((selfDefinition(yaml('a'), WS.id) as { steps: Array<{ prompt: { workspace: string } }> }).steps[0].prompt.workspace).toBe(WS.id);
    expect((selfDefinition(cfg('a').definition, WS.id) as { steps: Array<{ prompt: { workspace: string } }> }).steps[0].prompt.workspace).toBe(WS.id);
    expect(selfDefinition('name: [', WS.id)).toBe('name: [');
  });
});
