// Writes/removes the automations workspace's role brief (roleBriefCore.ts) in
// its /workspace/CLAUDE.md, via the host side of the bind mount — so it works
// whether or not the container is running. Writes only when the text changed.

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fleetPrivateDir } from '../config.js';
import { readWorkspaceManifest } from '../workspaces.js';
import { listSources } from '../loadoutSources.js';
import { TOOLS } from '../mcpServer.js';
import { appVersionString } from '../appVersion.js';
import { renderRoleBrief, spliceRoleBrief } from './roleBriefCore.js';

async function update(workspaceId: string, block: string | null): Promise<void> {
  const file = join(await fleetPrivateDir(workspaceId), 'CLAUDE.md');
  const prior = await readFile(file, 'utf8').catch(() => null);
  const next = spliceRoleBrief(prior ?? '', block);
  if (next === (prior ?? '')) return;
  if (next === '') {
    await rm(file, { force: true });
    return;
  }
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, next, 'utf8');
}

/** (Re)write the brief into a container workspace that holds the automations role. */
export async function writeRoleBrief(workspaceId: string): Promise<void> {
  const ws = await readWorkspaceManifest(workspaceId);
  if (!ws || ws.kind !== 'container' || ws.role !== 'automations') return;
  const block = renderRoleBrief({
    appVersion: appVersionString(),
    workspaceId: ws.id,
    workspaceName: ws.name,
    image: ws.image,
    authMode: ws.authMode,
    installedLoadouts: (ws.installedLoadouts ?? []).map((l) => ({ id: l.id, title: l.title })),
    sources: await listSources().catch(() => []),
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description }))
  });
  await update(workspaceId, block);
}

/** Strip the brief from a workspace that no longer holds the role. */
export async function removeRoleBrief(workspaceId: string): Promise<void> {
  const ws = await readWorkspaceManifest(workspaceId);
  if (!ws || ws.kind !== 'container') return;
  await update(workspaceId, null);
}
