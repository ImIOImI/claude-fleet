// remote:* IPC: probe a host URL, bookmark it, rename the bookmark locally.
// Forget is workspace:remove (the remote backend deletes the bookmark).
// Every reply is built field by field: no token and no unvetted host field reaches the renderer.
import type { IpcHandleLike } from './vaultIpc.js';
import type { AccountStatus } from '../preload/identityTypes.js';
import type { RemoteAddOptions, RemoteLiveSession, RemoteProbe, RemoteProbeErr, RemoteProbeOk } from '../preload/remoteTypes.js';
import type { RemoteBackend } from './remote.js';
import { RemoteError } from './remoteClient.js';
import { normalizeHostUrl, plainHttpWarning, RemoteUrlError } from './remoteUrl.js';
import { assertValidWorkspaceName } from './paths.js';
import { assertRendererWorkspaceId } from './vaultScopes.js';
import { FACTORY_MIRROR, type WorkspaceSpec } from './workspaces.js';

export const REMOTE_CHANNELS = ['remote:probe', 'remote:add', 'remote:rename', 'remote:liveSessions'] as const;

const MAX_URL_LEN = 2048;
const MAX_LIVE_SESSIONS = 1000;

export interface RemoteIpcDeps {
  backend: RemoteBackend;
  accountStatus(): Promise<AccountStatus>;
  readManifest(id: string): Promise<WorkspaceSpec | null>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  findByName(name: string): Promise<WorkspaceSpec | null>;
  invalidate(): void;
  now?: () => number;
}

function parseAddOptions(raw: unknown): RemoteAddOptions {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('remote:add options must be an object');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'sameHostNewAddress')) throw new Error('remote:add options: unknown field');
  if (o.sameHostNewAddress !== undefined && typeof o.sameHostNewAddress !== 'boolean') {
    throw new Error('remote:add options: sameHostNewAddress must be a boolean');
  }
  return o.sameHostNewAddress === true ? { sameHostNewAddress: true } : {};
}

const hueOrUndefined = (c: { hue: number } | null): { hue: number } | undefined =>
  c && Number.isFinite(c.hue) && c.hue >= 0 && c.hue <= 360 ? { hue: c.hue } : undefined;

/** For workspace:create / workspace:writeManifest: a renderer-built spec never creates, converts or edits a bookmark. */
export function assertNotRemoteSpec(incomingKind: unknown, existing: WorkspaceSpec | null): void {
  if (incomingKind === 'remote' || existing?.kind === 'remote') {
    throw new Error('Remote workspaces are added and renamed from their own form');
  }
}

