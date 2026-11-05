import { describe, it, expect, afterEach } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import { ProposalStore } from './proposalStore.js';
import { createProposalService } from './proposalService.js';
import { openTestInbox } from '../store/testStore.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());
const WSS: Record<string, string> = { 'ops-oncall': 'W1', 'webex-triage': 'W2', automations: 'WA' };

async function setup(trusted: string[] = []) {
  inbox = (await openTestInbox());
  const automations = new AutomationStore(inbox.kysely);
  const notes: Array<Record<string, unknown>> = [];
  let t = 1_000_000;
  const svc = createProposalService({
    proposals: new ProposalStore(inbox.kysely), automations, now: () => ++t,
    resolveWorkspace: (v) => WSS[v] ?? (Object.values(WSS).includes(v) ? v : null),
    workspaceName: (id) => Object.entries(WSS).find(([, v]) => v === id)?.[0] ?? id,
    trusted: async (id) => trusted.includes(id),
    notify: (n) => { notes.push(n as never); return null; },
    changed: () => {}
  });
  return { svc, automations, notes };
}

const YAML = (name = 'log-watch', cron = '*/15 * * * *', extra = '') => `name: ${name}
triggers:
  - schedule: { cron: "${cron}" }
steps:
  - id: check
    prompt: { workspace: ops-oncall, mode: live, message: "check logs" }
${extra}`;

describe('proposing', () => {
  it('a new automation is pending with reasons and flags, and notifies', async () => {
    const { svc, notes } = await setup();
    const r = await svc.mcp.propose('W2', { definition: YAML(), rationale: 'I keep missing 5xx spikes' });
    expect(r).toMatchObject({ status: 'pending', items: [{ name: 'log-watch', decision: 'pending', reasons: ['new automation'] }] });
    const p = (await svc.list())[0];
    expect(p).toMatchObject({ kind: 'new', proposer: { kind: 'workspace', id: 'W2' }, rationale: 'I keep missing 5xx spikes' });
    expect(p.items[0].flags).toEqual(['prompts ops-oncall (live session)', 'runs every 15 min']);
    expect(notes[0]).toMatchObject({ kind: 'proposal', title: 'webex-triage proposes a new automation: log-watch' });
    expect(await svc.pendingCount()).toBe(1);
  });
  it('rejects invalid definitions and name collisions with readable errors', async () => {
    const { svc, automations } = await setup();
    await expect(svc.mcp.propose('W2', { definition: 'name: Bad' })).rejects.toThrow(/definition: name:/);
    await automations.create({ name: 'log-watch', triggers: [{ manual: {} }], steps: [{ id: 'a', prompt: { workspace: 'W1', mode: 'live', message: 'm' } }] }, { kind: 'user', id: null });
    await expect(svc.mcp.propose('W2', { definition: YAML() })).rejects.toThrow(/already exists; propose a change/);
  });
  it('a newer proposal from the same workspace supersedes the older one', async () => {
    const { svc } = await setup();
    await svc.mcp.propose('W2', { definition: YAML() });
    await svc.mcp.propose('W2', { definition: YAML('log-watch', '*/30 * * * *') });
    expect((await svc.list()).map((p) => p.status).sort()).toEqual(['pending', 'superseded']);
  });
});

describe('approving', () => {
  it('approve creates the automation as the proposer; edit-then-approve uses the edited YAML', async () => {
    const { svc, automations } = await setup();
    const { id } = await svc.mcp.propose('W2', { definition: YAML() });
    const p = await svc.approve(id, { editedYaml: YAML('log-watch', '*/20 * * * *') });
    expect(p.status).toBe('approved');
    const a = (await automations.byName('log-watch'))!;
    expect(a.createdBy).toEqual({ kind: 'workspace', id: 'W2' });
    expect((a.definition.triggers[0] as { schedule: { cron: string } }).schedule.cron).toBe('*/20 * * * *');
    await expect(svc.approve(id)).rejects.toThrow(/already approved/);
  });
  it('reject declines with a note the workspace can read', async () => {
    const { svc } = await setup();
    const { id } = await svc.mcp.propose('W2', { definition: YAML() });
    await svc.reject(id, 'too noisy');
    expect(await svc.mcp.get('W2', { id })).toMatchObject({ status: 'rejected', note: 'too noisy' });
    await expect(svc.mcp.get('W1', { id })).rejects.toThrow(/not found/);
  });
  it('a change whose automation moved on since it was proposed is refused', async () => {
    const { svc, automations } = await setup();
    const a = await automations.create({ name: 'log-watch', triggers: [{ schedule: { cron: '*/15 * * * *' } }], steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }] }, { kind: 'user', id: null });
    const { id } = await svc.mcp.proposeChange('W2', { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') });
    await automations.update(a.id, { ...(await automations.get(a.id))!.definition, description: 'edited by you' }, { kind: 'user', id: null });
    await expect(svc.approve(id)).rejects.toThrow(/changed since this was proposed \(now v2\)/);
  });
});

