import { describe, it, expect } from 'vitest';
import { parseEndpoints, compileEndpointEnv, type ModelEndpoint } from './endpoints.js';

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
