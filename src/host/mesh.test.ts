import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MESH_POLL_MS, MESH_READY_URL, MESH_WAIT_MS, waitForMesh } from './mesh.js';

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function probe(status: (n: number) => number): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const s = createServer((_q, r) => {
    r.statusCode = status(++n);
    r.end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz/ready`, hits: () => n };
}

describe('waitForMesh', () => {
  it('waits up to 60 s, probing every 1 s, on the sidecar URL (D89)', () => {
    expect([MESH_WAIT_MS, MESH_POLL_MS, MESH_READY_URL]).toEqual([60_000, 1_000, 'http://127.0.0.1:15021/healthz/ready']);
  });

  it('is true once the sidecar answers 200', async () => {
    const p = await probe((n) => (n < 3 ? 503 : 200));
    expect(await waitForMesh({ url: p.url, timeoutMs: 2_000, pollMs: 10 })).toBe(true);
    expect(p.hits()).toBe(3);
  });

  it('is false when it never does', async () => {
    const p = await probe(() => 503);
    expect(await waitForMesh({ url: p.url, timeoutMs: 100, pollMs: 10 })).toBe(false);
  });

  it('does not follow a redirect to a 200', async () => {
    const ok = await probe(() => 200);
    let n = 0;
    const s = createServer((_q, r) => {
      n++;
      r.writeHead(302, { location: ok.url });
      r.end();
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    expect(await waitForMesh({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz/ready`, timeoutMs: 100, pollMs: 10 })).toBe(false);
    expect([n > 0, ok.hits()]).toEqual([true, 0]);
  });

  it('is false with nothing listening', async () => {
    const p = await probe(() => 200);
    servers.splice(0).forEach((s) => s.close());
    expect(await waitForMesh({ url: p.url, timeoutMs: 100, pollMs: 10 })).toBe(false);
  });

  it('is false at once when aborted', async () => {
    const p = await probe(() => 503);
    const ac = new AbortController();
    const t0 = Date.now();
    const done = waitForMesh({ url: p.url, timeoutMs: 60_000, pollMs: 50, signal: ac.signal });
    ac.abort();
    expect(await done).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
