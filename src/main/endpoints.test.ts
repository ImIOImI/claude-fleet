import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { parseEndpoints, compileEndpointEnv, probeEndpoint, type ModelEndpoint } from './endpoints.js';

const ep: ModelEndpoint = {
  id: 'abc',
  name: 'local-ollama',
  baseUrl: 'http://host.docker.internal:11434',
  modelId: 'qwen3:4b',
  hasApiKey: false
};

describe('compileEndpointEnv', () => {
  it('compiles the full env contract with the placeholder token when no key', () => {
    expect(compileEndpointEnv(ep, null)).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'claude-fleet',
      ANTHROPIC_MODEL: 'qwen3:4b',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3:4b',
      CF_SUMMARY_MODEL: 'qwen3:4b'
    });
  });

  it('uses the real key and smallFastModelId when present', () => {
    const env = compileEndpointEnv({ ...ep, smallFastModelId: 'qwen3:0.6b', hasApiKey: true }, 'sk-org-123');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-org-123');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('qwen3:0.6b');
    expect(env.ANTHROPIC_MODEL).toBe('qwen3:4b');
  });

  it('strips a trailing slash from baseUrl', () => {
    const env = compileEndpointEnv({ ...ep, baseUrl: 'http://10.0.0.5:8000/' }, null);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.0.5:8000');
  });
});

describe('parseEndpoints', () => {
  it('accepts a valid persisted list and drops malformed rows', () => {
    const parsed = parseEndpoints([
      { id: 'a', name: 'n', baseUrl: 'http://x:1', modelId: 'm', hasApiKey: true },
      { id: 'b', name: 'missing-url', modelId: 'm', hasApiKey: false },
      'garbage'
    ]);
    expect(parsed.map((e) => e.id)).toEqual(['a']);
  });

  it('returns [] for non-arrays', () => {
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints({})).toEqual([]);
  });

  it('coerces optional fields defensively', () => {
    const [e] = parseEndpoints([
      { id: 'a', name: 'n', baseUrl: 'http://x:1', modelId: 'm', hasApiKey: 'yes', contextLength: '40960', notes: 7 }
    ]);
    expect(e.hasApiKey).toBe(false);       // strict boolean
    expect(e.contextLength).toBeUndefined(); // strict number
    expect(e.notes).toBeUndefined();         // strict string
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port);
  }));
}

describe('probeEndpoint', () => {
  it('reports ok for an Anthropic-format /v1/messages endpoint', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: {} }));
      } else {
        res.writeHead(404).end();
      }
    });
    const port = await listen(server);
    try {
      const r = await probeEndpoint(`http://127.0.0.1:${port}`, 'test-model', null);
      expect(r.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('reports a helpful failure for a non-Anthropic endpoint (404)', async () => {
    const server = createServer((_req, res) => res.writeHead(404).end('not found'));
    const port = await listen(server);
    try {
      const r = await probeEndpoint(`http://127.0.0.1:${port}`, 'test-model', null);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(404);
      expect(r.message).toContain('Anthropic');
    } finally {
      server.close();
    }
  });

  it('reports unreachable endpoints without throwing', async () => {
    const r = await probeEndpoint('http://127.0.0.1:1', 'test-model', null);
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain('unreachable');
  });
});
