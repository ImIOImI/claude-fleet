// Per-session attribution (D112–D114): claude's `attribution` setting, passed inline with the
// runner hooks because `--settings` is single-valued. An invalid attribution value makes claude
// drop the whole settings source, hooks included, so only validated fields go in.
import { RUNNER_HOOK_SETTINGS, RUNNER_HOOKS } from '../main/claudeArgs.js';
import { OWNER_LOGIN_RE, type SessionOwner } from '../preload/sessionOwner.js';

/** The setting replaces Claude's own co-author line, so it is re-added. */
export const CLAUDE_COAUTHOR = 'Co-Authored-By: Claude <noreply@anthropic.com>';
export const MAX_COAUTHOR_NAME = 64;
const ACCOUNT_ID_RE = /^[1-9][0-9]{0,19}$/;
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const VISIBLE_RE = /[\p{L}\p{N}]/u;

/** Letters, marks, digits, space, `.` and `-` only: the name lands in a git command the model writes. */
export function coAuthorName(o: Pick<SessionOwner, 'name' | 'login'>): string {
  const s = (o.name ?? '')
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N} .-]/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  const n = Array.from(s).slice(0, MAX_COAUTHOR_NAME).join('').trim();
  return VISIBLE_RE.test(n) ? n : o.login;
}

export function attributionFor(o: SessionOwner): { commit: string; pr: string } | null {
  if (o.kind !== 'user' || o.provider !== 'github' || !ACCOUNT_ID_RE.test(o.id) || !OWNER_LOGIN_RE.test(o.login)) return null;
  return {
    commit: `${CLAUDE_COAUTHOR}\nCo-authored-by: ${coAuthorName(o)} <${o.id}+${o.login}@users.noreply.github.com>`,
    pr: `🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @${o.login}`
  };
}

/** The inline `--settings` value for a session `owner` starts; null keeps the hooks file. */
export function sessionSettings(owner: SessionOwner | null): string | null {
  const a = owner ? attributionFor(owner) : null;
  return a ? JSON.stringify({ hooks: RUNNER_HOOKS.hooks, attribution: { commit: a.commit, pr: a.pr } }) : null;
}

/** hostCreateArgs output with the hooks file swapped for the inline settings. */
export function withAttribution(args: readonly string[], owner: SessionOwner | null): string[] {
  const s = sessionSettings(owner);
  if (!s || args[0] !== '--settings' || args[1] !== RUNNER_HOOK_SETTINGS) return [...args];
  return ['--settings', s, ...args.slice(2)];
}
