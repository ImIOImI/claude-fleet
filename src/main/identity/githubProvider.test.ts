import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubProvider } from './githubProvider.js';
import { resolveTier } from './grants.js';
import { withVerifyCache } from './verifyCache.js';

type Init = { method?: string; headers?: Record<string, string>; body?: string };

/** Fake GitHub behind a fetch stub, keyed "METHOD url" (ociClient.test.ts pattern). */
function stubGithub(routes: Record<string, (init: Init) => Response>) {
  const f = vi.fn(async (url: string, init: Init = {}) => {
    const h = routes[`${init.method ?? 'GET'} ${String(url)}`];
    return h ? h(init) : new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const API = 'https://api.github.com';
const TOKEN = 'gho_secret_token';
const USER = { login: 'octo', id: 42, name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/42' };
const MACHINES = [{ appId: 123456, login: 'acme-reviewer[bot]', org: 'acme', tier: 'steer' as const }];
const repos = (...owners: string[]) => ({ total_count: owners.length, repositories: owners.map((o, i) => ({ name: `r${i}`, owner: { login: o } })) });
const INSTALL_REPOS = `${API}/installation/repositories?per_page=100`;

afterEach(() => vi.unstubAllGlobals());

describe('github provider: users', () => {
  it('returns the user, granted scopes and lower-cased teams across pages', async () => {
    const f = stubGithub({
      [`GET ${API}/user`]: () => json(USER, 200, { 'x-oauth-scopes': 'read:org, read:packages' }),
      [`GET ${API}/user/teams?per_page=100`]: () =>
        json([{ slug: 'Platform', organization: { login: 'Acme' } }], 200, {
          link: `<${API}/user/teams?per_page=100&page=2>; rel="next"`
        }),
      [`GET ${API}/user/teams?per_page=100&page=2`]: () => json([{ slug: 'eng', organization: { login: 'acme' } }])
    });
    const probe = await createGithubProvider().probe(TOKEN);
    expect(probe).toEqual({
      identity: {
        provider: 'github',
        kind: 'user',
        login: 'octo',
        id: 42,
        name: 'Octo Cat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
        teams: ['acme/eng', 'acme/platform']
      },
      scopes: ['read:org', 'read:packages'],
      sso: null
    });
    for (const [url, init] of f.mock.calls) {
      expect(String(url).startsWith(`${API}/`)).toBe(true);
      expect((init as Init).headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('verify returns the same identity', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json(USER),
      [`GET ${API}/user/teams?per_page=100`]: () => json([])
    });
    expect(await createGithubProvider().verify(TOKEN)).toMatchObject({ kind: 'user', login: 'octo', teams: [] });
  });

  it('maps a blank or missing name to null', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json({ ...USER, name: '  ', avatar_url: undefined }),
      [`GET ${API}/user/teams?per_page=100`]: () => json([])
    });
    const { identity } = await createGithubProvider().probe(TOKEN);
    expect(identity.name).toBeNull();
    expect(identity.avatarUrl).toBeNull();
  });

  it('reports a rejected token as unauthorized without echoing it', async () => {
    stubGithub({ [`GET ${API}/user`]: () => json({ message: 'Bad credentials' }, 401) });
    const err = await createGithubProvider().probe(TOKEN).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IdentityError', kind: 'unauthorized', status: 401 });
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('keeps going with partial teams and an SSO hint when /user/teams needs SSO', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json(USER, 200, { 'x-oauth-scopes': 'read:org, read:packages' }),
      [`GET ${API}/user/teams?per_page=100`]: () =>
        json({ message: 'Resource protected by organization SAML enforcement.' }, 403, {
          'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=XyZ'
        })
    });
    const probe = await createGithubProvider().probe(TOKEN);
    expect(probe.identity.teams).toEqual([]);
    expect(probe.sso).toEqual({ url: 'https://github.com/orgs/acme/sso?authorization_request=XyZ', org: 'acme', orgIds: [] });
  });

  it('surfaces partial-results SSO on a successful teams page', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json(USER),
      [`GET ${API}/user/teams?per_page=100`]: () =>
        json([{ slug: 'eng', organization: { login: 'acme' } }], 200, { 'x-github-sso': 'partial-results; organizations=7,9' })
    });
    const probe = await createGithubProvider().probe(TOKEN);
    expect(probe.identity.teams).toEqual(['acme/eng']);
    expect(probe.sso).toEqual({ url: null, org: null, orgIds: [7, 9] });
  });

  it('never follows a pagination link off api.github.com', async () => {
    const f = stubGithub({
      [`GET ${API}/user`]: () => json(USER),
      [`GET ${API}/user/teams?per_page=100`]: () =>
        json([{ slug: 'eng', organization: { login: 'acme' } }], 200, { link: '<https://evil.example/teams?page=2>; rel="next"' })
    });
    await createGithubProvider().probe(TOKEN);
    expect(f.mock.calls.some(([u]) => String(u).includes('evil.example'))).toBe(false);
  });

  it.each([
    ['a 502', () => json({ message: 'Bad gateway' }, 502)],
    ['a 429', () => json({ message: 'slow down' }, 429)],
    ['a 403 with no scopes header (cannot prove a missing scope)', () => json({ message: 'Forbidden' }, 403)],
    ['a secondary rate limit 403', () => json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '60', 'x-oauth-scopes': 'read:packages' })],
    ['a primary rate limit 403', () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-oauth-scopes': 'read:packages' })],
    ['an unexplained 403', () => json({ message: 'Forbidden' }, 403, { 'x-oauth-scopes': 'read:org' })],
    ['a non-array page', () => json({ not: 'a list' })]
  ])('throws upstream (never partial teams) on %s from /user/teams', async (_l, teamsRes) => {
    stubGithub({ [`GET ${API}/user`]: () => json(USER), [`GET ${API}/user/teams?per_page=100`]: teamsRes });
    await expect(createGithubProvider().verify(TOKEN)).rejects.toMatchObject({ name: 'IdentityError', kind: 'upstream' });
  });

  it('names an unexpected teams body as such', async () => {
    stubGithub({ [`GET ${API}/user`]: () => json(USER), [`GET ${API}/user/teams?per_page=100`]: () => json({ not: 'a list' }) });
    await expect(createGithubProvider().verify(TOKEN)).rejects.toThrow(/unexpected body/);
  });

  it('throws upstream when a later teams page fails', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json(USER),
      [`GET ${API}/user/teams?per_page=100`]: () =>
        json([{ slug: 'eng', organization: { login: 'acme' } }], 200, { link: `<${API}/user/teams?per_page=100&page=2>; rel="next"` }),
      [`GET ${API}/user/teams?per_page=100&page=2`]: () => json({ message: 'oops' }, 503)
    });
    await expect(createGithubProvider().verify(TOKEN)).rejects.toMatchObject({ kind: 'upstream', status: 503 });
  });

  it('throws upstream when teams hit the page cap', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url) === `${API}/user`) return json(USER);
        n++;
        return json([{ slug: `t${n}`, organization: { login: 'acme' } }], 200, { link: `<${API}/user/teams?per_page=100&page=${n + 1}>; rel="next"` });
      })
    );
    await expect(createGithubProvider().verify(TOKEN)).rejects.toMatchObject({ kind: 'upstream' });
    expect(n).toBeLessThanOrEqual(10);
  });

  it('accepts a 403 from /user/teams when the token lacks read:org', async () => {
    stubGithub({
      [`GET ${API}/user`]: () => json(USER, 200, { 'x-oauth-scopes': 'read:packages' }),
      [`GET ${API}/user/teams?per_page=100`]: () => json({ message: 'Forbidden' }, 403, { 'x-oauth-scopes': 'read:packages' })
    });
    expect((await createGithubProvider().probe(TOKEN)).identity.teams).toEqual([]);
  });

  it('a 502 from /user/teams is not cached as reduced access', async () => {
    let fail = true;
    const f = stubGithub({
      [`GET ${API}/user`]: () => json(USER),
      [`GET ${API}/user/teams?per_page=100`]: () => (fail ? json({ message: 'Bad gateway' }, 502) : json([{ slug: 'eng', organization: { login: 'acme' } }]))
    });
    const cached = withVerifyCache(createGithubProvider());
    await expect(cached.verify(TOKEN)).rejects.toMatchObject({ kind: 'upstream' });
    fail = false;
    expect((await cached.verify(TOKEN)).teams).toEqual(['acme/eng']);
    expect(f.mock.calls.filter(([u]) => String(u).startsWith(`${API}/user/teams`))).toHaveLength(2);
  });

  it('sends every request with redirect: error', async () => {
    const f = stubGithub({ [`GET ${API}/user`]: () => json(USER), [`GET ${API}/user/teams?per_page=100`]: () => json([]) });
    await createGithubProvider().verify(TOKEN);
    expect(f.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of f.mock.calls) expect((init as Init & { redirect?: string }).redirect).toBe('error');
  });

  it('maps a transport failure to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(createGithubProvider().probe(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps a request timeout to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    await expect(createGithubProvider().probe(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('github provider: machines (GitHub App installation tokens)', () => {
  const integration403 = () => json({ message: 'Resource not accessible by integration' }, 403);

  it('maps an installation token to the configured bot identity', async () => {
    const f = stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'acme-reviewer[bot]', databaseId: 9001 } } }),
      [`GET ${API}/apps/acme-reviewer`]: () => json({ id: 123456, slug: 'acme-reviewer' }),
      [`GET ${INSTALL_REPOS}`]: () => json(repos('acme', 'ACME'))
    });
    expect(await createGithubProvider({ machines: MACHINES }).verify(TOKEN)).toEqual({
      provider: 'github',
      kind: 'machine',
      appId: 123456,
      login: 'acme-reviewer[bot]',
      id: 9001,
      name: null,
      avatarUrl: null,
      teams: []
    });
    const gql = f.mock.calls.find(([u]) => String(u) === `${API}/graphql`);
    expect(JSON.parse((gql?.[1] as Init).body ?? '{}').query).toContain('viewer');
  });

  it('accepts a viewer login without the [bot] suffix', async () => {
    stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'acme-reviewer', databaseId: 9001 } } }),
      [`GET ${API}/apps/acme-reviewer`]: () => json({ id: 123456, slug: 'acme-reviewer' }),
      [`GET ${INSTALL_REPOS}`]: () => json(repos('acme'))
    });
    expect((await createGithubProvider({ machines: MACHINES }).verify(TOKEN)).login).toBe('acme-reviewer[bot]');
  });

  it('refuses a GitHub-operated shared App even if listed as a configured machine', async () => {
    stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'github-actions[bot]', databaseId: 1 } } }),
      [`GET ${API}/apps/github-actions`]: () => json({ id: 15368, slug: 'github-actions' })
    });
    const machines = [{ appId: 15368, login: 'github-actions[bot]', org: 'acme', tier: 'session' as const }];
    await expect(createGithubProvider({ machines }).verify(TOKEN)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('refuses an App that is not configured', async () => {
    stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'other-app[bot]', databaseId: 5 } } }),
      [`GET ${API}/apps/other-app`]: () => json({ id: 777, slug: 'other-app' })
    });
    await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'machine-unknown' });
  });

  it('refuses a GraphQL viewer that is not a Bot', async () => {
    stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'User', login: 'octo' } } })
    });
    await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('maps App 1 to its own rule even when another App has a higher tier', async () => {
    const machines = [
      { appId: 1, login: 'ci[bot]', org: 'acme', tier: 'read' as const },
      { appId: 2, login: 'ci-deploy[bot]', org: 'acme', tier: 'session' as const }
    ];
    stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'ci[bot]', databaseId: 11 } } }),
      [`GET ${API}/apps/ci`]: () => json({ id: 1, slug: 'ci' }),
      [`GET ${INSTALL_REPOS}`]: () => json(repos('acme'))
    });
    const who = await createGithubProvider({ machines }).verify(TOKEN);
    expect(who).toMatchObject({ kind: 'machine', appId: 1, login: 'ci[bot]' });
    expect(resolveTier(who, { grants: [], machines })).toBe('read');
  });

  describe('installation must belong to the rule\'s org', () => {
    const base = {
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'acme-reviewer[bot]', databaseId: 9001 } } }),
      [`GET ${API}/apps/acme-reviewer`]: () => json({ id: 123456, slug: 'acme-reviewer' })
    };

    it('accepts an installation whose every repo (across pages) is owned by the org', async () => {
      stubGithub({
        ...base,
        [`GET ${INSTALL_REPOS}`]: () => json(repos('acme'), 200, { link: `<${INSTALL_REPOS}&page=2>; rel="next"` }),
        [`GET ${INSTALL_REPOS}&page=2`]: () => json(repos('Acme'))
      });
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).resolves.toMatchObject({ appId: 123456 });
    });

    it('refuses an installation larger than the org check covers, saying how large', async () => {
      const f = stubGithub({ ...base, [`GET ${INSTALL_REPOS}`]: () => json({ ...repos('acme'), total_count: 1500 }) });
      const err = await createGithubProvider({ machines: MACHINES }).verify(TOKEN).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'forbidden', message: expect.stringContaining('reaches 1500 repositories; the org check covers at most 1000') });
      expect(f.mock.calls.filter(([u]) => String(u).startsWith(INSTALL_REPOS))).toHaveLength(1);
    });

    it('refuses an installation with one foreign repo', async () => {
      stubGithub({
        ...base,
        [`GET ${INSTALL_REPOS}`]: () => json(repos('acme'), 200, { link: `<${INSTALL_REPOS}&page=2>; rel="next"` }),
        [`GET ${INSTALL_REPOS}&page=2`]: () => json(repos('acme', 'someone-else'))
      });
      const err = await createGithubProvider({ machines: MACHINES }).verify(TOKEN).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'IdentityError', kind: 'forbidden' });
      expect(String((err as Error).message)).not.toContain(TOKEN);
    });

    it('refuses an installation with zero repos', async () => {
      stubGithub({ ...base, [`GET ${INSTALL_REPOS}`]: () => json(repos()) });
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'forbidden' });
    });

    it('refuses a repo without an owner login', async () => {
      stubGithub({ ...base, [`GET ${INSTALL_REPOS}`]: () => json({ repositories: [{ name: 'x' }] }) });
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'forbidden' });
    });

    it('bounds pagination and fails closed at the page cap', async () => {
      let n = 0;
      const f = vi.fn(async (url: string, init: Init = {}) => {
        const key = `${init.method ?? 'GET'} ${String(url)}`;
        const h = (base as Record<string, (i: Init) => Response>)[key];
        if (h) return h(init);
        if (String(url).startsWith(`${API}/installation/repositories`)) {
          n++;
          return json(repos('acme'), 200, { link: `<${INSTALL_REPOS}&page=${n + 1}>; rel="next"` });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', f);
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'forbidden' });
      expect(n).toBeLessThanOrEqual(10);
    });

    it('refuses (and never follows) a repo pagination link off api.github.com', async () => {
      const f = stubGithub({
        ...base,
        [`GET ${INSTALL_REPOS}`]: () => json(repos('acme'), 200, { link: '<https://evil.example/r?page=2>; rel="next"' })
      });
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'forbidden' });
      expect(f.mock.calls.some(([u]) => String(u).includes('evil.example'))).toBe(false);
    });

    it('maps a failed repo listing to upstream', async () => {
      stubGithub({ ...base, [`GET ${INSTALL_REPOS}`]: () => json({ message: 'boom' }, 502) });
      await expect(createGithubProvider({ machines: MACHINES }).verify(TOKEN)).rejects.toMatchObject({ kind: 'upstream', status: 502 });
    });
  });

  it('probe (desktop sign-in) refuses an installation token', async () => {
    stubGithub({ [`GET ${API}/user`]: integration403 });
    await expect(createGithubProvider({ machines: MACHINES }).probe(TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
