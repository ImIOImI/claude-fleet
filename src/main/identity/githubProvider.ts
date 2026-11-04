// The `github` IdentityProvider (remote-workspaces §5). Pure — global fetch
// only — so fleet-host reuses it. Two entry points:
//  - probe(token): desktop sign-in. User tokens only: identity + granted
//    scopes (X-OAuth-Scopes) + any SAML SSO hint (X-GitHub-SSO).
//  - verify(token): the host's per-request check. A user, or a GitHub App
//    installation token mapped to a configured machine rule.
// Every request goes to api.github.com; error messages never carry the token.

import type { Identity, IdentityProvider, UserIdentity } from './types.js';
import { IdentityError } from './types.js';
import { GITHUB_SHARED_APPS, type MachineRule } from './grants.js';
import { GITHUB_API, hasNextRel, mergeSso, nextLink, parseScopes, parseSsoHeader, type SsoHint } from './githubHeaders.js';

export interface GithubProbe {
  /** probe() only ever signs in a person. */
  identity: UserIdentity;
  scopes: string[];
  sso: SsoHint | null;
}

export interface GithubProvider extends IdentityProvider {
  probe(token: string): Promise<GithubProbe>;
}

const MAX_TEAM_PAGES = 10;
const MAX_REPO_PAGES = 10;
/** Classic OAuth scopes that let GET /user/teams answer. */
const ORG_READ_SCOPES = ['read:org', 'write:org', 'admin:org'];
const INTEGRATION_MSG = 'Resource not accessible by integration';
const VIEWER_QUERY = 'query { viewer { __typename login ... on Bot { databaseId } } }';

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'claude-fleet'
  };
}

