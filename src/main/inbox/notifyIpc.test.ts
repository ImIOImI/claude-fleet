// registerNotifyIpc wires real Electron (BrowserWindow/ipcMain/Notification)
// and ../ipc.js (which pulls in dockerode etc. — see ipcWorkspaceIdGuard.test.ts
// for the same tradeoff on ipc.ts), so standing up a real instance isn't the
// cheapest reliable way to pin its quit-time stop() behavior. Instead: assert,
// by source text, that stop() clears both intervals via a `stopped` guard and
// cancels pending timers, idempotently (#457).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./notifyIpc.ts', import.meta.url), 'utf8');

describe('registerNotifyIpc stop() wiring (#457 quit)', () => {
  it('guards the 30s tick and the daily prune interval with a stopped flag', () => {
    expect(src).toMatch(/tick = setInterval\(\(\) => \{ if \(!stopped\) svc\.tick\(\)\.catch\(warn\('notify-tick'\)\); \}, 30_000\);/);
    expect(src).toMatch(/daily = setInterval\(\(\) => \{ if \(!stopped\) svc\.prune\(\)\.catch\(\(\) => \{[^}]*\}\); \}, 86_400_000\);/);
  });

  it('stop() is idempotent: clears both intervals and cancels pending timers before returning', () => {
    const start = src.indexOf('function stop(): void {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/if \(stopped\) return;/);
    expect(body).toMatch(/stopped = true;/);
    expect(body).toMatch(/clearInterval\(tick\);/);
    expect(body).toMatch(/clearInterval\(daily\);/);
    expect(body).toMatch(/svc\.cancelPending\(\);/);
  });

  it('returns the notify service augmented with stop and resume', () => {
    expect(src).toMatch(/return Object\.assign\(svc, \{ stop, resume \}\);/);
  });

  it('resume() restarts both intervals on the same service', () => {
    const start = src.indexOf('function resume(): void {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  }', start));
    expect(body).toMatch(/if \(!stopped\) return;/);
    expect(body).toMatch(/stopped = false;/);
    expect(body).toMatch(/startTimers\(\);/);
  });
});
