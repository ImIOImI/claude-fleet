import type { Harness } from './workspaces.js';
import { claudeCreateArgs } from './claudeArgs.js';

export function brokerBinaryFor(harness: Harness | undefined): string {
  return harness === 'qwen-code' ? 'qwen' : 'claude';
}

/**
 * Args appended to the harness binary in the PTY. claude-code keeps its
 * --settings hooks + --session-id/--resume contract. qwen-code takes no
 * --settings (fleet installs no qwen hooks in Phase 1) and only --resume on
 * resume; a fresh qwen session mints its own session id (the sidecar preserves
 * that UUID as the fleet JSONL filename — see Phase 2).
 */
export function harnessCreateArgs(harness: Harness | undefined, resumeOf?: string, sessionId?: string): string[] {
  if (harness === 'qwen-code') return resumeOf ? ['--resume', resumeOf] : [];
  return claudeCreateArgs(resumeOf, sessionId);
}
