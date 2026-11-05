import { describe, expect, it } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { onCaptureSettingsChanged, type CaptureSettingsChanged } from './captureSettingsEvents.js';
import { createCaptureSettingsService, type CaptureSettingsDeps } from './captureSettingsService.js';

const WS = 'W1';
const D = defaultCaptureSettings();

function setup(o: { trusted?: boolean; knowledgeCapture?: unknown } = {}) {
  let manifest = { id: WS, name: 'ops', kind: 'container', knowledgeCapture: o.knowledgeCapture } as unknown as WorkspaceSpec;
  const logRows: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
  const proposals: Array<Record<string, unknown>> = [];
  let invalidateCalls = 0;
  const deps: CaptureSettingsDeps = {
    readManifest: async (id) => (id === WS ? manifest : null),
    writeManifest: async (spec) => { manifest = spec; },
    trusted: async () => o.trusted === true,
    log: { append: async (r) => { logRows.push(r as unknown as Record<string, unknown>); return `L${logRows.length}`; } },
    propose: async (callerId, change, reason) => { proposals.push({ callerId, change, reason }); return { id: 'P1' }; },
    notify: (n) => { notes.push(n as unknown as Record<string, unknown>); },
    globalEnabled: async () => true,
    dailyCap: async () => 40,
    capturesToday: async () => 7,
    workspaceName: async () => 'ops',
    now: () => 1000,
    invalidateWorkspaceList: () => { invalidateCalls++; }
  };
  return { svc: createCaptureSettingsService(deps), manifest: () => manifest, logRows, notes, proposals, invalidateCalls: () => invalidateCalls };
}

