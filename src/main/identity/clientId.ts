// The claude-fleet OAuth app's client id. Public: the device flow needs no
// client secret. First valid wins: env, then config.json, then the built-in.

/** OWNER ACTION: paste the OAuth app's client id (Device Flow enabled) here.
 *  Empty ⇒ sign-in reports "not configured" unless env/config supply one. */
export const BUILTIN_GITHUB_CLIENT_ID = '';

export const GITHUB_CLIENT_ID_ENV = 'CLAUDE_FLEET_GITHUB_CLIENT_ID';

export const CLIENT_ID_MISSING = `GitHub sign-in isn't configured: no OAuth client id. Set ${GITHUB_CLIENT_ID_ENV} or identity.github.clientId in config.json.`;

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function pickGithubClientId(o: { env?: string | null; config?: string | null; builtin?: string }): string | null {
  for (const v of [o.env, o.config, o.builtin ?? BUILTIN_GITHUB_CLIENT_ID]) {
    const t = v?.trim();
    if (t && CLIENT_ID_RE.test(t)) return t;
  }
  return null;
}