async function ghFetch(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  try {
    // redirect: 'error' — a redirect would carry the bearer token to a URL we
    // didn't vet; GitHub's REST API never needs one for these endpoints.
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new IdentityError('network', `GitHub unreachable (${(err as Error).name})`);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function message(body: unknown): string {
  return body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : '';
}

interface GhUser {
  login: string;
  id: number;
  name?: unknown;
  avatar_url?: unknown;
}
function isGhUser(v: unknown): v is GhUser {
  return !!v && typeof v === 'object' && typeof (v as GhUser).login === 'string' && typeof (v as GhUser).id === 'number';
}

function rateLimited(res: Response, msg: string): boolean {
  return (
    res.status === 429 ||
    res.headers.get('retry-after') !== null ||
    res.headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(msg)
  );
}

/**
 * The user's teams. Only two failures are an acceptable *partial* result
 * (cached by verifyCache like any success): a 403 carrying an X-GitHub-SSO
 * hint (SAML org not yet authorised for this token), or a 403 for a token
 * whose granted scopes lack read:org. Anything transient or unexplained —
 * 5xx, 429, a (secondary) rate limit, any other status, a non-array page,
 * or more pages than MAX_TEAM_PAGES — throws `upstream`, which is never
 * cached, so a blip can't pin someone at reduced access for the TTL.
 */
async function fetchTeams(token: string): Promise<{ teams: string[]; sso: SsoHint | null }> {
  const teams = new Set<string>();
  let sso: SsoHint | null = null;
  let url: string | null = `${GITHUB_API}/user/teams?per_page=100`;
  for (let page = 0; url && page < MAX_TEAM_PAGES; page++) {
    const res = await ghFetch(url, { headers: headers(token) });
    const pageSso = parseSsoHeader(res.headers.get('x-github-sso'));
    sso = mergeSso(sso, pageSso);
    if (!res.ok) {
      const msg = res.status === 403 ? message(await readJson(res)) : '';
      if (res.status === 403 && !rateLimited(res, msg)) {
        if (pageSso) return { teams: [...teams].sort(), sso };
        const granted = res.headers.get('x-oauth-scopes');
        if (granted !== null && !parseScopes(granted).some((sc) => ORG_READ_SCOPES.includes(sc))) {
          return { teams: [...teams].sort(), sso };
        }
      }
      throw new IdentityError('upstream', `GitHub GET /user/teams answered HTTP ${res.status}`, res.status);
    }
    const body = await readJson(res);
    if (!Array.isArray(body)) throw new IdentityError('upstream', 'GitHub GET /user/teams returned an unexpected body');
    for (const t of body as Array<{ slug?: unknown; organization?: { login?: unknown } } | null>) {
      const slug = t?.slug;
      const org = t?.organization?.login;
      if (typeof slug === 'string' && typeof org === 'string') teams.add(`${org}/${slug}`.toLowerCase());
    }
    url = nextLink(res.headers.get('link'));
  }
  if (url) throw new IdentityError('upstream', `GitHub GET /user/teams has more than ${MAX_TEAM_PAGES} pages`);
  return { teams: [...teams].sort(), sso };
}

/**
 * A machine tier applies only to installations whose every repository (≥1) is
 * owned by the rule's org. This does not make GitHub-operated shared Apps safe;
 * parseGrantConfig rejects those. Fails closed (`forbidden`).
 */
async function assertInstallationInOrg(token: string, org: string, slug: string): Promise<void> {
  const want = org.toLowerCase();
  const refuse = (why: string): IdentityError =>
    new IdentityError('forbidden', `GitHub App ${slug} installation is not limited to org ${org}: ${why}`, 403);
  let count = 0;
  let url: string | null = `${GITHUB_API}/installation/repositories?per_page=100`;
  for (let page = 0; url && page < MAX_REPO_PAGES; page++) {
    const res = await ghFetch(url, { headers: headers(token) });
    if (res.status === 401) throw new IdentityError('unauthorized', 'GitHub rejected the token', 401);
    if (!res.ok) throw new IdentityError('upstream', `GitHub GET /installation/repositories answered HTTP ${res.status}`, res.status);
    const body = (await readJson(res)) as { repositories?: unknown } | null;
    const list = body?.repositories;
    if (!Array.isArray(list)) throw new IdentityError('upstream', 'GitHub GET /installation/repositories returned an unexpected body');
    for (const r of list as Array<{ owner?: { login?: unknown } } | null>) {
      const owner = r?.owner?.login;
      if (typeof owner !== 'string') throw refuse('a repository has no owner login');
      if (owner.toLowerCase() !== want) throw refuse('it reaches a repository outside the org');
      count++;
    }
    const link = res.headers.get('link');
    url = nextLink(link);
    if (!url && hasNextRel(link)) throw refuse('a pagination link leaves api.github.com');
  }
  if (url) throw refuse(`more than ${MAX_REPO_PAGES} pages of repositories`);
  if (count === 0) throw refuse('it reaches no repositories');
}

type UserResult = { kind: 'user'; probe: GithubProbe } | { kind: 'integration' };

async function fetchUser(token: string): Promise<UserResult> {
  const res = await ghFetch(`${GITHUB_API}/user`, { headers: headers(token) });
  if (res.status === 401) throw new IdentityError('unauthorized', 'GitHub rejected the token', 401);
  if (res.status === 403) {
    const msg = message(await readJson(res));
    if (msg.includes(INTEGRATION_MSG)) return { kind: 'integration' };
    throw new IdentityError('upstream', `GitHub GET /user answered 403${msg ? `: ${msg}` : ''}`, 403);
  }
  if (!res.ok) throw new IdentityError('upstream', `GitHub GET /user answered HTTP ${res.status}`, res.status);
  const u = await readJson(res);
  if (!isGhUser(u)) throw new IdentityError('upstream', 'GitHub GET /user returned an unexpected body');
  const scopes = parseScopes(res.headers.get('x-oauth-scopes'));
  const userSso = parseSsoHeader(res.headers.get('x-github-sso'));
  const { teams, sso } = await fetchTeams(token);
  const name = typeof u.name === 'string' && u.name.trim() ? u.name : null;
  return {
    kind: 'user',
    probe: {
      identity: {
        provider: 'github',
        kind: 'user',
        login: u.login,
        id: u.id,
        name,
        avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : null,
        teams
      },
      scopes,
      sso: mergeSso(userSso, sso)
    }
  };
}

async function verifyMachine(token: string, machines: readonly MachineRule[]): Promise<Identity> {
  const res = await ghFetch(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: VIEWER_QUERY })
  });
  if (res.status === 401) throw new IdentityError('unauthorized', 'GitHub rejected the token', 401);
  if (!res.ok) throw new IdentityError('upstream', `GitHub GraphQL answered HTTP ${res.status}`, res.status);
  const body = (await readJson(res)) as { data?: { viewer?: { __typename?: unknown; login?: unknown; databaseId?: unknown } } } | null;
  const v = body?.data?.viewer;
  if (!v || v.__typename !== 'Bot' || typeof v.login !== 'string' || typeof v.databaseId !== 'number') {
    throw new IdentityError('upstream', 'GitHub GraphQL viewer is not a bot');
  }
  const slug = v.login.replace(/\[bot\]$/, '');
  if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new IdentityError('upstream', 'GitHub returned an unexpected bot login');
  const appRes = await ghFetch(`${GITHUB_API}/apps/${slug}`, { headers: headers(token) });
  if (!appRes.ok) throw new IdentityError('upstream', `GitHub GET /apps/${slug} answered HTTP ${appRes.status}`, appRes.status);
  const app = (await readJson(appRes)) as { id?: unknown } | null;
  const rawId = app ? app.id : undefined;
  const appId = typeof rawId === 'number' ? rawId : null;
  if (appId === null) throw new IdentityError('upstream', `GitHub GET /apps/${slug} returned an unexpected body`);
  const shared = GITHUB_SHARED_APPS.get(appId);
  if (shared) throw new IdentityError('forbidden', `GitHub App ${slug} (id ${appId}) is GitHub's shared ${shared} App, not a dedicated org-owned App`, 403);
  const rule = machines.find((m) => m.appId === appId);
  if (!rule) throw new IdentityError('machine-unknown', `GitHub App ${slug} (id ${appId}) is not a configured machine`);
  await assertInstallationInOrg(token, rule.org, slug);
  return { provider: 'github', kind: 'machine', appId, login: rule.login, id: v.databaseId, name: null, avatarUrl: null, teams: [] };
}

export function createGithubProvider(opts: { machines?: readonly MachineRule[] } = {}): GithubProvider {
  const machines = opts.machines ?? [];
  return {
    id: 'github',
    async probe(token) {
      const r = await fetchUser(token);
      if (r.kind === 'integration') {
        throw new IdentityError('unauthorized', 'A GitHub App installation token cannot sign in as a person', 403);
      }
      return r.probe;
    },
    async verify(token) {
      const r = await fetchUser(token);
      return r.kind === 'user' ? r.probe.identity : verifyMachine(token, machines);
    }
  };
}