describe('capture settings service (#483 §5a)', () => {
  it('get returns the effective settings, the defaults and the global numbers', async () => {
    const t = setup({ knowledgeCapture: { searchTopSessions: 2 } });
    expect(await t.svc.get(WS)).toEqual({
      settings: { ...D, searchTopSessions: 2 }, defaults: D, global: { enabled: true, dailyCap: 40, capturesToday: 7 }
    });
  });
  it('a cost-reducing change applies now, is logged, notifies at low priority and emits a change event', async () => {
    const t = setup();
    const events: CaptureSettingsChanged[] = [];
    const off = onCaptureSettingsChanged((e) => events.push(e));
    const r = await t.svc.set(WS, { searchTopSessions: 1, reason: 'too costly' });
    off();
    expect(r).toMatchObject({ status: 'applied', needsApproval: false, changes: ['searchTopSessions: 3 → 1'] });
    expect(t.manifest().knowledgeCapture).toEqual({ ...D, searchTopSessions: 1 });
    expect(t.logRows[0]).toMatchObject({ workspaceId: WS, actor: 'workspace', applied: true, proposalId: null, reason: 'too costly' });
    expect(t.notes[0]).toMatchObject({ kind: 'capture-settings', priority: 'low', workspaceId: WS, title: 'ops changed its knowledge-capture settings: searchTopSessions: 3 → 1' });
    expect(events[0]).toMatchObject({ workspaceId: WS, actor: 'workspace', source: 'mcp' });
  });
  it('a cost-increasing change from an untrusted workspace becomes a proposal and changes nothing', async () => {
    const t = setup();
    const r = await t.svc.set(WS, { turnsEvery: 30, reason: 'long sessions' });
    expect(r).toMatchObject({ status: 'proposed', proposalId: 'P1', reasons: ['turns periodic capture on (every 30 turns)'] });
    expect(t.manifest().knowledgeCapture).toBeUndefined();
    expect(t.proposals[0]).toMatchObject({ callerId: WS, reason: 'long sessions', change: { workspaceId: WS, changes: ['turnsEvery: off → 30'] } });
    expect(t.logRows[0]).toMatchObject({ applied: false, proposalId: 'P1' });
    expect(t.notes).toHaveLength(0);
  });
  it('a trusted workspace applies a cost increase immediately', async () => {
    const t = setup({ trusted: true });
    expect(await t.svc.set(WS, { turnsEvery: 30, reason: 'r' })).toMatchObject({ status: 'applied', needsApproval: true });
    expect(t.manifest().knowledgeCapture).toEqual({ ...D, turnsEvery: 30 });
  });
  it('publishing private captures to the fleet or shortening retention needs approval like a cost increase', async () => {
    const t = setup({ knowledgeCapture: { captureVisibility: 'private' } });
    expect(await t.svc.set(WS, { captureVisibility: 'fleet', reason: 'share' })).toMatchObject({
      status: 'proposed', reasons: ['publishes captured claims to the whole fleet (captureVisibility private → fleet)']
    });
    expect(await t.svc.set(WS, { transcriptRetentionDays: 30, reason: 'disk' })).toMatchObject({
      status: 'proposed', reasons: ['deletes transcripts sooner (transcriptRetentionDays 365 → 30)']
    });
    expect(t.manifest().knowledgeCapture).toEqual({ captureVisibility: 'private' });
    const trusted = setup({ trusted: true, knowledgeCapture: { captureVisibility: 'private' } });
    expect(await trusted.svc.set(WS, { captureVisibility: 'fleet', transcriptRetentionDays: 30, reason: 'r' }))
      .toMatchObject({ status: 'applied', needsApproval: true });
    expect(trusted.manifest().knowledgeCapture).toEqual({ ...D, transcriptRetentionDays: 30 });
  });
  it('clamps values, reports no-ops, and rejects bad input or an unknown workspace', async () => {
    const t = setup();
    expect(await t.svc.set(WS, { recaptureAfterTurns: 9999, reason: 'r' })).toMatchObject({ status: 'applied', settings: { recaptureAfterTurns: 500 } });
    expect(await t.svc.set(WS, { recaptureAfterTurns: 500, reason: 'r' })).toMatchObject({ status: 'unchanged' });
    await expect(t.svc.set(WS, { foo: 1, reason: 'r' })).rejects.toThrow(/unknown capture setting/);
    await expect(t.svc.set(WS, { enabled: false })).rejects.toThrow(/reason is required/);
    await expect(t.svc.set('nope', { enabled: false, reason: 'r' })).rejects.toThrow(/workspace not found/);
  });
  it('writes the defaults back as absent', async () => {
    const t = setup({ knowledgeCapture: { searchTopSessions: 5 } });
    expect(await t.svc.set(WS, { searchTopSessions: 3, reason: 'back to default' })).toMatchObject({ status: 'applied' });
    expect(t.manifest().knowledgeCapture).toBeUndefined();
  });
  it('applyApproved applies only the proposed fields over the current settings', async () => {
    const t = setup({ knowledgeCapture: { transcriptRetentionDays: 90 } });
    await t.svc.applyApproved(WS, { workspaceId: WS, before: D, after: { ...D, turnsEvery: 30 }, changes: [], reasons: [] }, 'P9');
    expect(t.manifest().knowledgeCapture).toEqual({ ...D, transcriptRetentionDays: 90, turnsEvery: 30 });
    expect(t.logRows[0]).toMatchObject({ actor: 'user', applied: true, proposalId: 'P9', reason: 'approved proposal' });
  });
  it('invalidates the cached workspace list on every applied write, but not on an unchanged set or a proposed one', async () => {
    const t = setup();
    expect(await t.svc.set(WS, { searchTopSessions: 1, reason: 'applied' })).toMatchObject({ status: 'applied' });
    expect(t.invalidateCalls()).toBe(1);
    expect(await t.svc.set(WS, { searchTopSessions: 1, reason: 'again' })).toMatchObject({ status: 'unchanged' });
    expect(t.invalidateCalls()).toBe(1);
    expect(await t.svc.set(WS, { turnsEvery: 30, reason: 'long sessions' })).toMatchObject({ status: 'proposed' });
    expect(t.invalidateCalls()).toBe(1);
    await t.svc.applyApproved(WS, { workspaceId: WS, before: D, after: { ...D, turnsEvery: 30 }, changes: [], reasons: [] }, 'P9');
    expect(t.invalidateCalls()).toBe(2);
  });
});
