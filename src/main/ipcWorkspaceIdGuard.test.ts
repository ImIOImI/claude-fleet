// Regression coverage for the #444 security-review finding: a workspace id is
// also a vault scope (resolveEnv injects that bag into the workspace's env),
// so `workspace:create` and `workspace:writeManifest` must reject a reserved
// or colon-bearing id *before* doing anything else. `registerIpc` itself pulls
// in dockerode, better-sqlite3, the broker client, etc., so standing up a real
// ipcMain to call the handlers is not the cheapest reliable way to guard
// against the call being dropped by a future edit. Instead: unit-test the
// guard directly (also covered in vaultScopes.test.ts) and assert, by source
// text, that both handler bodies still call it on the right field before the
// next `ipcMain.handle(` registration starts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertRendererWorkspaceId } from './vaultScopes.js';

const src = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8');

/** The source text of one `ipcMain.handle('<channel>', …)` registration, up to the next one. */
function handlerSource(channel: string): string {
  const marker = `'${channel}'`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`ipc.ts: no ipcMain.handle registration found for ${channel}`);
  const next = src.indexOf('ipcMain.handle(', start + marker.length);
  return src.slice(start, next > 0 ? next : src.length);
}

describe('assertRendererWorkspaceId rejects a reserved or colon id (#444 security review)', () => {
  it.each([
    ['a loadout-source vault scope', 'loadout-source:ghcr.io/acme/private'],
    ['an endpoint vault scope', 'endpoint:3f0c'],
    ['an id with a colon', 'ws:1']
  ])('rejects %s', (_label, id) => {
    expect(() => assertRendererWorkspaceId(id)).toThrow(/workspace id/);
  });
});

describe('workspace id guard wiring (#444 security review)', () => {
  it('workspace:create asserts the renderer-supplied id before creating anything', () => {
    expect(handlerSource('workspace:create')).toMatch(/assertRendererWorkspaceId\(input\?\.id\)/);
  });

  it('workspace:writeManifest asserts the renderer-supplied id before writing anything', () => {
    expect(handlerSource('workspace:writeManifest')).toMatch(/assertRendererWorkspaceId\(spec\?\.id\)/);
  });
});
