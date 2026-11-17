import { describe, expect, it } from 'vitest';
import { BUILTIN_GITHUB_CLIENT_ID, CLIENT_ID_MISSING, GITHUB_CLIENT_ID_ENV, pickGithubClientId } from './clientId.js';

describe('pickGithubClientId', () => {
  it('prefers env, then config, then the built-in', () => {
    expect(pickGithubClientId({ env: 'Iv1.fromenv1', config: 'Iv1.fromcfg1', builtin: 'Iv1.builtin1' })).toBe('Iv1.fromenv1');
    expect(pickGithubClientId({ env: '', config: 'Iv1.fromcfg1', builtin: 'Iv1.builtin1' })).toBe('Iv1.fromcfg1');
    expect(pickGithubClientId({ env: null, config: null, builtin: 'Iv1.builtin1' })).toBe('Iv1.builtin1');
  });

  it('trims and skips malformed values', () => {
    expect(pickGithubClientId({ env: '  Iv1.fromenv1 ', builtin: '' })).toBe('Iv1.fromenv1');
    expect(pickGithubClientId({ env: 'has space here', config: 'Iv1.fromcfg1', builtin: '' })).toBe('Iv1.fromcfg1');
  });

  it('is null when nothing is configured', () => {
    expect(pickGithubClientId({ env: undefined, config: null, builtin: '' })).toBeNull();
  });

  it('ships no real client id, and the error points at Settings, not env vars or config.json', () => {
    expect(BUILTIN_GITHUB_CLIENT_ID).toBe('');
    expect(GITHUB_CLIENT_ID_ENV).toBe('CLAUDE_FLEET_GITHUB_CLIENT_ID');
    expect(CLIENT_ID_MISSING).toBe(
      "GitHub sign-in isn't configured. Enter your organization's GitHub OAuth client ID in Settings → Account."
    );
  });
});
