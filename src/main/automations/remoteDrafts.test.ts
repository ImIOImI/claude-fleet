import { describe, expect, it } from 'vitest';
import { createRemoteDrafts, MAX_REMOTE_DRAFTS, REMOTE_DRAFT_REQUEST_MS, remoteDraftFor, remoteDraftReply, requestRemoteDraft, type RemoteDraftRequestDeps } from './remoteDrafts.js';

const O = '01JC0000000000000000000000';
const P = '01JC0000000000000000000001';
const yaml = (ws: string, name = 'triage', extra = '') =>
  `name: ${name}\ntriggers:\n  - schedule: { cron: "0 3 * * *" }\nsteps:\n  - id: go\n    prompt: { workspace: ${ws}, mode: fresh, message: review }\n${extra}`;

function setup() {
  const clock = { now: 1_000 };
  let n = 0;
  let changed = 0;
  let sources = [{ id: O, name: 'review-bot' }, { id: P, name: 'ops-bot' }];
  const r = createRemoteDrafts({ now: () => clock.now, sources: () => sources, newId: () => `D${++n}`, changed: () => { changed++; } });
  return { r, clock, changed: () => changed, setSources: (s: typeof sources) => { sources = s; } };
}

describe('remote drafts (D127: drafting runs locally)', () => {
  it('a definition naming a requested remote workspace becomes a validated in-memory draft for it', () => {
    const { r, changed } = setup();
    r.request(O);
    const d = r.take(yaml('review-bot'), 'nightly review', 'new')!;
    expect(d).toMatchObject({ id: 'D1', origin: O, workspaceName: 'review-bot', kind: 'new', name: 'triage', rationale: 'nightly review', createdAt: 1_000 });
    expect((d.definition.steps[0] as { prompt: { workspace: string } }).prompt.workspace).toBe(O);
    expect(r.list()).toEqual([d]);
    expect(changed()).toBe(1);
    expect(remoteDraftReply(d)).toMatchObject({ id: 'D1', status: 'draft', note: expect.stringMatching(/platform-ops PR.*nothing was sent to the host/i) });
  });

  it('is not a remote draft (local path) when nothing was requested, the request expired, or it names no requested workspace', () => {
    const { r, clock } = setup();
    expect(r.take(yaml('review-bot'), null, 'new')).toBeNull();
    r.request(O);
    expect(r.take(yaml('local-ws'), null, 'new')).toBeNull();
    expect(r.take(yaml('ops-bot'), null, 'new')).toBeNull();
    clock.now += REMOTE_DRAFT_REQUEST_MS;
    expect(r.take(yaml('review-bot'), null, 'new')).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it('applies the host refusals and resolves only that workspace', () => {
    const { r } = setup();
    r.request(O);
    expect(() => r.take(yaml('review-bot').replace('mode: fresh', 'mode: live'), null, 'new')).toThrow(/live is not available on a remote host/);
    const script = 'name: s\ntriggers:\n  - manual: {}\nsteps:\n  - id: a\n    prompt: { workspace: review-bot, mode: fresh, message: x }\n  - id: sh\n    script: { run: "echo hi" }\n';
    expect(() => r.take(script, null, 'new')).toThrow(/script steps are not available on a remote host/);
    const mixed = yaml('review-bot') + '  - id: two\n    prompt: { workspace: local-ws, mode: fresh, message: x }\n';
    expect(() => r.take(mixed, null, 'new')).toThrow(/local-ws/);
    expect(r.list()).toEqual([]);
  });

  it('binds $self only when exactly one remote workspace was requested; two named hosts are refused', () => {
    const { r } = setup();
    r.request(O);
    expect(r.take(yaml('$self'), null, 'new')!.origin).toBe(O);
    r.request(P);
    expect(r.take(yaml('$self', 'other'), null, 'new')).toBeNull();
    const both = yaml('review-bot') + '  - id: two\n    prompt: { workspace: ops-bot, mode: fresh, message: x }\n';
    expect(() => r.take(both, null, 'new')).toThrow(/only that host/);
  });

  it('a later draft of the same name replaces the earlier one; the list is capped; a forgotten bookmark drops its drafts', () => {
    const { r, setSources } = setup();
    r.request(O);
    r.take(yaml('review-bot'), 'one', 'new');
    r.take(yaml('review-bot'), 'two', 'change');
    expect(r.list().map((d) => [d.name, d.rationale, d.kind])).toEqual([['triage', 'two', 'change']]);
    for (let i = 0; i < MAX_REMOTE_DRAFTS + 3; i++) r.take(yaml('review-bot', `a${i}`), null, 'new');
    expect(r.list()).toHaveLength(MAX_REMOTE_DRAFTS);
    setSources([{ id: P, name: 'ops-bot' }]);
    expect(r.list()).toEqual([]);
  });

  it('dismiss removes one draft; the rationale is one-lined and capped', () => {
    const { r } = setup();
    r.request(O);
    const d = r.take(yaml('review-bot'), `line one\nline two${'x'.repeat(600)}`, 'new')!;
    expect(d.rationale!.length).toBe(500);
    expect(d.rationale).not.toMatch(/\n/);
    r.dismiss(d.id);
    expect(r.list()).toEqual([]);
  });
});

describe('requestRemoteDraft: a local drafting session with read-tier host context', () => {
  const def = { name: 'nightly', triggers: [{ schedule: { cron: '0 3 * * *' } }], steps: [{ id: 'go', prompt: { workspace: O, mode: 'fresh', message: 'review' } }] };
  function deps(o: { list?: unknown; get?: unknown } = {}) {
    const calls: string[] = [];
    const requested: string[] = [];
    const posted: string[] = [];
    const d: RemoteDraftRequestDeps = {
      reader: {
        sources: () => [{ id: O, name: 'review-bot' }] as never,
        one: (async (_o: string, channel: string) => {
          calls.push(channel);
          return channel === 'automations:list' ? (o.list ?? { ok: true, value: ['nightly', 'triage'] }) : (o.get ?? { ok: true, value: { automation: { name: 'nightly', definition: def } } });
        }) as never
      },
      drafts: { request: (x) => { requested.push(x); } },
      post: async (p) => { posted.push(p); return 'ROLE'; }
    };
    return { d, calls, requested, posted };
  }

  it('reads the list and the definition (read channels only), arms the origin and posts locally', async () => {
    const { d, calls, requested, posted } = deps();
    expect(await requestRemoteDraft(d, O, 'run at 4 instead', 'A1')).toBe('ROLE');
    expect(calls).toEqual(['automations:list', 'automations:get']);
    expect(requested).toEqual([O]);
    expect(posted[0]).toMatch(/propose_automation_change \(id = that automation's name/);
    expect(posted[0]).toMatch(/=== BEGIN HOST DATA [0-9a-f]{32} ===\nWorkspace: "review-bot"\nAutomations already on this workspace: nightly, triage\.\nAutomation to change: nightly\n/);
    expect(posted[0]).toMatch(/platform-ops PR/);
    expect(posted[0]).toMatch(/Automations already on this workspace: nightly, triage\./);
    expect(posted[0]).toContain('cron: 0 3 * * *');
    expect(posted[0]).toContain('run at 4 instead');
  });

  it('a new draft reads only the list; an unreadable host still drafts, with the list unknown', async () => {
    const { d, calls, posted } = deps({ list: { ok: false, reason: 'unreachable' } });
    await requestRemoteDraft(d, O, 'triage new issues', null);
    expect(calls).toEqual(['automations:list']);
    expect(posted[0]).toMatch(/submit it with propose_automation \(/);
    expect(posted[0]).toMatch(/\(unknown: could not be read\)/);
  });

  it('an unknown bookmark or an unreadable definition starts nothing', async () => {
    const a = deps();
    await expect(requestRemoteDraft(a.d, P, 'x', null)).rejects.toThrow(/no longer bookmarked/);
    expect([a.calls, a.requested, a.posted]).toEqual([[], [], []]);
    const b = deps({ get: { ok: true, value: null } });
    await expect(requestRemoteDraft(b.d, O, 'x', 'A1')).rejects.toThrow(/couldn't read that automation/);
    expect([b.requested, b.posted]).toEqual([[], []]);
  });
});

describe('remoteDraftFor: which propose calls become remote drafts', () => {
  it('only the local automations workspace, never a batch; everything else takes the local path', () => {
    const { r } = setup();
    r.request(O);
    const args = { definition: yaml('review-bot'), rationale: 'r' };
    expect(remoteDraftFor(r, 'OTHER', 'ROLE', args, 'new')).toBeNull();
    expect(remoteDraftFor(r, 'ROLE', null, args, 'new')).toBeNull();
    expect(remoteDraftFor(r, 'ROLE', 'ROLE', { ...args, batch: [args] }, 'change')).toBeNull();
    expect(r.list()).toEqual([]);
    expect(remoteDraftFor(r, 'ROLE', 'ROLE', args, 'change')).toMatchObject({ status: 'draft' });
    expect(r.list().map((d) => d.kind)).toEqual(['change']);
  });
});
