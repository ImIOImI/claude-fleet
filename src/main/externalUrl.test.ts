import { describe, it, expect } from 'vitest';
import { isOpenableExternalUrl } from './externalUrl.js';

describe('isOpenableExternalUrl', () => {
  it('allows http(s) links', () => {
    expect(isOpenableExternalUrl('https://claude.ai/api/organizations/x/mcp/start-auth/y?product_surface=cli')).toBe(true);
    expect(isOpenableExternalUrl('http://127.0.0.1:5173')).toBe(true);
  });

  it('rejects about:blank and other non-web protocols', () => {
    for (const url of ['about:blank', 'file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:', 'not a url', '']) {
      expect(isOpenableExternalUrl(url)).toBe(false);
    }
  });
});
