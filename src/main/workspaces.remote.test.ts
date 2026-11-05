import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));
vi.mock('./errorLog.js', () => ({ logError: () => undefined }));

const { sanitizeRemote, readWorkspaceManifest, writeWorkspaceManifest, listWorkspaceManifests } = await import('./workspaces.js');
const { workspaceManifestPath, stateRoot } = await import('./paths.js');

const ID = '01JC0000000000000000000000';
const base = (id: string, extra: Record<string, unknown>) => ({
  id, name: 'n', labels: [], workspaceRoot: '', workspaceSubdir: '', authMode: 'oauth',
  env: { plain: {}, secretKeys: [] }, createdAt: 1, lastUsedAt: 1, ...extra
});

describe('sanitizeRemote', () => {
  it('keeps a well-formed bookmark and drops unknown tiers', () => {
    expect(sanitizeRemote({ url: 'https://h', tier: 'steer', login: 'a', checkedAt: 3, extra: 1 })).toEqual({ url: 'https://h', tier: 'steer', login: 'a', checkedAt: 3 });
    expect(sanitizeRemote({ url: 'http://h:8080', tier: 'admin' })).toEqual({ url: 'http://h:8080', tier: null, login: null, checkedAt: 0 });
  });

  it.each(['a b', 'x\u202ey', '<img>', 'a'.repeat(40), 7])('drops a stored login that is not a GitHub login: %j', (login) => {
    expect(sanitizeRemote({ url: 'https://h', tier: 'read', login })?.login).toBeNull();
    expect(sanitizeRemote({ url: 'https://h', tier: 'read', login: 'ci[bot]' })?.login).toBe('ci[bot]');
  });

  it('rejects a bookmark without an http(s) URL', () => {
    expect(sanitizeRemote(undefined)).toBeUndefined();
    expect(sanitizeRemote({ url: 'file:///etc/passwd' })).toBeUndefined();
    expect(sanitizeRemote({ tier: 'read' })).toBeUndefined();
  });

  it('rejects a non-canonical URL rather than storing it', () => {
    expect(sanitizeRemote({ url: 'https://u:p@h' })).toBeUndefined();
    expect(sanitizeRemote({ url: 'https://h/?x' })).toBeUndefined();
    expect(sanitizeRemote({ url: 'https://h/' })).toBeUndefined();
    expect(sanitizeRemote({ url: ' https://h' })).toBeUndefined();
  });
});

describe('remote manifests on disk', () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'cf-remote-manifest-'));
  });
  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  async function put(dir: string, body: unknown): Promise<void> {
    await mkdir(join(stateRoot(), dir), { recursive: true });
    await writeFile(workspaceManifestPath(dir), JSON.stringify(body), 'utf8');
  }

  it('round-trips a bookmark', async () => {
    const remote = { url: 'https://h', tier: 'read' as const, login: 'a', checkedAt: 2 };
    await writeWorkspaceManifest(base(ID, { kind: 'remote', remote }) as never);
    expect(await readWorkspaceManifest(ID)).toMatchObject({ id: ID, kind: 'remote', remote });
  });

  it('drops a remote kind with no valid bookmark, a non-ULID id, or an id that is not its directory', async () => {
    await put(ID, base(ID, { kind: 'remote' }));
    expect(await readWorkspaceManifest(ID)).toBeNull();
    await put('notulid', base('notulid', { kind: 'remote', remote: { url: 'https://h' } }));
    expect(await readWorkspaceManifest('notulid')).toBeNull();
    const other = '01JC0000000000000000000001';
    await put(other, base(ID, { kind: 'remote', remote: { url: 'https://h' } }));
    expect(await readWorkspaceManifest(other)).toBeNull();
    expect(await listWorkspaceManifests()).toEqual([]);
  });

  it('never carries a bookmark on a non-remote kind; an unknown kind is dropped, an absent one is a container', async () => {
    await put('L', base('L', { kind: 'local', workspaceRoot: '/x', remote: { url: 'https://h' } }));
    const l = await readWorkspaceManifest('L');
    expect(l?.kind).toBe('local');
    expect(l).not.toHaveProperty('remote');
    await put('Q', base('Q', { kind: 'weird' }));
    expect(await readWorkspaceManifest('Q')).toBeNull();
    await put('C', base('C', {}));
    expect((await readWorkspaceManifest('C'))?.kind).toBe('container');
    await put('D', base('D', { kind: 'container' }));
    expect((await readWorkspaceManifest('D'))?.kind).toBe('container');
  });
});
