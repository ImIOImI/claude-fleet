import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestLine, sessionCaptureSignals, isAutomationSession, recordBrokerSessionMapping } from './db.js';
import { openTestState, type TestState } from './store/testStore.js';

let t: TestState;
beforeEach(async () => { t = await openTestState('capsig-'); });
afterEach(async () => { await t.close(); });

const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 's1', timestamp: '2026-11-04T00:00:00Z', ...o });

describe('sessionCaptureSignals', () => {
  it('reads latest context usage, user turns and compactions', async () => {
    await ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }));
    await ingestLine('wsA', 's1', line({ type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 }, content: [] } }));
    await ingestLine('wsA', 's1', line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'again' } }));
    await ingestLine('wsA', 's1', line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }));
    expect(await sessionCaptureSignals('s1')).toEqual({ workspaceId: 'wsA', model: 'claude-opus-5-5', contextTokens: 1100, userTurns: 2, compactions: 1 });
  });
  it('returns null for an unknown session', async () => {
    expect(await sessionCaptureSignals('nope')).toBeNull();
  });
  it('isAutomationSession is false without an auto- broker mapping', async () => {
    expect(await isAutomationSession('s1')).toBe(false);
  });
  it('isAutomationSession is true for a session mapped from an auto- broker id', async () => {
    await ingestLine('wsA', 's2', JSON.stringify({ sessionId: 's2', timestamp: '2026-11-04T00:00:00Z', type: 'user', uuid: 'u9', message: { role: 'user', content: 'run' } }));
    await recordBrokerSessionMapping('wsA', 'auto-run1-step1', 's2');
    expect(await isAutomationSession('s2')).toBe(true);
    await recordBrokerSessionMapping('wsA', 'live-tab-1', 's1');
    expect(await isAutomationSession('s1')).toBe(false);
  });
});
