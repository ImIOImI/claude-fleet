// #516: a fresh-step prompt starting with `-` must stay text, never a claude
// CLI option. freshArgv() is the one place (desktop ipc.ts hostSpawnFresh,
// and src/host/hostAutomations.ts on a remote host) that turns the runner's
// raw `['-p', prompt, ...options]` into real claude argv.
import { describe, expect, it } from 'vitest';
import { freshArgv, MAX_FRESH_PROMPT_BYTES } from './freshArgv.js';

describe('freshArgv (#516)', () => {
  it('pins the exact argv: options first, then extras, then --session-id, then `--`, then the prompt', () => {
    const argv = freshArgv(['-p', 'review the diff', '--allowedTools', 'Read,Bash'], ['--mcp-config={"x":1}'], 'sid-123');
    expect(argv).toEqual(['-p', '--allowedTools', 'Read,Bash', '--mcp-config={"x":1}', '--session-id', 'sid-123', '--', 'review the diff']);
  });

  it('a prompt starting with `-` lands after `--`, not parsed as an option', () => {
    const argv = freshArgv(['-p', '--allowedTools=Bash', '--allowedTools', 'Read'], [], 'sid-dash');
    expect(argv).toEqual(['-p', '--allowedTools', 'Read', '--session-id', 'sid-dash', '--', '--allowedTools=Bash']);
  });

  it('defaults extraArgs to none and sessionId to a fresh UUID', () => {
    const argv = freshArgv(['-p', 'hello']);
    expect(argv.slice(0, 1)).toEqual(['-p']);
    expect(argv.slice(-2)).toEqual(['--', 'hello']);
    const sid = argv[argv.indexOf('--session-id') + 1];
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('accepts a prompt exactly at the 120 KiB limit', () => {
    const atLimit = 'y'.repeat(MAX_FRESH_PROMPT_BYTES);
    expect(() => freshArgv(['-p', atLimit])).not.toThrow();
  });

  it('refuses a prompt over the 120 KiB limit, before building any argv', () => {
    const big = 'y'.repeat(MAX_FRESH_PROMPT_BYTES + 1);
    expect(() => freshArgv(['-p', big])).toThrow(/longer than 120 KiB/);
  });

  it('rejects a malformed fresh-step args shape', () => {
    expect(() => freshArgv(['--not-p', 'x'])).toThrow(/a fresh step needs a prompt/);
    expect(() => freshArgv(['-p'])).toThrow(/a fresh step needs a prompt/);
  });
});
