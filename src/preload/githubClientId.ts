// GitHub OAuth client id rules, shared by main (resolver, config:setGithubClientId)
// and the renderer (Settings → Account inline check). Pure and import-free.

export const GITHUB_CLIENT_ID_ENV = 'CLAUDE_FLEET_GITHUB_CLIENT_ID';

export type GithubClientIdSource = 'env' | 'config' | 'builtin' | 'none';

export interface GithubClientIdSetting {
  value: string | null;
  source: GithubClientIdSource;
}

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidGithubClientId(v: unknown): v is string {
  return typeof v === 'string' && CLIENT_ID_RE.test(v);
}

/** First valid (trimmed) value wins: env, then config, then the built-in. */
export function resolveGithubClientId(o: { env?: string | null; config?: string | null; builtin: string }): GithubClientIdSetting {
  const candidates: Array<[string | null | undefined, GithubClientIdSource]> = [
    [o.env, 'env'],
    [o.config, 'config'],
    [o.builtin, 'builtin']
  ];
  for (const [v, source] of candidates) {
    const t = v?.trim();
    if (isValidGithubClientId(t)) return { value: t, source };
  }
  return { value: null, source: 'none' };
}
