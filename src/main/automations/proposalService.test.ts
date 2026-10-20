import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import { ProposalStore } from './proposalStore.js';
import { createProposalService } from './proposalService.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());
const WSS: Record<string, string> = { 'ops-oncall': 'W1', 'webex-triage': 'W2', automations: 'WA' };

function setup(trusted: string[] = []) {
  inbox = InboxStore.memory();
  const automations = new AutomationStore(inbox.db);
  const notes: Array<Record<string, unknown>> = [];
  let t = 1_000_000;
  const svc = createProposalService({
    proposals: new ProposalStore(inbox.db), automations, now: () => ++t,
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
    const { svc, notes } = setup();
    const r = await svc.mcp.propose('W2', { definition: YAML(), rationale: 'I keep missing 5xx spikes' });
    expect(r).toMatchObject({ status: 'pending', items: [{ name: 'log-watch', decision: 'pending', reasons: ['new automation'] }] });
    const p = svc.list()[0];
    expect(p).toMatchObject({ kind: 'new', proposer: { kind: 'workspace', id: 'W2' }, rationale: 'I keep missing 5xx spikes' });
    expect(p.items[0].flags).toEqual(['prompts ops-oncall (live session)', 'runs every 15 min']);
    expect(notes[0]).toMatchObject({ kind: 'proposal', title: 'webex-triage proposes a new automation: log-watch' });
    expect(svc.pendingCount()).toBe(1);
  });
  it('rejects invalid definitions and name collisions with readable errors', async () => {
    const { svc, automations } = setup();
    await expect(svc.mcp.propose('W2', { definition: 'name: Bad' })).rejects.toThrow(/definition: name:/);
    automations.create({ name: 'log-watch', triggers: [{ manual: {} }], steps: [{ id: 'a', prompt: { workspace: 'W1', mode: 'live', message: 'm' } }] }, { kind: 'user', id: null });
    await expect(svc.mcp.propose('W2', { definition: YAML() })).rejects.toThrow(/already exists; propose a change/);
  });
  it('a newer proposal from the same workspace supersedes the older one', async () => {
    const { svc } = setup();
    await svc.mcp.propose('W2', { definition: YAML() });
    await svc.mcp.propose('W2', { definition: YAML('log-watch', '*/30 * * * *') });
    expect(svc.list().map((p) => p.status).sort()).toEqual(['pending', 'superseded']);
  });
});

describe('approving', () => {
  it('approve creates the automation as the proposer; edit-then-approve uses the edited YAML', async () => {
    const { svc, automations } = setup();
    const { id } = await svc.mcp.propose('W2', { definition: YAML() });
    const p = svc.approve(id, { editedYaml: YAML('log-watch', '*/20 * * * *') });
    expect(p.status).toBe('approved');
    const a = automations.byName('log-watch')!;
    expect(a.createdBy).toEqual({ kind: 'workspace', id: 'W2' });
    expect((a.definition.triggers[0] as { schedule: { cron: string } }).schedule.cron).toBe('*/20 * * * *');
    expect(() => svc.approve(id)).toThrow(/already approved/);
  });
  it('reject declines with a note the workspace can read', async () => {
    const { svc } = setup();
    const { id } = await svc.mcp.propose('W2', { definition: YAML() });
    svc.reject(id, 'too noisy');
    expect(await svc.mcp.get('W2', { id })).toMatchObject({ status: 'rejected', note: 'too noisy' });
    await expect(svc.mcp.get('W1', { id })).rejects.toThrow(/not found/);
  });
  it('a change whose automation moved on since it was proposed is refused', async () => {
    const { svc, automations } = setup();
    const a = automations.create({ name: 'log-watch', triggers: [{ schedule: { cron: '*/15 * * * *' } }], steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }] }, { kind: 'user', id: null });
    const { id } = await svc.mcp.proposeChange('W2', { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') });
    automations.update(a.id, { ...automations.get(a.id)!.definition, description: 'edited by you' }, { kind: 'user', id: null });
    expect(() => svc.approve(id)).toThrow(/changed since this was proposed \(now v2\)/);
  });
});

describe('trusted tier + batches', () => {
  const seed = (automations: AutomationStore, name: string) =>
    automations.create({ name, triggers: [{ schedule: { cron: '*/10 * * * *' } }], steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }] }, { kind: 'user', id: null });
  it('a trusted workspace auto-applies low-risk items; the rest wait, item by item', async () => {
    const { svc, automations } = setup(['WA']);
    seed(automations, 'log-watch');
    seed(automations, 'queue-watch');
    const r = await svc.mcp.proposeChange('WA', {
      rationale: 'tag the watchers and slow them down',
      batch: [
        { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') },
        { id: 'queue-watch', definition: YAML('queue-watch', '*/15 * * * *').replace('mode: live', 'mode: live, ensureRunning: true') }
      ]
    });
    expect(r.status).toBe('pending');
    expect(r.items.map((i) => [i.name, i.decision])).toEqual([['log-watch', 'auto-applied'], ['queue-watch', 'pending']]);
    expect(automations.byName('log-watch')!.version).toBe(2);
    const p = svc.approve(r.id, { accept: [] });
    expect(p.status).toBe('partial');
    expect(p.items[1].decision).toBe('declined');
    const reverted = svc.revert(r.id, 0);
    expect(reverted.items[0].decision).toBe('reverted');
    expect(automations.byName('log-watch')!.definition.tags).toBeUndefined();
    expect(automations.byName('log-watch')!.version).toBe(3);
  });
  it('an untrusted workspace never auto-applies, even low-risk edits', async () => {
    const { svc, automations } = setup();
    seed(automations, 'log-watch');
    const r = await svc.mcp.proposeChange('W2', { id: 'log-watch', definition: YAML('log-watch', '*/15 * * * *', 'tags: [ops]\n') });
    expect(r.items[0]).toMatchObject({ decision: 'pending', lowRisk: true });
  });
});
