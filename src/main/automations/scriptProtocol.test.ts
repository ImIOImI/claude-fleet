import { describe, it, expect } from 'vitest';
import { parseScriptOutput, scriptEnv, tail, MAX_EMITS_PER_STEP } from './scriptProtocol.js';

describe('parseScriptOutput', () => {
  it('splits todos, notifications and state from plain output', () => {
    const r = parseScriptOutput([
      'checking 3 rooms',
      '{"todo": {"title": "Reply to Ana", "key": "webex:1", "priority": "high"}}',
      '{"notify": {"title": "Webex token expires tomorrow"}}',
      '{"state": {"cursor": 42}}',
      '{"other": 1}',
      'done',
      ''
    ].join('\n'));
    expect(r.todos).toEqual([{ title: 'Reply to Ana', key: 'webex:1', priority: 'high' }]);
    expect(r.notifies).toEqual([{ title: 'Webex token expires tomorrow' }]);
    expect(r.state).toEqual({ cursor: 42 });
    expect(r.text).toBe('checking 3 rooms\n{"other": 1}\ndone');
    expect(r.warnings).toEqual([]);
  });
  it('keeps malformed JSON as text with a warning, caps emits, and leaves state undefined when unset', () => {
    const many = Array.from({ length: MAX_EMITS_PER_STEP + 3 }, (_, i) => `{"todo": {"title": "t${i}"}}`).join('\n');
    const r = parseScriptOutput(`{"todo": nope}\n{"todo": "x"}\n${many}`);
    expect(r.todos).toHaveLength(MAX_EMITS_PER_STEP);
    expect(r.state).toBeUndefined();
    expect(r.text).toBe('{"todo": nope}');
    expect(r.warnings).toEqual([expect.stringMatching(/^not JSON/), 'todo must be an object', `only ${MAX_EMITS_PER_STEP} todos/notifications per step; 3 dropped`]);
  });
});

describe('scriptEnv', () => {
  it('passes args as JSON and ARG_<NAME>, state and trigger as JSON, plus secrets', () => {
    expect(scriptEnv({
      runId: 'R1', automationName: 'webex', args: { room: 'ops', limit: 5 }, state: null,
      trigger: { kind: 'manual' }, secrets: { WEBEX_TOKEN: 's3cret' }
    })).toEqual({
      FLEET_RUN_ID: 'R1', FLEET_AUTOMATION: 'webex', FLEET_ARGS: '{"room":"ops","limit":5}', FLEET_STATE: '{}',
      FLEET_TRIGGER: '{"kind":"manual"}', ARG_ROOM: 'ops', ARG_LIMIT: '5', WEBEX_TOKEN: 's3cret'
    });
  });
  it('keeps the last {"next": …} request (#437)', () => {
    const r = parseScriptOutput('{"next": {"in": "1h"}}\n{"next": {"at": "2026-10-29T09:00:00Z"}}\nok');
    expect(r.next).toEqual({ at: '2026-10-29T09:00:00Z' });
    expect(r.text).toBe('ok');
    expect(parseScriptOutput('ok').next).toBeUndefined();
  });
  it('tail keeps the last lines', () => {
    expect(tail('a\nb\nc\nd\ne\nf\n', 2)).toBe('e\nf');
  });
});
