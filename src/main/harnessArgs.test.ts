import { describe, it, expect } from 'vitest';
import { harnessCreateArgs, brokerBinaryFor } from './harnessArgs.js';

describe('harnessCreateArgs', () => {
  it('claude-code keeps --settings + --session-id', () => {
    const a = harnessCreateArgs('claude-code', undefined, 'uuid-1');
    expect(a).toContain('--settings');
    expect(a).toEqual(expect.arrayContaining(['--session-id', 'uuid-1']));
  });
  it('claude-code uses --resume when resuming', () => {
    expect(harnessCreateArgs('claude-code', 'uuid-9')).toEqual(expect.arrayContaining(['--resume', 'uuid-9']));
  });
  it('qwen-code omits --settings and uses --resume on resume', () => {
    const a = harnessCreateArgs('qwen-code', 'uuid-2');
    expect(a).not.toContain('--settings');
    expect(a).toEqual(expect.arrayContaining(['--resume', 'uuid-2']));
  });
  it('qwen-code fresh session passes no id flag (qwen mints its own)', () => {
    expect(harnessCreateArgs('qwen-code')).toEqual([]);
  });
});

describe('brokerBinaryFor', () => {
  it('maps harness to binary', () => {
    expect(brokerBinaryFor('qwen-code')).toBe('qwen');
    expect(brokerBinaryFor('claude-code')).toBe('claude');
  });
});
