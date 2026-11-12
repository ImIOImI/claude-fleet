import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { InboxStore } from '../inbox/inboxDb.js';
import { openTestInbox } from '../store/testStore.js';
import { AutomationStore } from './automationStore.js';
import { createAutomationService } from './automationService.js';
import { ProposalStore } from './proposalStore.js';
import { createProposalService } from './proposalService.js';
import { createRemoteDrafts, remoteDraftFor } from './remoteDrafts.js';
import { localWorkspaces, remoteTargetRefusal, resolveLocalWorkspace, type NamedWorkspace } from './localTargets.js';

const R = '01JC0000000000000000000000';
const NAMES: NamedWorkspace[] = [
  { id: 'W1', name: 'ops-oncall', kind: 'container' },
  { id: 'WL', name: 'laptop', kind: 'local' },
  { id: R, name: 'review-bot', kind: 'remote' }
];
const REFUSED = /review-bot is a remote workspace: its automations come from its host config; use Draft for review-bot/;
const yaml = (ws: string, name = 'triage') =>
  `name: ${name}\ntriggers:\n  - schedule: { cron: "0 3 * * *" }\nsteps:\n  - id: go\n    prompt: { workspace: ${ws}, mode: fresh, message: review }\n`;

let inbox: InboxStore;
afterEach(() => inbox?.close());

async function setup() {
  inbox = await openTestInbox();
  const automations = new AutomationStore(inbox.kysely);
  const resolve = (v: string) => resolveLocalWorkspace(NAMES, v);
  const refuse = (v: string) => remoteTargetRefusal(NAMES, v);
  let t = 1_000_000;
  const proposals = createProposalService({
    proposals: new ProposalStore(inbox.kysely), automations, now: () => ++t,
    resolveWorkspace: resolve, refuseWorkspace: refuse,
    workspaceName: (id) => NAMES.find((n) => n.id === id)?.name ?? id,
    trusted: async () => false, changed: () => {}
  });
  const svc = createAutomationService({
    store: automations, now: () => t, sleep: async () => {},
    workspaceState: async () => 'running', workspaceName: (id) => id,
    ensureRunning: async () => {}, busy: () => false,
    spawnFresh: async () => {}, freshState: async () => 'ended', closeFresh: async () => {},
    post: async () => ({ via: 'attached' }),
    resolveWorkspace: resolve, refuseWorkspace: refuse,
    changed: () => {}, automationsWorkspace: () => 'W1',
    execScript: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
  });
  return { proposals, svc, automations };
}

describe('remote bookmarks are not local automation targets (D125, §8)', () => {
  it('resolves local workspaces only; a remote match is refused by name or id', () => {
    expect(resolveLocalWorkspace(NAMES, 'ops-oncall')).toBe('W1');
    expect(resolveLocalWorkspace(NAMES, 'laptop')).toBe('WL');
    expect(resolveLocalWorkspace(NAMES, 'review-bot')).toBeNull();
    expect(resolveLocalWorkspace(NAMES, R)).toBeNull();
    expect(remoteTargetRefusal(NAMES, 'review-bot')).toMatch(REFUSED);
    expect(remoteTargetRefusal(NAMES, R)).toMatch(REFUSED);
    expect(remoteTargetRefusal(NAMES, 'nope')).toBeNull();
    expect(remoteTargetRefusal(NAMES, 'ops-oncall')).toBeNull();
    expect(localWorkspaces(NAMES).map((n) => n.id)).toEqual(['W1', 'WL']);
  });

  it('a local workspace sharing a remote bookmark\'s name wins', () => {
    const names = [...NAMES, { id: 'W9', name: 'review-bot', kind: 'container' }];
    expect(resolveLocalWorkspace(names, 'review-bot')).toBe('W9');
    expect(remoteTargetRefusal(names, 'review-bot')).toBeNull();
  });

  it('a local propose naming a remote bookmark is refused', async () => {
    const { proposals } = await setup();
    await expect(proposals.mcp.propose('W1', { definition: yaml('review-bot') })).rejects.toThrow(REFUSED);
    await expect(proposals.mcp.propose('W1', { definition: yaml(R) })).rejects.toThrow(REFUSED);
    expect(await proposals.list()).toEqual([]);
    expect((await proposals.mcp.propose('W1', { definition: yaml('ops-oncall') })).status).toBe('pending');
  });

  it('a batch change naming a remote bookmark is refused', async () => {
    const { proposals, svc } = await setup();
    const a = await svc.create(yaml('ops-oncall', 'one'), { kind: 'user', id: null });
    const b = await svc.create(yaml('laptop', 'two'), { kind: 'user', id: null });
    await expect(proposals.mcp.proposeChange('W1', {
      batch: [{ id: a.id, definition: yaml('ops-oncall', 'one') }, { id: b.id, definition: yaml('review-bot', 'two') }]
    })).rejects.toThrow(REFUSED);
    await expect(proposals.mcp.proposeChange('W1', { id: a.id, definition: yaml('review-bot', 'one') })).rejects.toThrow(REFUSED);
    expect(await proposals.list()).toEqual([]);
  });

  it('automations:create and update naming a remote bookmark are refused', async () => {
    const { svc, automations } = await setup();
    await expect(svc.create(yaml('review-bot'), { kind: 'user', id: null })).rejects.toThrow(REFUSED);
    expect(await automations.list()).toEqual([]);
    const a = await svc.create(yaml('ops-oncall'), { kind: 'user', id: null });
    await expect(svc.update(a.id, yaml('review-bot'), { kind: 'user', id: null })).rejects.toThrow(REFUSED);
    expect(svc.validate(yaml('review-bot')).errors.join('\n')).toMatch(REFUSED);
    const script = `name: s\ntriggers:\n  - manual: { allowFrom: [review-bot] }\n  - event: { on: session.idle, workspace: review-bot }\nsteps:\n  - id: a\n    script: { run: "true", runIn: review-bot }\n`;
    const errs = svc.validate(script).errors;
    expect(errs.filter((e) => REFUSED.test(e))).toHaveLength(3);
  });

  it('remote drafting still takes the requested remote workspace before the local path', () => {
    const drafts = createRemoteDrafts({ now: () => 1, sources: () => [{ id: R, name: 'review-bot' }], newId: () => 'D1', changed: () => {} });
    drafts.request(R);
    expect(remoteDraftFor(drafts, 'ROLE', 'ROLE', { definition: yaml('review-bot') }, 'new')).toMatchObject({ status: 'draft' });
    expect(drafts.list().map((d) => d.origin)).toEqual([R]);
  });

  it('automationIpc feeds both resolvers, loadout installs and the drafting context from local workspaces only', () => {
    const src = readFileSync(new URL('./automationIpc.ts', import.meta.url), 'utf8');
    expect(src.match(/resolveWorkspace: resolveLocal,\n\s+refuseWorkspace: refuseRemote,/g)).toHaveLength(2);
    expect(src).not.toMatch(/names\.find\(\(n\) => n\.name === v\)/);
    expect(src).toContain('{ workspace: resolveLocal, refusal: refuseRemote, hostShells: hostShellIds() }');
    expect(src).toContain('const ctx = { workspaces: localWorkspaces(names).filter((n) => n.id !== roleWs).map((n) => n.name),');
    const ipc = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8');
    expect(ipc).toContain('.map((w) => ({ id: w.id, name: w.name, kind: w.kind }))');
  });
});