export function registerRemoteIpc(ipc: IpcHandleLike, deps: RemoteIpcDeps): void {
  const now = deps.now ?? Date.now;

  async function classify(err: unknown, url: string | null): Promise<RemoteProbeErr> {
    if (err instanceof RemoteUrlError) return { ok: false, kind: 'invalid-url', message: err.message };
    if (!(err instanceof RemoteError) || url === null) return { ok: false, kind: 'protocol', message: 'Unexpected error talking to the host' };
    const message = await deps.backend.clientFor(url).redact(err.message);
    if (err.kind === 'forbidden') {
      const sso = (await deps.accountStatus().catch(() => null))?.sso;
      if (sso) {
        return {
          ok: false,
          kind: 'sso',
          message: `Authorise claude-fleet for ${sso.org ?? 'your organisation'} on GitHub (a one-time step), then try again`,
          ssoUrl: sso.url ?? sso.appSettingsUrl
        };
      }
      return { ok: false, kind: 'forbidden', message: `${message}. Ask the host's admins to add you to a team with access.` };
    }
    return { ok: false, kind: err.kind, message };
  }

  async function uniqueName(base: string, id: string): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const hit = await deps.findByName(name);
      if (!hit || hit.id === id) return name;
    }
    throw new Error(`Too many workspaces named "${base}"`);
  }

  async function probe(raw: unknown): Promise<RemoteProbe> {
    let url: string | null = null;
    try {
      if (typeof raw !== 'string' || raw.length > MAX_URL_LEN) throw new RemoteUrlError('Enter a host URL');
      url = normalizeHostUrl(raw);
      const who = await deps.backend.clientFor(url).whoami();
      const prior = await deps.readManifest(who.workspace.id);
      const priorUrl = prior?.kind === 'remote' ? prior.remote?.url ?? null : null;
      const ok: RemoteProbeOk = {
        ok: true,
        url,
        workspace: {
          id: who.workspace.id,
          name: who.workspace.name,
          description: who.workspace.description,
          color: hueOrUndefined(who.workspace.color) ?? null
        },
        user: { login: who.user.login, name: who.user.name, avatarUrl: who.user.avatarUrl },
        tier: who.tier,
        warning: plainHttpWarning(url),
        existing: prior !== null,
        existingUrl: priorUrl !== null && priorUrl !== url ? priorUrl : null
      };
      return ok;
    } catch (err) {
      return classify(err, url);
    }
  }

  ipc.handle('remote:probe', (_e, url: unknown) => probe(url));

  ipc.handle('remote:add', async (_e, url: unknown, rawOpts: unknown): Promise<RemoteProbe> => {
    const opts = parseAddOptions(rawOpts);
    const p = await probe(url);
    if (!p.ok) return p;
    const id = p.workspace.id;
    const prior = await deps.readManifest(id);
    if (prior && (prior.kind !== 'remote' || !prior.remote)) {
      return { ok: false, kind: 'clash', message: `Workspace id ${id} already belongs to a workspace on this computer` };
    }
    if (prior?.remote && prior.remote.url !== p.url && !opts.sameHostNewAddress) {
      return {
        ok: false,
        kind: 'moved',
        message: `This workspace id belongs to the remote at ${prior.remote.url}. Confirm it moved to ${p.url} to update the bookmark.`,
        existingUrl: prior.remote.url
      };
    }
    const t = now();
    const remote = { url: p.url, tier: p.tier, login: p.user.login, checkedAt: t };
    const spec: WorkspaceSpec = prior
      ? { ...prior, remote }
      : {
          id,
          name: await uniqueName(p.workspace.name || 'remote', id),
          description: p.workspace.description ?? undefined,
          labels: [],
          color: p.workspace.color ?? undefined,
          workspaceRoot: '',
          workspaceSubdir: '',
          kind: 'remote',
          authMode: 'oauth',
          env: { plain: {}, secretKeys: [] },
          mirror: { ...FACTORY_MIRROR },
          remote,
          createdAt: t,
          lastUsedAt: t
        };
    await deps.writeManifest(spec);
    deps.invalidate();
    return { ...p, existing: prior !== null, existingUrl: null };
  });

  async function bookmark(id: unknown): Promise<WorkspaceSpec & { remote: NonNullable<WorkspaceSpec['remote']> }> {
    assertRendererWorkspaceId(id);
    const m = await deps.readManifest(id);
    if (!m || m.kind !== 'remote' || !m.remote) throw new Error('Not a remote workspace');
    return m as WorkspaceSpec & { remote: NonNullable<WorkspaceSpec['remote']> };
  }

  ipc.handle('remote:liveSessions', async (_e, id: unknown): Promise<RemoteLiveSession[]> => {
    const m = await bookmark(id);
    const rows = await deps.backend.clientFor(m.remote.url).rpc<unknown>('sessions:live', []);
    if (!Array.isArray(rows)) return [];
    const out: RemoteLiveSession[] = [];
    for (const r of rows.slice(0, MAX_LIVE_SESSIONS)) {
      const o = r as { id?: unknown; alive?: unknown } | null;
      if (o && typeof o.id === 'string' && typeof o.alive === 'boolean') out.push({ id: o.id, alive: o.alive });
    }
    return out;
  });

  ipc.handle('remote:rename', async (_e, id: unknown, name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A name is required');
    const next = name.trim();
    assertValidWorkspaceName(next);
    const m = await bookmark(id);
    const clash = await deps.findByName(next);
    if (clash && clash.id !== m.id) throw new Error(`A workspace named "${next}" already exists.`);
    await deps.writeManifest({ ...m, name: next });
    deps.invalidate();
  });
}
