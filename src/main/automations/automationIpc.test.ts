// registerAutomationIpc wires real Electron plus ../ipc.js, ../vault.js,
// ../loadouts.js, ../mcpServer.js, etc. — far too much to stand up for a unit
// test of a quit-time code path (see ipcWorkspaceIdGuard.test.ts for the same
// tradeoff on ipc.ts). Instead: assert, by source text, that stop() clears the
// tick interval via a `stopped` guard and cancels pending timers, idempotently
// (#457). The actual cancellation behavior of cancelPending() is pinned
// behaviorally in automationService.test.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./automationIpc.ts', import.meta.url), 'utf8');

describe('registerAutomationIpc stop() wiring (#457 quit)', () => {
  it('guards the 30s scheduler tick with a stopped flag', () => {
    const start = src.indexOf('tick = setInterval(() => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}, 30_000);', start));
    expect(body).toMatch(/if \(stopped\) return;/);
  });

  it('stop() is idempotent: clears the interval and cancels pending timers before returning', () => {
    const start = src.indexOf('function stop(): void {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/if \(stopped\) return;/);
    expect(body).toMatch(/stopped = true;/);
    expect(body).toMatch(/clearInterval\(tick\);/);
    expect(body).toMatch(/svc\.cancelPending\(\);/);
  });

  it('returns stop alongside automations/proposals/setInboxSink', () => {
    expect(src).toMatch(/return \{ automations: svc, proposals, setInboxSink: \(s\) => \{ sink = s; \}, stop, resume \};/);
  });

  it('resume() restarts the tick and the todo listener on the same service, without recover()', () => {
    const start = src.indexOf('function resume(): void {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  }', start));
    expect(body).toMatch(/stopped = false;/);
    expect(body).toMatch(/startTick\(\);/);
    expect(body).toMatch(/inboxEvents\.on\('todo', onTodo\);/);
    expect(body).not.toMatch(/recover/);
  });
});
