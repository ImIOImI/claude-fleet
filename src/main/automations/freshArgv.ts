// Fresh-step claude argv (#516): shared by the desktop runner (src/main/ipc.ts
// hostSpawnFresh) and the remote host (src/host/hostAutomations.ts), which
// both call a fresh step's spawnFresh with the runner's raw
// `['-p', prompt, ...options]` (runner.ts).
import { randomUUID } from 'node:crypto';

/** Under Linux's 128 KiB per-argument limit (MAX_ARG_STRLEN); argv is passed to claude unchanged (no shell). */
export const MAX_FRESH_PROMPT_BYTES = 120 * 1024;

/** The runner's `['-p', prompt, ...options]` as safe claude argv: the prompt
 *  goes after `--`, so a leading `-` stays text, never an option. */
export function freshArgv(args: string[], extraArgs: string[] = [], sessionId: string = randomUUID()): string[] {
  const [flag, prompt, ...options] = args;
  if (flag !== '-p' || typeof prompt !== 'string') throw new Error('a fresh step needs a prompt');
  if (Buffer.byteLength(prompt) > MAX_FRESH_PROMPT_BYTES) throw new Error(`the prompt is longer than ${MAX_FRESH_PROMPT_BYTES / 1024} KiB`);
  return ['-p', ...options, ...extraArgs, '--session-id', sessionId, '--', prompt];
}
