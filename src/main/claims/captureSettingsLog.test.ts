import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { CaptureSettingsLogStore } from './captureSettingsLog.js';

let inbox: InboxStore; let log: CaptureSettingsLogStore;
beforeEach(() => { inbox = InboxStore.memory(); log = new CaptureSettingsLogStore(inbox.kysely); });
afterEach(() => inbox.close());

describe('CaptureSettingsLogStore', () => {
  it('appends and lists newest first per workspace', async () => {
    const d = defaultCaptureSettings();
    await log.append({ workspaceId: 'wsA', actor: 'workspace', before: d, after: { ...d, searchTopSessions: 2 }, reason: 'too many', applied: true, proposalId: null, now: 1 });
    await log.append({ workspaceId: 'wsA', actor: 'workspace', before: d, after: { ...d, turnsEvery: 30 }, reason: 'more', applied: false, proposalId: 'P1', now: 2 });
    await log.append({ workspaceId: 'wsB', actor: 'user', before: d, after: { ...d, enabled: false }, reason: null, applied: true, proposalId: null, now: 3 });
    const rows = await log.listFor('wsA');
    expect(rows.map((r) => [r.ts, r.applied, r.proposalId])).toEqual([[2, false, 'P1'], [1, true, null]]);
    expect(rows[1].after.searchTopSessions).toBe(2);
    expect((await log.listFor('wsB'))[0]).toMatchObject({ actor: 'user', reason: null, applied: true });
  });
});
