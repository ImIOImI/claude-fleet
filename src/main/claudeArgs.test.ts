import { describe, it, expect } from 'vitest';
import { claudeCreateArgs } from './claudeArgs';

describe('claudeCreateArgs', () => {
  it('always loads the input-wait hook settings', () => {
    expect(claudeCreateArgs(undefined)).toEqual(['--settings', '/usr/local/lib/claude-fleet/hooks.settings.json']);
  });
  it('appends --resume after the settings flag', () => {
    expect(claudeCreateArgs('uuid-9')).toEqual(['--settings', '/usr/local/lib/claude-fleet/hooks.settings.json', '--resume', 'uuid-9']);
  });
});

describe('claudeCreateArgs session identity (#195)', () => {
  it('pins a host-assigned --session-id on fresh starts', () => {
    expect(claudeCreateArgs(undefined, 'uuid-5')).toEqual([
      '--settings', '/usr/local/lib/claude-fleet/hooks.settings.json',
      '--session-id', 'uuid-5'
    ]);
  });
  it('never mixes --session-id with --resume — a resume keeps the resumed id', () => {
    expect(claudeCreateArgs('uuid-9', 'uuid-5')).toEqual([
      '--settings', '/usr/local/lib/claude-fleet/hooks.settings.json',
      '--resume', 'uuid-9'
    ]);
  });
});
