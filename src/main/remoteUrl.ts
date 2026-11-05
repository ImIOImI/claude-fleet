// Remote host URLs: one canonical form per host, so a bookmark, its client and
// its token use are keyed identically.

export class RemoteUrlError extends Error {}

/** Errors never echo the input: it may hold a credential. */
export function normalizeHostUrl(input: string): string {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RemoteUrlError('Enter a full URL, e.g. https://review-bot.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RemoteUrlError('The host URL must start with https:// or http://');
  if (u.username || u.password) throw new RemoteUrlError('The host URL must not contain credentials');
  // URL drops an empty `?` or `#`, so check the raw text too.
  if (u.search || u.hash || /[?#]/.test(raw)) throw new RemoteUrlError('The host URL must not have a query or fragment');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The add-workspace warning for plain http to a non-loopback host, else null. */
export function plainHttpWarning(url: string): string | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' || LOOPBACK.test(u.hostname)) return null;
  return 'Plain http: your GitHub token crosses the network unencrypted unless a VPN, tunnel or mesh encrypts it.';
}

/** `base` must already be canonical (normalizeHostUrl). */
export function wsUrl(base: string, path: string): string {
  return base.replace(/^http/, 'ws') + path;
}
