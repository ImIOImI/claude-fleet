import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceFlowError, GITHUB_SCOPES, pollDeviceToken, requestDeviceCode } from './deviceFlow.js';

type Init = { method?: string; headers?: Record<string, string>; body?: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CLIENT = 'Iv1.testclient';

function stub(handler: (url: string, params: URLSearchParams, init: Init) => Response) {
  const f = vi.fn(async (url: string, init: Init = {}) => handler(String(url), new URLSearchParams(init.body ?? ''), init));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('requestDeviceCode', () => {
  it('asks github.com for a code with exactly read:org read:packages', async () => {
    const f = stub((url, params) => {
      expect(url).toBe('https://github.com/login/device/code');
      expect(params.get('client_id')).toBe(CLIENT);
      expect(params.get('scope')).toBe('read:org read:packages');
      expect(params.has('client_secret')).toBe(false);
      return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    });
    expect(GITHUB_SCOPES).toEqual(['read:org', 'read:packages']);
    expect(await requestDeviceCode(CLIENT, () => 1000)).toEqual({
      deviceCode: 'dc',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: 901_000,
      intervalMs: 5000
    });
    expect((f.mock.calls[0][1] as Init).headers?.Accept).toBe('application/json');
  });

  it('replaces a verification_uri that is not https://github.com', async () => {
    stub(() => json({ device_code: 'dc', user_code: 'U', verification_uri: 'https://evil.example/device', expires_in: 900, interval: 5 }));
    expect((await requestDeviceCode(CLIENT)).verificationUri).toBe('https://github.com/login/device');
  });

  it.each([
    ['device_flow_disabled', 'disabled'],
    ['incorrect_client_credentials', 'bad-client']
  ])('maps %s to %s', async (error, kind) => {
    stub(() => json({ error }));
    await expect(requestDeviceCode(CLIENT)).rejects.toMatchObject({ name: 'DeviceFlowError', kind });
  });

  it('maps a transport failure to network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(requestDeviceCode(CLIENT)).rejects.toBeInstanceOf(DeviceFlowError);
    await expect(requestDeviceCode(CLIENT)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('pollDeviceToken', () => {
  it('posts the device-code grant', async () => {
    stub((url, params) => {
      expect(url).toBe('https://github.com/login/oauth/access_token');
      expect(params.get('client_id')).toBe(CLIENT);
      expect(params.get('device_code')).toBe('dc');
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      return json({ error: 'authorization_pending' });
    });
    expect(await pollDeviceToken(CLIENT, 'dc', 5000)).toEqual({ status: 'pending', intervalMs: 5000 });
  });

  it('slows down by GitHub’s interval, or by +5s when none is given', async () => {
    stub(() => json({ error: 'slow_down', interval: 15 }));
    expect(await pollDeviceToken(CLIENT, 'dc', 5000)).toEqual({ status: 'pending', intervalMs: 15_000 });
    stub(() => json({ error: 'slow_down' }));
    expect(await pollDeviceToken(CLIENT, 'dc', 5000)).toEqual({ status: 'pending', intervalMs: 10_000 });
  });

  it('returns the token and its granted scopes', async () => {
    stub(() => json({ access_token: 'gho_x', token_type: 'bearer', scope: 'read:org,read:packages' }));
    expect(await pollDeviceToken(CLIENT, 'dc', 5000)).toEqual({ status: 'done', token: 'gho_x', scopes: ['read:org', 'read:packages'] });
  });

  it.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
    ['incorrect_device_code', 'unexpected']
  ])('maps %s to %s', async (error, kind) => {
    stub(() => json({ error }));
    await expect(pollDeviceToken(CLIENT, 'dc', 5000)).rejects.toMatchObject({ kind });
  });
});

describe('device flow hardening', () => {
  it.each([
    'http://github.com/login/device',
    'https://github.com:8443/login/device',
    'https://user@github.com/login/device',
    'https://github.com.evil.example/login/device',
    'not a url'
  ])('replaces verification_uri %s', async (uri) => {
    stub(() => json({ device_code: 'dc', user_code: 'U', verification_uri: uri, expires_in: 900, interval: 5 }));
    expect((await requestDeviceCode(CLIENT)).verificationUri).toBe('https://github.com/login/device');
  });

  it('refuses redirects on both endpoints', async () => {
    const f = stub((url) =>
      url.endsWith('/device/code')
        ? json({ device_code: 'dc', user_code: 'U', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
        : json({ error: 'authorization_pending' })
    );
    await requestDeviceCode(CLIENT);
    await pollDeviceToken(CLIENT, 'dc', 5000);
    for (const call of f.mock.calls) expect((call[1] as { redirect?: string }).redirect).toBe('error');
  });

  it('keeps an unrecognised error code out of the message unless it is a plain identifier', async () => {
    stub(() => json({ error: 'weird<script>' }));
    const err = (await pollDeviceToken(CLIENT, 'dc', 5000).catch((e: unknown) => e)) as DeviceFlowError;
    expect(err).toMatchObject({ kind: 'unexpected' });
    expect(err.message).not.toContain('<script>');
  });

  it('treats an empty access_token as unexpected rather than done', async () => {
    stub(() => json({ access_token: '', scope: 'read:org' }));
    await expect(pollDeviceToken(CLIENT, 'dc', 5000)).rejects.toMatchObject({ kind: 'unexpected' });
  });
});
