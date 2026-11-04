import { describe, expect, it } from 'vitest';
import { CAPTURE_TOOLS, captureArgs, capturePrompt, parseCaptureOutput } from './captureCommand.js';

describe('captureArgs', () => {
  it('forks with a pre-assigned id, same model, restricted tools, turn cap, json output', () => {
    expect(captureArgs({ prompt: 'P', sessionId: 'live', forkSessionId: 'fork', model: 'claude-opus-5-5' })).toEqual([
      '-p', 'P', '--resume', 'live', '--fork-session', '--session-id', 'fork', '--model', 'claude-opus-5-5',
      '--allowedTools', CAPTURE_TOOLS, '--max-turns', '12', '--output-format', 'json'
    ]);
  });
  it('omits --model when unknown and adds --mcp-config when given', () => {
    const a = captureArgs({ prompt: 'P', sessionId: 'l', forkSessionId: 'f', model: null, mcpConfigPath: '/x/mcp.json' });
    expect(a).not.toContain('--model');
    expect(a.slice(-2)).toEqual(['--mcp-config', '/x/mcp.json']);
  });
});

describe('capturePrompt', () => {
  it('carries the run token, topics, and the rules', () => {
    const p = capturePrompt({ runToken: '01RUN', topTopics: ['mcp-query', 'perf'] });
    expect(p.startsWith('[fleet:knowledge-capture]')).toBe(true);
    expect(p).toContain('capture_run "01RUN"');
    expect(p).toContain('mcp-query, perf');
    expect(p).toMatch(/at most 10/);
    expect(p).toMatch(/secret/i);
  });
});

describe('parseCaptureOutput', () => {
  it('reads session id and usage from claude json output', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fork', total_cost_usd: 0.02, usage: { input_tokens: 5 } });
    expect(parseCaptureOutput(out)).toEqual({ ok: true, sessionId: 'fork', usage: { total_cost_usd: 0.02, usage: { input_tokens: 5 } }, error: null });
  });
  it('reports errors and garbage', () => {
    expect(parseCaptureOutput(JSON.stringify({ is_error: true, subtype: 'error_max_turns', session_id: 'f' })).ok).toBe(false);
    expect(parseCaptureOutput('not json')).toMatchObject({ ok: false, error: expect.stringMatching(/unparseable/) });
  });
});
