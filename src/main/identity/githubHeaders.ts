// Pure parsers for the GitHub response headers identity depends on. Kept apart
// from githubProvider.ts so they unit-test without a fetch stub.

export const GITHUB_API = 'https://api.github.com';

/** What an X-GitHub-SSO header told us (SAML SSO orgs, remote-workspaces §5). */
export interface SsoHint {
  /** `required; url=…`: the org-specific authorise URL (https://github.com only). */
  url: string | null;
  /** Org login parsed from that URL's `/orgs/<org>/sso` path. */
  org: string | null;
  /** `partial-results; organizations=…`: ids of orgs that withheld results. */
  orgIds: number[];
}

export function parseScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Can this token pull from GHCR? write:packages includes read:packages. */
export function hasPackagesRead(scopes: readonly string[]): boolean {
  return scopes.some((s) => s === 'read:packages' || s === 'write:packages');
}

function githubUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u : null;
  } catch {
    return null;
  }
}

/** `/orgs/<org>/sso` → the URL-decoded org login, or null if it isn't one. */
function ssoOrg(u: URL): string | null {
  const raw = /^\/orgs\/([^/]+)\/sso/.exec(u.pathname)?.[1];
  if (!raw) return null;
  let org: string;
  try {
    org = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9-]+$/.test(org) ? org : null;
}

export function parseSsoHeader(header: string | null): SsoHint | null {
  if (!header) return null;
  const rawUrl = /(?:^|;)\s*url=([^;\s]+)/.exec(header)?.[1] ?? null;
  const rawIds = /(?:^|;)\s*organizations=([\d,\s]+)/.exec(header)?.[1];
  const orgIds = rawIds
    ? rawIds
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const u = rawUrl ? githubUrl(rawUrl) : null;
  if (!u && orgIds.length === 0) return null;
  return {
    url: u ? u.toString() : null,
    org: u ? ssoOrg(u) : null,
    orgIds
  };
}

export function mergeSso(a: SsoHint | null, b: SsoHint | null): SsoHint | null {
  if (!a) return b;
  if (!b) return a;
  return {
    url: a.url ?? b.url,
    org: a.org ?? b.org,
    orgIds: [...new Set([...a.orgIds, ...b.orgIds])].sort((x, y) => x - y)
  };
}

/** The rel="next" URL of a Link header, but only on api.github.com (the token
 *  rides along, so a foreign next link is never followed). */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1].startsWith(`${GITHUB_API}/`) ? m[1] : null;
  }
  return null;
}

/** Whether the Link header has any rel="next", followable or not. */
export function hasNextRel(header: string | null): boolean {
  return !!header && header.split(',').some((part) => /<[^>]+>\s*;\s*rel="next"/.test(part));
}
