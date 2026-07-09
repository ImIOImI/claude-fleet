// Args for the broker CREATE that launches claude in-container. Always loads the
// input-wait hook via --settings (trusted; bypasses the /hooks approval gate),
// then resumes a prior session when resumeOf is set, or pins a host-assigned
// session id on fresh starts (#195): with --session-id the broker->claude
// mapping is known before claude even starts, instead of guessed FIFO-style
// from JSONL appearance order — the guess is what cross-wired tabs.
export const RUNNER_HOOK_SETTINGS = '/usr/local/lib/claude-fleet/hooks.settings.json';

export function claudeCreateArgs(resumeOf?: string, sessionId?: string): string[] {
  const args = ['--settings', RUNNER_HOOK_SETTINGS];
  if (resumeOf) args.push('--resume', resumeOf);
  else if (sessionId) args.push('--session-id', sessionId);
  return args;
}