describe('trusted tier + batches', () => {
  const seed = (automations: AutomationStore, name: string) =>
    automations.create({ name, triggers: [{ schedule: { cron: '*/10 * * * *' } }], steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }] }, { kind: 'user', id: null });
  it('a trusted workspace auto-applies low-risk items; the rest wait, item by item', async () => {
    const { svc, automations } = await setup(['WA']);
    await seed(automations, 'log-watch');
    await seed(automations, 'queue-watch');
    const r = await svc.mcp.proposeChange('WA', {
      rationale: 'tag the watchers and slow them down',
      batch: [
        { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') },
        { id: 'queue-watch', definition: YAML('queue-watch', '*/15 * * * *').replace('mode: live', 'mode: live, ensureRunning: true') }
      ]
    });
    expect(r.status).toBe('pending');
    expect(r.items.map((i) => [i.name, i.decision])).toEqual([['log-watch', 'auto-applied'], ['queue-watch', 'pending']]);
    expect((await automations.byName('log-watch'))!.version).toBe(2);
    const p = await svc.approve(r.id, { accept: [] });
    expect(p.status).toBe('partial');
    expect(p.items[1].decision).toBe('declined');
    const reverted = await svc.revert(r.id, 0);
    expect(reverted.items[0].decision).toBe('reverted');
    expect((await automations.byName('log-watch'))!.definition.tags).toBeUndefined();
    expect((await automations.byName('log-watch'))!.version).toBe(3);
  });
  it('an untrusted workspace never auto-applies, even low-risk edits', async () => {
    const { svc, automations } = await setup();
    await seed(automations, 'log-watch');
    const r = await svc.mcp.proposeChange('W2', { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') });
    expect(r.items[0]).toMatchObject({ decision: 'pending', lowRisk: true });
  });
});

describe('decision guard', () => {
  it('two concurrent approvals of one proposal apply it once', async () => {
    const { svc, automations } = await setup();
    await svc.mcp.propose('W2', { definition: YAML() });
    const p = (await svc.list())[0];
    const results = await Promise.allSettled([svc.approve(p.id), svc.approve(p.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already being decided|already approved/);
    expect((await automations.list()).filter((a) => a.name === 'log-watch')).toHaveLength(1);
  });
  it('two different proposals for one automation, approved concurrently: one applies, the other is refused', async () => {
    const { svc, automations } = await setup();
    await automations.create({ name: 'log-watch', triggers: [{ schedule: { cron: '*/10 * * * *' } }], steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }] }, { kind: 'user', id: null });
    const p1 = await svc.mcp.proposeChange('W2', { id: 'log-watch', definition: YAML('log-watch', '*/20 * * * *') });
    const p2 = await svc.mcp.proposeChange('WA', { id: 'log-watch', definition: YAML('log-watch', '*/30 * * * *') });
    const results = await Promise.allSettled([svc.approve(p1.id), svc.approve(p2.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/changed/);
    expect((await automations.byName('log-watch'))!.version).toBe(2);
    expect((await automations.versions((await automations.byName('log-watch'))!.id)).map((v) => v.version)).toEqual([2, 1]);
  });
});

describe('capture-settings proposals (#483 §5a)', () => {
  const d = defaultCaptureSettings();
  const change = {
    workspaceId: 'W2', before: d, after: { ...d, turnsEvery: 30 },
    changes: ['turnsEvery: off → 30'], reasons: ['turns periodic capture on (every 30 turns)']
  };
  it('creates a pending proposal carrying the change, notifies, and counts as one pending', async () => {
    const { svc, notes } = await setup();
    const p = await svc.proposeCaptureSettings('W2', change, 'long sessions');
    expect(p).toMatchObject({ kind: 'capture-settings', status: 'pending', items: [], captureSettings: change, rationale: 'long sessions' });
    expect(notes[0]).toMatchObject({ kind: 'proposal', title: 'webex-triage proposes knowledge-capture changes: turnsEvery: off → 30' });
    expect(await svc.pendingCount()).toBe(1);
    expect(await svc.mcp.get('W2', { id: p.id })).toMatchObject({ status: 'pending', captureSettings: change });
  });
  it('a newer one supersedes the older pending one from the same workspace', async () => {
    const { svc } = await setup();
    await svc.proposeCaptureSettings('W2', change, null);
    await svc.proposeCaptureSettings('W2', change, null);
    expect((await svc.list()).map((p) => p.status).sort()).toEqual(['pending', 'superseded']);
  });
  it('approve applies through the injected applier; reject declines without applying', async () => {
    const { svc } = await setup();
    const applied: unknown[] = [];
    svc.setCaptureSettingsApplier(async (ws, c, id) => { applied.push([ws, c, id]); });
    const p = await svc.proposeCaptureSettings('W2', change, null);
    expect((await svc.approve(p.id)).status).toBe('approved');
    expect(applied).toEqual([['W2', change, p.id]]);
    const q = await svc.proposeCaptureSettings('W2', change, null);
    expect((await svc.reject(q.id, 'no')).status).toBe('rejected');
    expect(applied).toHaveLength(1);
  });
  it('approve fails clearly when no applier is wired', async () => {
    const { svc } = await setup();
    const p = await svc.proposeCaptureSettings('W2', change, null);
    await expect(svc.approve(p.id)).rejects.toThrow(/knowledge capture settings are unavailable/);
  });
});

describe('ProposalStore ordering (M3 id tiebreaks)', () => {
  it('breaks a created_at tie by id, the same way on both dialects', async () => {
    inbox = (await openTestInbox());
    const store = new ProposalStore(inbox.kysely);
    const row = (id: string) => ({
      id, kind: 'new' as const, proposer_kind: 'workspace' as const, proposer_id: 'W1', rationale: null,
      status: 'pending' as const, items: '[]', created_at: 100, decided_at: null
    });
    await inbox.kysely.insertInto('proposals').values(row('b')).execute();
    await inbox.kysely.insertInto('proposals').values(row('a')).execute();
    expect((await store.pending()).map((p) => p.id)).toEqual(['a', 'b']);
    expect((await store.list()).map((p) => p.id)).toEqual(['b', 'a']);
  });
});
