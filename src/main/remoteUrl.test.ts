import { describe, expect, it } from 'vitest';
import { normalizeHostUrl, plainHttpWarning, RemoteUrlError, wsUrl } from './remoteUrl.js';

describe('normalizeHostUrl', () => {
  it.each([
    ['https://review-bot.example.com/', 'https://review-bot.example.com'],
    ['  https://Review-Bot.example.com:8443/fleet//  ', 'https://review-bot.example.com:8443/fleet'],
    ['http://fleet-agent-svc:8080', 'http://fleet-agent-svc:8080'],
    ['https://x:443/', 'https://x']
  ])('%s → %s', (input, want) => {
    expect(normalizeHostUrl(input)).toBe(want);
  });

  it.each(['review-bot.example.com', 'ftp://x', 'https://u:p@x', 'https://u@x', 'https://x/?token=1', 'https://x/#a', 'https://x/?', 'ws://x'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeHostUrl(input)).toThrow(RemoteUrlError);
    }
  );

  it('never echoes rejected input, which may hold a credential', () => {
    try {
      normalizeHostUrl('https://user:sekrit@x');
    } catch (e) {
      expect((e as Error).message).not.toContain('sekrit');
    }
  });
});

describe('plainHttpWarning', () => {
  it('warns only for non-loopback http', () => {
    expect(plainHttpWarning('http://fleet-agent-svc:8080')).toMatch(/unencrypted/);
    expect(plainHttpWarning('http://localhost:8080')).toBeNull();
    expect(plainHttpWarning('http://127.0.0.1:8080')).toBeNull();
    expect(plainHttpWarning('http://[::1]:8080')).toBeNull();
    expect(plainHttpWarning('https://x')).toBeNull();
    expect(plainHttpWarning('http://localhost.evil.com')).toMatch(/unencrypted/);
  });
});

describe('wsUrl', () => {
  it('maps http(s) to ws(s)', () => {
    expect(wsUrl('https://x/fleet', '/attach')).toBe('wss://x/fleet/attach');
    expect(wsUrl('http://x', '/events')).toBe('ws://x/events');
  });
});
