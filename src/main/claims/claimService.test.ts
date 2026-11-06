import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxStore } from '../inbox/inboxDb.js';
import { openTestInbox } from '../store/testStore.js';
import { ClaimStore } from './claimStore.js';
import { CaptureRunStore } from './captureRunStore.js';
import { ClaimService } from './claimService.js';

// Deterministic fake embedder: texts sharing a leading word get identical
// vectors (cosine 1); different leading words are orthogonal.
const DIM = 384;
const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(DIM); v[t.split(/\s+/)[0].length % DIM] = 1; return v;
});

let inbox: InboxStore; let svc: ClaimService; let runs: CaptureRunStore; let t = 1000;
beforeEach(async () => {
  inbox = await openTestInbox();
  runs = new CaptureRunStore(inbox.kysely);
  svc = new ClaimService({ claims: new ClaimStore(inbox.kysely, inbox.dialect), runs, embed: fakeEmbed,
    workspaceName: async (id) => `name-${id}`, now: () => ++t });
});
afterEach(async () => { await inbox.close(); });

const base = { kind: 'root-cause', topics: ['mcp-query'] };

describe('ClaimService.record', () => {
  it('records and returns suggested topics from neighbours', async () => {
    await svc.record('wsA', { ...base, text: 'snapshot copies history', topics: ['mcp-query', 'state-db'] });
    const r = await svc.record('wsB', { ...base, text: 'snapshot freezes main', kind: 'fact' });
    expect(r.deduped).toBe(false);
    expect(r.suggestedTopics).toContain('state-db');
  });
  it('dedupes a near-identical claim of the same kind', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsB', { ...base, text: 'snapshot copies everything' });
    expect(b).toMatchObject({ id: a.id, deduped: true });
  });
  it('does not dedupe across kinds', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsA', { ...base, kind: 'decision', text: 'snapshot moves to a worker' });
    expect(b.id).not.toBe(a.id);
  });
  it('rejects secrets without echoing them', async () => {
    await expect(svc.record('wsA', { ...base, text: 'use ghp_' + 'a'.repeat(36) })).rejects.toThrow(/secret \(github-token\)/);
    await expect(svc.record('wsA', { ...base, text: 'use ghp_' + 'a'.repeat(36) })).rejects.not.toThrow(/ghp_a/);
  });
  it('supersedes a visible current claim and skips dedupe', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const b = await svc.record('wsA', { ...base, text: 'snapshot runs in a worker now', supersedes: a.id });
    expect(b.deduped).toBe(false);
    const hits = await svc.search('wsA', { query: 'snapshot', include_superseded: true });
    expect(hits.results.find((h) => h.id === a.id)).toMatchObject({ status: 'superseded', supersededBy: b.id });
  });
  it('refuses to hide a fleet claim behind a private replacement, and leaves the target current', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    await expect(svc.record('wsB', { ...base, text: 'snapshot is fine actually', visibility: 'private', supersedes: a.id }))
      .rejects.toThrow(/fleet claim.*fleet/);
    expect((await svc.search('wsB', { query: 'snapshot' })).results.find((h) => h.id === a.id)?.status).toBe('current');
    // A private capture run forces private, so it can't supersede a fleet claim either.
    const run = await runs.start({ workspaceId: 'wsB', sessionId: 'l', forkSessionId: 'f', trigger: 'ctx-85', visibility: 'private', now: 1 });
    await expect(svc.record('wsB', { ...base, text: 'other view', supersedes: a.id, capture_run: run })).rejects.toThrow(/fleet/);
    // Private → fleet (raising visibility) and private → private are fine.
    const p = await svc.record('wsA', { ...base, kind: 'gotcha', text: 'private note', visibility: 'private' });
    const q = await svc.record('wsA', { ...base, kind: 'gotcha', text: 'published note', supersedes: p.id });
    expect((await svc.search('wsA', { query: 'note', include_superseded: true })).results.find((h) => h.id === p.id))
      .toMatchObject({ status: 'superseded', supersededBy: q.id });
  });
  it('rolls back the new claim when the supersede fails (insert + supersede are one transaction)', async () => {
    const a = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const store = new ClaimStore(inbox.kysely, inbox.dialect);
    const boom = Object.assign(Object.create(store) as ClaimStore, {
      visible: store.visible.bind(store),
      insert: (...args: Parameters<ClaimStore['insert']>) => store.insert(args[0], args[1], args[2], args[3], { ...args[4]!, supersedes: 'no-such-claim' })
    });
    const s2 = new ClaimService({ claims: boom, runs, embed: fakeEmbed, workspaceName: async () => null, now: () => ++t });
    await expect(s2.record('wsA', { ...base, text: 'replacement claim', supersedes: a.id })).rejects.toThrow(/supersede/);
    expect((await svc.search('wsA', { query: 'replacement', include_superseded: true })).results.map((h) => h.text)).toEqual(['snapshot copies history']);
    expect((await svc.search('wsA', { query: 'snapshot' })).results.find((h) => h.id === a.id)?.status).toBe('current');
  });
  it('never merges a near-duplicate across visibilities', async () => {
    const fleet = await svc.record('wsA', { ...base, text: 'snapshot copies history' });
    const priv = await svc.record('wsA', { ...base, text: 'snapshot copies everything', visibility: 'private' });
    expect(priv.deduped).toBe(false);
    expect(priv.id).not.toBe(fleet.id);
    const hit = (await svc.search('wsA', { query: 'snapshot' })).results.find((h) => h.id === fleet.id);
    expect(hit?.sources).toHaveLength(1);
    expect(hit?.confirmations).toBe(1);
    // Same visibility still merges.
    expect(await svc.record('wsA', { ...base, text: 'snapshot copies all', visibility: 'private' })).toMatchObject({ id: priv.id, deduped: true });
  });
  it('refuses to supersede another workspace\'s private claim', async () => {
    const a = await svc.record('wsB', { ...base, text: 'private thing', visibility: 'private' });
    await expect(svc.record('wsA', { ...base, text: 'other thing', supersedes: a.id })).rejects.toThrow(/supersedes/);
  });
  it('stamps capture provenance only for a running run in the caller workspace', async () => {
    const run = await runs.start({ workspaceId: 'wsA', sessionId: 'live-1', forkSessionId: 'f1', trigger: 'ctx-60', now: 1 });
    const r = await svc.record('wsA', { ...base, text: 'captured fact', capture_run: run });
    const hit = (await svc.search('wsA', { query: 'captured' })).results.find((h) => h.id === r.id);
    expect(hit?.sources[0]).toMatchObject({ via: 'capture', sessionId: 'live-1' });
    expect((await runs.lastFor('live-1'))?.claims_recorded).toBe(1);
    await expect(svc.record('wsB', { ...base, text: 'forged', capture_run: run })).rejects.toThrow(/capture_run/);
  });
  it('forces private visibility on a capture run admitted under captureVisibility=private', async () => {
    const run = await runs.start({ workspaceId: 'wsA', sessionId: 'live-1', forkSessionId: 'f1', trigger: 'ctx-85', visibility: 'private', now: 1 });
    const r = await svc.record('wsA', { ...base, text: 'captured private fact', visibility: 'fleet', capture_run: run });
    expect((await svc.search('wsA', { query: 'captured' })).results.find((h) => h.id === r.id)?.visibility).toBe('private');
    expect((await svc.search('wsB', { query: 'captured' })).results).toEqual([]);
  });
  it('leaves visibility alone for a fleet capture run and for agent records', async () => {
    const run = await runs.start({ workspaceId: 'wsA', sessionId: 'live-1', forkSessionId: 'f1', trigger: 'ctx-85', visibility: 'fleet', now: 1 });
    const r = await svc.record('wsA', { ...base, text: 'captured fleet fact', capture_run: run });
    expect((await svc.search('wsB', { query: 'captured' })).results.map((h) => h.id)).toEqual([r.id]);
  });
  it('still records (FTS-only) when the embedder throws, and backfills later', async () => {
    const failing = new ClaimService({ claims: new ClaimStore(inbox.kysely, inbox.dialect), runs, embed: async () => { throw new Error('model down'); },
      workspaceName: async () => null, now: () => ++t });
    const r = await failing.record('wsA', { ...base, text: 'offline claim' });
    expect((await failing.search('wsA', { query: 'offline' })).results.map((h) => h.id)).toEqual([r.id]);
    expect(await svc.backfillVectors()).toBe(1);
  });
});

