import { describe, expect, it } from 'vitest';
import { GITHUB_API, hasPackagesRead, mergeSso, nextLink, parseScopes, parseSsoHeader } from './githubHeaders.js';

describe('parseScopes', () => {
  it('splits X-OAuth-Scopes', () => {
    expect(parseScopes('read:org, read:packages')).toEqual(['read:org', 'read:packages']);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
  });
});

describe('hasPackagesRead', () => {
  it('accepts read:packages or write:packages', () => {
    expect(hasPackagesRead(['read:org', 'read:packages'])).toBe(true);
    expect(hasPackagesRead(['write:packages'])).toBe(true);
    expect(hasPackagesRead(['read:org'])).toBe(false);
    expect(hasPackagesRead([])).toBe(false);
  });
});

describe('parseSsoHeader', () => {
  it('URL-decodes the org, and drops one that is malformed or not a login', () => {
    expect(parseSsoHeader('required; url=https://github.com/orgs/Acme%2DCorp/sso')?.org).toBe('Acme-Corp');
    expect(parseSsoHeader('required; url=https://github.com/orgs/%E0%A4%A/sso')?.org).toBeNull();
    expect(parseSsoHeader('required; url=https://github.com/orgs/a%20b/sso')?.org).toBeNull();
  });

  it('parses the required form with the org from the URL', () => {
    expect(parseSsoHeader('required; url=https://github.com/orgs/acme/sso?authorization_request=AbC123')).toEqual({
      url: 'https://github.com/orgs/acme/sso?authorization_request=AbC123',
      org: 'acme',
      orgIds: []
    });
  });

  it('parses the partial-results form', () => {
    expect(parseSsoHeader('partial-results; organizations=21955855,20582480')).toEqual({
      url: null,
      org: null,
      orgIds: [21955855, 20582480]
    });
  });

  it('drops a URL that is not https://github.com', () => {
    expect(parseSsoHeader('required; url=https://evil.example/orgs/acme/sso')).toBeNull();
    expect(parseSsoHeader('required; url=http://github.com/orgs/acme/sso')).toBeNull();
  });

  it('returns null for absent or unrecognised headers', () => {
    expect(parseSsoHeader(null)).toBeNull();
    expect(parseSsoHeader('something-else')).toBeNull();
  });
});

describe('mergeSso', () => {
  it('keeps the first URL and unions org ids', () => {
    const a = { url: 'https://github.com/orgs/acme/sso', org: 'acme', orgIds: [2] };
    const b = { url: null, org: null, orgIds: [1, 2] };
    expect(mergeSso(a, b)).toEqual({ url: 'https://github.com/orgs/acme/sso', org: 'acme', orgIds: [1, 2] });
    expect(mergeSso(null, b)).toBe(b);
    expect(mergeSso(a, null)).toBe(a);
    expect(mergeSso(null, null)).toBeNull();
  });
});

describe('nextLink', () => {
  it('follows rel="next" on api.github.com only', () => {
    expect(
      nextLink(`<${GITHUB_API}/user/teams?per_page=100&page=2>; rel="next", <${GITHUB_API}/user/teams?per_page=100&page=3>; rel="last"`)
    ).toBe(`${GITHUB_API}/user/teams?per_page=100&page=2`);
    expect(nextLink('<https://evil.example/user/teams?page=2>; rel="next"')).toBeNull();
    expect(nextLink(`<${GITHUB_API}/user/teams?page=1>; rel="prev"`)).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});
