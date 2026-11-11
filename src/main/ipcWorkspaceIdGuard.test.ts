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

describe('remote bookmark wiring', () => {
  it('workspace:create and workspace:writeManifest refuse remote specs before writing anything', () => {
    expect(handlerSource('workspace:create')).toMatch(/const prior = await readWorkspaceManifest\(input\.id\);\s*assertNotRemoteSpec\(input\.kind, prior\)\s*;\s*const kind/);
    const write = handlerSource('workspace:writeManifest');
    expect(write).toMatch(/const existing = await readWorkspaceManifest\(spec\.id\);\s*assertNotRemoteSpec\(spec\.kind, existing\);/);
    expect(write).toMatch(/remote: undefined/);
  });

  it('workspace:writeManifest derives publish in main and drops cursors of removed targets', () => {
    const write = handlerSource('workspace:writeManifest');
    expect(write).toMatch(/const publish = publishOnWrite\(spec, existing\?\.publish, remoteIds, Date\.now\(\)\)/);
    expect(write).toMatch(/\.\.\.spec,\s*workspaceRoot,\s*launcher: incomingLauncher,\s*mounts,\s*publish,/);
    expect(write).toMatch(/deletePublishCursor\(spec\.id, id\)/);
    expect(handlerSource('workspace:create')).toMatch(/publish: prior\?\.publish,/);
  });

  it('workspace:remove routes through resolveRemoveKind', () => {
    expect(handlerSource('workspace:remove')).toMatch(/backendForKind\(await resolveRemoveKind\(containerId, opts\?\.id\)\)/);
  });

  it('remote token consent is a main-process dialog, and the refresher stops on quit', () => {
    expect(src).toMatch(/async function confirmRemote[\s\S]*?dialog\.showMessageBox[\s\S]*?response === 1/);
    expect(src).toMatch(/confirm: confirmRemote,/);
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/app\.on\('before-quit'[\s\S]*?stopRemoteBackend\(\);/);
  });

  it('tab-close detaches remote sessions; only endSessionByBroker CLOSEs them', () => {
    expect(handlerSource('pty:closeSessionByBroker')).toMatch(/tabCloseVerb\(await resolveKind\(workspaceId\)\) === 'detach'[\s\S]*?detachHandle\(ptyHandleId\)[\s\S]*?reapHandle\(/);
    expect(handlerSource('pty:endSessionByBroker')).toMatch(/reapHandle\(ptyHandleId, 'pty:endSessionByBroker'\)/);
    expect(handlerSource('pty:detach')).toMatch(/detachHandle\(sessionId\)/);
  });

  it('desktop automations refuse remote targets before any live-handle shortcut', () => {
    const fn = (name: string): string => {
      const start = src.indexOf(`export async function ${name}(`);
      if (start < 0) throw new Error(`ipc.ts: no ${name}`);
      return src.slice(start, src.indexOf('\n}\n', start));
    };
    expect(fn('hostPostToWorkspace')).toMatch(/> \{\s*const kind = await resolveAutomationKind\(targetId\);\s*const live = liveHandleForWorkspace/);
    expect(fn('hostSpawnFresh')).toMatch(/> \{\s*const kind = await resolveAutomationKind\(workspaceId\);/);
    expect(fn('hostEnsureRunning')).toMatch(/> \{\s*const kind = await resolveAutomationKind\(targetId\);/);
  });

  it('a remote owner feeds neither committee busy nor session.idle', () => {
    const attach = handlerSource('pty:attach');
    expect(attach).toMatch(/const signalOwner = owner && hostRunsSignals\(owner\.kind\) \? owner : null;/);
    expect(attach).toMatch(/if \(signalOwner && detector\.push\([\s\S]*?committeeBusy\.set\(signalOwner\.id[\s\S]*?emitFleetEvent\(\{ on: 'session\.idle', workspaceId: signalOwner\.id \}\)/);
    expect(attach).not.toMatch(/committeeBusy\.set\(owner\.id/);
  });

  it('port forwarding is reconciled for containers only', () => {
    expect(handlerSource('workspace:list')).toMatch(/w\.state === 'running' && w\.kind === 'container'/);
  });

  it('the bearer token is bound only in main and exposed by no preload or renderer code', () => {
    expect(src).toMatch(/remoteToken = \(\) => identity\.bearerToken\(\);/);
    expect(src).toMatch(/remoteLogin = \(\) => identity\.currentLogin\(\);/);
    expect(src).toMatch(/login: \(\) => remoteLogin\(\),/);
    const preload = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8');
    expect(preload).not.toMatch(/bearerToken|remoteToken|packagesToken/);
    expect(readFileSync(new URL('./identityIpc.ts', import.meta.url), 'utf8')).not.toMatch(/bearerToken/);
    expect(readFileSync(new URL('./remoteIpc.ts', import.meta.url), 'utf8')).not.toMatch(/bearerToken|token\(\)/);
  });
});
