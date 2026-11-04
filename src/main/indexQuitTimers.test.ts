// index.ts's `before-quit` wires dockerode, better-sqlite3, the broker client,
// etc. (same reason ipc.ts handlers aren't instantiated in
// ipcWorkspaceIdGuard.test.ts), so standing up a real app instance is not the
// cheapest reliable way to guard the #457 fix. Instead: assert, by source
// text, that before-quit stops the notify/automation timers before closing
// inboxStore — so a tick firing mid-shutdown never hits a destroyed driver.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

/** The source text of one `app.on('<event>', …)` registration, up to the next one. */
function eventHandlerSource(event: string): string {
  const marker = `app.on('${event}'`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`index.ts: no app.on('${event}', ...) registration found`);
  const next = src.indexOf("app.on(", start + marker.length);
  return src.slice(start, next > 0 ? next : src.length);
}

describe('before-quit stops notify/automation timers before closing inbox.db (#457)', () => {
  const body = eventHandlerSource('before-quit');

  it('calls notifySvc.stop() before inboxStore.close()', () => {
    const stopAt = body.indexOf('notifySvc?.stop()');
    const closeAt = body.indexOf('inboxStore?.close()');
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(closeAt);
  });

  it('calls auto.stop() before inboxStore.close()', () => {
    const stopAt = body.indexOf('auto?.stop()');
    const closeAt = body.indexOf('inboxStore?.close()');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(closeAt);
  });
});
