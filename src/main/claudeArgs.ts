// Args for the broker CREATE that launches claude in-container. Always loads the
// input-wait hook via --settings (trusted; bypasses the /hooks approval gate),
// then resumes a prior session when resumeOf is set.
export const RUNNER_HOOK_SETTINGS = '/usr/local/lib/claude-fleet/hooks.settings.json';

export function claudeCreateArgs(resumeOf?: string): string[] {
  const args = ['--settings', RUNNER_HOOK_SETTINGS];
  if (resumeOf) args.push('--resume', resumeOf);
  return args;
}