describe('ClaimService.search / retract', () => {
  it('fuses keyword and vector hits and includes provenance', async () => {
    const a = await svc.record('wsA', { ...base, text: 'buildSnapshot is O(history) #476', refs: ['#476'] });
    const res = await svc.search('wsB', { query: '#476' });
    expect(res.results[0]).toMatchObject({ id: a.id, workspaceId: 'wsA', workspaceName: 'name-wsA', status: 'current' });
    expect(res.results[0].sources[0]).toMatchObject({ via: 'agent', sessionId: null });
  });
  it('filters by kind and topics', async () => {
    await svc.record('wsA', { ...base, text: 'alpha one', topics: ['perf'] });
    await svc.record('wsA', { ...base, kind: 'gotcha', text: 'beta two', topics: ['perf'] });
    expect((await svc.search('wsA', { query: 'alpha beta', kind: 'gotcha' })).results.map((h) => h.text)).toEqual(['beta two']);
    expect((await svc.search('wsA', { query: 'alpha beta', topics: ['nope'] })).results).toEqual([]);
  });
  it('only the authoring workspace may retract', async () => {
    const a = await svc.record('wsA', { ...base, text: 'wrong claim' });
    await expect(svc.retract('wsB', { id: a.id, reason: 'x' })).rejects.toThrow(/authoring workspace/);
    expect(await svc.retract('wsA', { id: a.id, reason: 'was wrong' })).toEqual({ id: a.id, status: 'retracted' });
    expect((await svc.search('wsA', { query: 'wrong' })).results).toEqual([]);
  });
  it('requires a query', async () => {
    await expect(svc.search('wsA', {})).rejects.toThrow(/query/);
  });
});
