// GitHub OAuth device flow. Global fetch only; IdentityService owns the timing
// (poll no faster than intervalMs). No client secret.

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_DEVICE_PAGE = 'https://github.com/login/device';
/** Public profile needs no scope; read:org for teams, read:packages for GHCR pulls. */
export const GITHUB_SCOPES: readonly string[] = ['read:org', 'read:packages'];

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_GRANT = 'refresh_token';
export const SLOW_DOWN_STEP_MS = 5000;
const DEFAULT_INTERVAL_S = 5;
const KNOWN_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'device_flow_disabled',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'unsupported_grant_type',
  'bad_refresh_token'
]);

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

export type DeviceFlowErrorKind = 'expired' | 'denied' | 'disabled' | 'bad-client' | 'network' | 'unexpected';

/** Messages are user-facing and never carry the token or device code. */
export class DeviceFlowError extends Error {
  readonly kind: DeviceFlowErrorKind;
  /** GitHub answered 429/5xx: retry, but back off. */
  readonly throttled: boolean;
  constructor(kind: DeviceFlowErrorKind, message: string, throttled = false) {
    super(message);
    this.name = 'DeviceFlowError';
    this.kind = kind;
    this.throttled = throttled;
  }
}

/** An access token. The expiry fields are present only for expiring
 *  (GitHub App user) tokens; a classic OAuth app token never expires. */
export interface TokenGrant {
  token: string;
  scopes: string[];
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export type PollResult = { status: 'pending'; intervalMs: number } | ({ status: 'done' } & TokenGrant);

async function post(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'claude-fleet' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    throw new DeviceFlowError('network', `Couldn't reach github.com (${(err as Error).name}). Check your network.`);
  }
  const unavailable = () => new DeviceFlowError('network', `GitHub is temporarily unavailable (HTTP ${res.status}). Try again shortly.`, true);
  if (res.status >= 500) throw unavailable();
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    if (res.status === 429) throw unavailable();
    throw new DeviceFlowError('unexpected', `GitHub answered HTTP ${res.status} without JSON`);
  }
  const error = (body as { error?: unknown }).error;
  if (res.status === 429 && !(typeof error === 'string' && KNOWN_ERRORS.has(error))) throw unavailable();
  return body as Record<string, unknown>;
}

function mapError(code: string): DeviceFlowError {
  switch (code) {
    case 'expired_token':
      return new DeviceFlowError('expired', 'The sign-in code expired. Start again.');
    case 'bad_refresh_token':
      return new DeviceFlowError('expired', 'GitHub no longer accepts the saved sign-in. Sign in again.');
    case 'access_denied':
      return new DeviceFlowError('denied', 'Sign-in was cancelled on GitHub.');
    case 'device_flow_disabled':
      return new DeviceFlowError('disabled', 'Device flow is disabled for this OAuth app. Enable it in the app’s GitHub settings.');
    case 'incorrect_client_credentials':
      return new DeviceFlowError('bad-client', 'GitHub does not recognise the configured OAuth client id.');
    default:
      return new DeviceFlowError('unexpected', `GitHub device flow error: ${/^[a-z_]{1,64}$/.test(code) ? code : 'unrecognised'}`);
  }
}

function safeVerificationUri(raw: string): string {
  try {
    const u = new URL(raw);
    const ok = u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password;
    return ok ? u.toString() : GITHUB_DEVICE_PAGE;
  } catch {
    return GITHUB_DEVICE_PAGE;
  }
}

function positiveSeconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export async function requestDeviceCode(clientId: string, now: () => number = Date.now): Promise<DeviceCode> {
  const b = await post(GITHUB_DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_SCOPES.join(' ') });
  if (typeof b.error === 'string') throw mapError(b.error);
  const expiresIn = positiveSeconds(b.expires_in);
  if (typeof b.device_code !== 'string' || typeof b.user_code !== 'string' || typeof b.verification_uri !== 'string' || expiresIn === null) {
    throw new DeviceFlowError('unexpected', 'GitHub device code response is missing fields');
  }
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: safeVerificationUri(b.verification_uri),
    expiresAt: now() + expiresIn * 1000,
    intervalMs: (positiveSeconds(b.interval) ?? DEFAULT_INTERVAL_S) * 1000
  };
}

function tokenGrant(b: Record<string, unknown>, now: number): TokenGrant | null {
  if (typeof b.access_token !== 'string' || !b.access_token) return null;
  const g: TokenGrant = { token: b.access_token, scopes: typeof b.scope === 'string' ? b.scope.split(/[\s,]+/).filter(Boolean) : [] };
  const expiresIn = positiveSeconds(b.expires_in);
  if (expiresIn !== null) g.expiresAt = now + expiresIn * 1000;
  if (typeof b.refresh_token === 'string' && b.refresh_token) {
    g.refreshToken = b.refresh_token;
    const refreshIn = positiveSeconds(b.refresh_token_expires_in);
    if (refreshIn !== null) g.refreshExpiresAt = now + refreshIn * 1000;
  }
  return g;
}

export async function pollDeviceToken(clientId: string, deviceCode: string, intervalMs: number, now: () => number = Date.now): Promise<PollResult> {
  const b = await post(GITHUB_TOKEN_URL, { client_id: clientId, device_code: deviceCode, grant_type: GRANT_TYPE });
  const grant = tokenGrant(b, now());
  if (grant) return { status: 'done', ...grant };
  if (b.error === 'authorization_pending') return { status: 'pending', intervalMs };
  if (b.error === 'slow_down') {
    const fromGithub = (positiveSeconds(b.interval) ?? 0) * 1000;
    return { status: 'pending', intervalMs: Math.max(fromGithub, intervalMs + SLOW_DOWN_STEP_MS) };
  }
  if (typeof b.error === 'string') throw mapError(b.error);
  throw new DeviceFlowError('unexpected', 'GitHub token response had neither a token nor an error');
}

/** Trade a refresh token for a new pair; GitHub invalidates the old refresh token. */
export async function refreshDeviceToken(clientId: string, refreshToken: string, now: () => number = Date.now): Promise<TokenGrant> {
  const b = await post(GITHUB_TOKEN_URL, { client_id: clientId, grant_type: REFRESH_GRANT, refresh_token: refreshToken });
  const grant = tokenGrant(b, now());
  if (grant) return grant;
  if (typeof b.error === 'string') throw mapError(b.error);
  throw new DeviceFlowError('unexpected', 'GitHub refresh response had neither a token nor an error');
}
