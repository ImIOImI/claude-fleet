// Args for the broker CREATE that launches claude in-container. Always loads the
// input-wait hook via --settings (trusted; bypasses the /hooks approval gate),
// then resumes a prior session when resumeOf is set, or pins a host-assigned
// session id on fresh starts (#195): with --session-id the broker->claude
// mapping is known before claude even starts, instead of guessed FIFO-style
// from JSONL appearance order — the guess is what cross-wired tabs.
export const RUNNER_HOOK_SETTINGS = '/usr/local/lib/claude-fleet/hooks.settings.json';

/** The content of RUNNER_HOOK_SETTINGS, for fleet-host, which passes settings inline (D113). */
export const RUNNER_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }],
    PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }],
    SessionStart: [{
      hooks: [
        { type: 'command', command: '/usr/local/lib/claude-fleet/session-report.sh' },
        { type: 'command', command: '/usr/local/lib/claude-fleet/backfill-summaries.sh' }
      ]
    }],
    Stop: [{
      hooks: [
        { type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' },
        { type: 'command', command: '/usr/local/lib/claude-fleet/summarize.sh' }
      ]
    }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/local/lib/claude-fleet/input-wait-report.sh' }] }]
  }
} as const;

export function claudeCreateArgs(resumeOf?: string, sessionId?: string): string[] {
  const args = ['--settings', RUNNER_HOOK_SETTINGS];
  if (resumeOf) args.push('--resume', resumeOf);
  else if (sessionId) args.push('--session-id', sessionId);
  return args;
}
