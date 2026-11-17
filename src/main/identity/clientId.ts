// The claude-fleet OAuth app's client id. Public: the device flow needs no
// client secret. First valid wins: env, then config.json, then the built-in.

import { GITHUB_CLIENT_ID_ENV, resolveGithubClientId } from '../../preload/githubClientId.js';

export { GITHUB_CLIENT_ID_ENV };

/** OWNER ACTION: paste the OAuth app's client id (Device Flow enabled) here.
 *  Empty ⇒ sign-in reports "not configured" unless env/config supply one. */
export const BUILTIN_GITHUB_CLIENT_ID = '';

export const CLIENT_ID_MISSING = "GitHub sign-in isn't configured. Enter your organization's GitHub OAuth client ID in Settings → Account.";

export function pickGithubClientId(o: { env?: string | null; config?: string | null; builtin?: string }): string | null {
  return resolveGithubClientId({ env: o.env, config: o.config, builtin: o.builtin ?? BUILTIN_GITHUB_CLIENT_ID }).value;
}
