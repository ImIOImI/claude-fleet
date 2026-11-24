// One pinned loadout from the GitHub REST API: tag → commit on the default branch → tarball (SPEC §7 Pinned loadouts).
import { isTokenShaped } from '../main/ociCore.js';
import { TAR_LIMITS } from './loadoutTar.js';

export interface GithubSource {
  /** API base without a trailing slash. */
  api: string;
  owner: string;
  repo: string;
  token: string;
}

export type FetchStage = 'resolve' | 'download';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly stage: FetchStage,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

const REQUEST_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/;

const segments = (s: string): string => s.split('/').map(encodeURIComponent).join('/');
const repoUrl = (s: GithubSource): string => `${s.api}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;

async function get(src: GithubSource, url: string, stage: FetchStage, signal: AbortSignal, withToken = true): Promise<Response> {
  if (withToken && !isTokenShaped(src.token)) throw new FetchError(`${stage}: the token is malformed`, stage);
  try {
    return await fetch(url, {
      headers: {
        ...(withToken ? { authorization: `Bearer ${src.token}` } : {}),
        accept: withToken ? 'application/vnd.github+json' : '*/*',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleet-host'
      },
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
    });
  } catch (e) {
    // Never the original message: undici can echo header values.
    const timedOut = signal.aborted || (e as Error).name === 'TimeoutError';
    throw new FetchError(`${stage}: ${timedOut ? 'timed out' : 'unreachable'} (${new URL(url).host})`, stage);
  }
}

async function json(res: Response, stage: FetchStage, what: string): Promise<Record<string, unknown>> {
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`${stage}: ${what} → HTTP ${res.status}`, stage, res.status);
  }
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new FetchError(`${stage}: ${what} is not a JSON object`, stage);
}

export async function defaultBranch(src: GithubSource, signal: AbortSignal): Promise<string> {
  const j = await json(await get(src, repoUrl(src), 'resolve', signal), 'resolve', 'repository');
  const b = j.default_branch;
  if (typeof b !== 'string' || !/^[A-Za-z0-9._/-]{1,255}$/.test(b) || b.split('/').some((x) => x === '' || x === '.' || x === '..')) throw new FetchError('resolve: the repository has no default branch', 'resolve');
  return b;
}

type GitObject = { type?: unknown; sha?: unknown } | undefined;

export async function resolveTag(src: GithubSource, tag: string, branch: string, signal: AbortSignal): Promise<string> {
  const ref = await json(await get(src, `${repoUrl(src)}/git/ref/tags/${segments(tag)}`, 'resolve', signal), 'resolve', `tag ${tag}`);
  let obj = ref.object as GitObject;
  if (obj?.type === 'tag' && typeof obj.sha === 'string' && SHA.test(obj.sha)) {
    const annotated = await json(await get(src, `${repoUrl(src)}/git/tags/${obj.sha}`, 'resolve', signal), 'resolve', `tag ${tag}`);
    obj = annotated.object as GitObject;
  }
  if (obj?.type !== 'commit' || typeof obj.sha !== 'string' || !SHA.test(obj.sha)) {
    throw new FetchError(`resolve: tag ${tag} does not point at a commit`, 'resolve');
  }
  const commit = obj.sha;
  if (!(await onBranch(src, commit, branch, signal))) throw new FetchError(`resolve: tag ${tag} is not on ${branch}`, 'resolve');
  return commit;
}

export async function onBranch(src: GithubSource, commit: string, branch: string, signal: AbortSignal): Promise<boolean> {
  if (!SHA.test(commit)) return false;
  const cmp = await json(await get(src, `${repoUrl(src)}/compare/${commit}...${segments(branch)}`, 'resolve', signal), 'resolve', `compare ${commit.slice(0, 12)}`);
  return cmp.status === 'ahead' || cmp.status === 'identical';
}

export async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`download: tarball is over ${cap} bytes`, 'download');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) {
        await reader.cancel().catch(() => undefined);
        throw new FetchError(`download: tarball is over ${cap} bytes`, 'download');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError('download: interrupted', 'download');
  }
  return Buffer.concat(chunks);
}

/** The codeload redirect carries its own short-lived token in the URL: followed once, without ours, never logged. */
export async function downloadTarball(src: GithubSource, commit: string, signal: AbortSignal, cap = TAR_LIMITS.tarball): Promise<Buffer> {
  if (!SHA.test(commit)) throw new FetchError('download: not a commit sha', 'download');
  let res = await get(src, `${repoUrl(src)}/tarball/${commit}`, 'download', signal);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    const loc = res.headers.get('location');
    let next: URL;
    try {
      if (!loc) throw new Error('no location');
      next = new URL(loc, `${src.api}/`);
    } catch {
      throw new FetchError('download: bad redirect', 'download');
    }
    if (next.protocol !== 'https:' && next.origin !== new URL(src.api).origin) throw new FetchError(`download: redirect to ${next.protocol} refused`, 'download');
    res = await get(src, next.href, 'download', signal, false);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError(`download: tarball → HTTP ${res.status}`, 'download', res.status);
  }
  return readCapped(res, cap);
}
