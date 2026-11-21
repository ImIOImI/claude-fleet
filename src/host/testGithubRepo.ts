// Fake GitHub REST API for the pinned-loadout sync (not shipped): repository, tag refs, annotated tags,
// compare and tarball → codeload redirects. Codeload answers 400 if it receives an Authorization header.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTarGz, type TarSpec } from './testTar.js';

export type FakeFile = string | Omit<TarSpec, 'path'>;

export interface FakeTag {
  commit: string;
  /** Repo-relative paths, e.g. loadouts/demo/loadout.md. */
  files: Record<string, FakeFile>;
  annotated?: boolean;
  /** false: compare answers `diverged`. */
  onMain?: boolean;
}

export interface FakeGithubRepo {
  url: string;
  token: string;
  tags: Map<string, FakeTag>;
  requests: { method: string; path: string; auth: string | null }[];
  failTarball: Set<string>;
  hangTarball: boolean;
  location: ((commit: string) => string) | null;
  close(): Promise<void>;
}

export const sha = (n: number): string => n.toString(16).padStart(40, '0');
export const annotatedSha = (commit: string): string => `e${commit.slice(1)}`;

export function loadoutFiles(id: string, version: string, extra: Record<string, FakeFile> = {}): Record<string, FakeFile> {
  return {
    [`loadouts/${id}/loadout.md`]: `---\ntitle: ${id}\ndescription: test loadout\nversion: ${version}\n---\nInstall ${id}.\n`,
    [`loadouts/${id}/skills/${id}/SKILL.md`]: `---\nname: ${id}\ndescription: ${id} ${version}\n---\n${id} ${version}\n`,
    ...extra
  };
}

export async function startFakeGithubRepo(o: { owner: string; repo: string }): Promise<FakeGithubRepo> {
  const base = `/repos/${o.owner}/${o.repo}`;
  const fake: FakeGithubRepo = {
    url: '',
    token: `ghs_${'t'.repeat(36)}`,
    tags: new Map(),
    requests: [],
    failTarball: new Set(),
    hangTarball: false,
    location: null,
    close: async () => undefined
  };
  const byCommit = (c: string): FakeTag | undefined => [...fake.tags.values()].find((t) => t.commit === c);
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    fake.requests.push({ method: req.method ?? '', path, auth });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith('/bounce/')) return send(302, {}, { location: `${fake.url}/codeload/${path.slice('/bounce/'.length)}` });
    if (path.startsWith('/codeload/')) {
      if (auth) return send(400, { message: 'Authorization sent to codeload' });
      const commit = path.slice('/codeload/'.length);
      const tag = byCommit(commit);
      if (!tag) return send(404, { message: 'Not Found' });
      if (fake.hangTarball) return;
      if (fake.failTarball.has(commit)) return send(500, { message: 'Server Error' });
      const root = `${o.owner}-${o.repo}-${commit.slice(0, 7)}`;
      const entries: TarSpec[] = [{ path: `${root}/`, type: '5' }];
      for (const [p, f] of Object.entries(tag.files)) entries.push(typeof f === 'string' ? { path: `${root}/${p}`, body: f } : { ...f, path: `${root}/${p}` });
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      res.end(buildTarGz(entries));
      return;
    }
    if (auth !== `Bearer ${fake.token}`) return send(401, { message: 'Bad credentials' });
    if (path === base) return send(200, { default_branch: 'main' });
    if (path.startsWith(`${base}/git/ref/tags/`)) {
      const name = decodeURIComponent(path.slice(`${base}/git/ref/tags/`.length));
      const tag = fake.tags.get(name);
      if (!tag) return send(404, { message: 'Not Found' });
      const object = tag.annotated ? { type: 'tag', sha: annotatedSha(tag.commit) } : { type: 'commit', sha: tag.commit };
      return send(200, { ref: `refs/tags/${name}`, object });
    }
    if (path.startsWith(`${base}/git/tags/`)) {
      const s = path.slice(`${base}/git/tags/`.length);
      const tag = [...fake.tags.values()].find((t) => t.annotated && annotatedSha(t.commit) === s);
      return tag ? send(200, { object: { type: 'commit', sha: tag.commit } }) : send(404, { message: 'Not Found' });
    }
    const rest = path.startsWith(`${base}/`) ? path.slice(base.length) : '';
    const cmp = /^\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(rest);
    if (cmp) {
      const tag = byCommit(cmp[1]);
      return tag ? send(200, { status: tag.onMain === false ? 'diverged' : 'ahead' }) : send(404, { message: 'Not Found' });
    }
    const tb = /^\/tarball\/([0-9a-f]{40})$/.exec(rest);
    if (tb) {
      if (!byCommit(tb[1])) return send(404, { message: 'Not Found' });
      return send(302, {}, { location: fake.location ? fake.location(tb[1]) : `${fake.url}/codeload/${tb[1]}?token=codeload-only` });
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
