import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubProvider } from './githubProvider.js';

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
const MACHINES = [{ appId: 123456, login: 'acme-reviewer[bot]', tier: 'steer' as const }];

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

  it('maps a transport failure to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(createGithubProvider().probe(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('github provider: machines (GitHub App installation tokens)', () => {
  const integration403 = () => json({ message: 'Resource not accessible by integration' }, 403);

  it('maps an installation token to the configured bot identity', async () => {
    const f = stubGithub({
      [`GET ${API}/user`]: integration403,
      [`POST ${API}/graphql`]: () => json({ data: { viewer: { __typename: 'Bot', login: 'acme-reviewer[bot]', databaseId: 9001 } } }),
      [`GET ${API}/apps/acme-reviewer`]: () => json({ id: 123456, slug: 'acme-reviewer' })
    });
    expect(await createGithubProvider({ machines: MACHINES }).verify(TOKEN)).toEqual({
      provider: 'github',
      kind: 'machine',
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
      [`GET ${API}/apps/acme-reviewer`]: () => json({ id: 123456, slug: 'acme-reviewer' })
    });
    expect((await createGithubProvider({ machines: MACHINES }).verify(TOKEN)).login).toBe('acme-reviewer[bot]');
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

  it('probe (desktop sign-in) refuses an installation token', async () => {
    stubGithub({ [`GET ${API}/user`]: integration403 });
    await expect(createGithubProvider({ machines: MACHINES }).probe(TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
