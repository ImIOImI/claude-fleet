import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignedOutBanner } from './SignedOutBanner';
import { DeviceCodeWaiting } from './DeviceCodePanel';

describe('signed-out a11y (M7)', () => {
  it('the banner announces its text, not the sign-in panel beside it', () => {
    const h = renderToStaticMarkup(createElement(SignedOutBanner, { text: 'Signed out' }));
    expect(h).toMatch(/^<div class="daemon-banner signed-out-banner">/);
    expect(h).toContain('<span class="signed-out-text" role="status">Signed out</span>');
    expect(h.match(/role="status"/g)).toHaveLength(1);
  });

  it('the code has a visible-to-readers label and the ticking countdown is not announced', () => {
    const h = renderToStaticMarkup(
      createElement(DeviceCodeWaiting, { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 60_000, now: 0, copied: false, onCopy: () => undefined, onCancel: () => undefined })
    );
    expect(h).toContain('<span class="visually-hidden">Code: </span><span class="device-code">ABCD-1234</span>');
    expect(h).not.toMatch(/aria-label/);
    expect(h).toMatch(/<span class="device-countdown" aria-live="off">/);
  });
});
