// registerIpc pulls in dockerode, better-sqlite3 and the broker client, so the
// remote routing is asserted by source text (as ipcWorkspaceIdGuard.test does).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8');

function handlerSource(channel: string): string {
  const start = src.indexOf(`'${channel}'`);
  if (start < 0) throw new Error(`ipc.ts: no registration for ${channel}`);
  const next = src.indexOf('ipcMain.handle(', start);
  return src.slice(start, next > 0 ? next : src.length);
}

const before = (body: string, a: string, b: string): boolean => body.includes(a) && body.includes(b) && body.indexOf(a) < body.indexOf(b);

describe('ipc.ts federation wiring', () => {
  it('routes a remote id to its host before any local read or start', () => {
    expect(before(handlerSource('observability:summaryForWorkspace'), 'remoteBackend.isRemote(workspaceId) ? ((await federated.summary(workspaceId, null)) ?? null)', 'summaryForWorkspace(workspaceId)')).toBe(true);
    expect(before(handlerSource('observability:summaryForBrokerSession'), 'if (remoteBackend.isRemote(workspaceId)) return (await federated.summary(workspaceId, null)) ?? null;', 'summaryForBrokerSession(workspaceId')).toBe(true);
    expect(before(handlerSource('sessions:resume'), 'if (remoteBackend.isRemote(workspaceId)) return { containerId: workspaceId };', '.startWorkspace(workspaceId)')).toBe(true);
  });

  it('refuses to delete a session under a remote workspace id', () => {
    expect(before(handlerSource('sessions:delete'), 'if (remoteBackend.isRemote(workspaceId)) return;', 'await deleteSession(sessionId);')).toBe(true);
  });

  it('registers sessions:listRemote, reads no sources in mock mode, and stops the relay on quit', () => {
    expect(src).toContain('registerFederationIpc(ipcMain, federated, localSearch);');
    expect(src.match(/sources: \(\) => \(MOCK_MODE \? \[\] : remoteBackend\.sources\(\)\)/g)).toHaveLength(2);
    const stop = src.slice(src.indexOf('export function stopRemoteBackend'), src.indexOf('remoteBackend.stop();'));
    expect(stop).toContain('summaryRelay.stop();');
    expect(stop).toContain('clearInterval(relayTimer)');
  });

  it('history:search embeds with the indexer\'s embedder and searches local manifests only', () => {
    const local = src.slice(src.indexOf('const localSearch: LocalSearch'), src.indexOf('registerFederationIpc(ipcMain'));
    expect(src).toContain("const localManifests = async () => (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote');");
    expect(local).toContain('embed: async (q) => (fedEmbed ? ((await fedEmbed([q]))[0] ?? null) : null)');
    expect(local).toContain('localIds: async () => new Set((await localManifests()).map((m) => m.id))');
    expect(local).toContain("const ids = scope === 'all' ? [...names.keys()] : [scope];");
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(before(index, 'setQueryEmbedder(embedFn);', 'setFederatedEmbedder(embedFn);')).toBe(true);
  });
});
