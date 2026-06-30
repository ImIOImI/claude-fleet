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
