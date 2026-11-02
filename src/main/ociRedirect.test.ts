// Real-socket test for a platform assumption the authenticated-fetch sites in
// ociClient.ts rely on (#444 security review): the global `fetch` (undici)
// drops the `Authorization` header on a cross-origin redirect (e.g. a GHCR
// blob 307-redirecting to a CDN host). We never set an explicit `redirect`
// mode, so this is the *default* `fetch` behaviour on an origin change — this
// test exercises that default directly against two real `node:http` servers,
// not through the client's https-only URL builder (that would require TLS).
// If this ever fails, do not "fix" it by switching fetch implementations;
// treat it as a signal that credentials could leak to a redirect target and
// stop to re-design the pull path first.

import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('fetch drops Authorization across a cross-origin redirect (platform assumption)', () => {
  it('does not forward Authorization from the redirecting origin to the redirect target', async () => {
    let receivedAuth: string | undefined | null = null; // null = request B never happened

    const serverB = http.createServer((req, res) => {
      receivedAuth = req.headers['authorization'] ?? undefined;
      res.statusCode = 200;
      res.end('ok');
    });
    const portB = await listen(serverB);

    const serverA = http.createServer((req, res) => {
      res.statusCode = 307; // same method/body preserved, just like a GHCR blob redirect
      res.setHeader('Location', `http://127.0.0.1:${portB}/`);
      res.end();
    });
    const portA = await listen(serverA);

    try {
      // Exactly as the client calls it: an Authorization header, `redirect` left
      // at its default (no explicit "manual"/"error").
      const res = await fetch(`http://127.0.0.1:${portA}/`, {
        headers: { Authorization: 'Bearer super-secret-token' }
      });
      expect(res.status).toBe(200);
      expect(receivedAuth).toBeUndefined(); // server B saw no Authorization header at all
    } finally {
      await close(serverA);
      await close(serverB);
    }
  });
});
