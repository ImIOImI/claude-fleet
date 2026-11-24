// `fleet-host loadouts sync`: make /workspace hold exactly the FLEET_LOADOUTS pins (SPEC §7 Pinned loadouts).
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyLoadoutFiles,
  applyLoadoutMerges,
  loadoutFileList,
  parseLoadout,
  revertLoadoutFiles,
  revertLoadoutMerges,
  runLoadoutScripts,
  type LoadoutMeta
} from '../main/loadoutCore.js';
import { isTokenShaped } from '../main/ociCore.js';
import { defaultBranch, downloadTarball, FetchError, onBranch, resolveTag, type GithubSource } from './loadoutFetch.js';
import { DEFAULT_LOADOUTS_API, parseApiBase, parsePins, parseRepo, pinTag, planSync, type Pin, type RepoRef } from './loadoutPins.js';
import { readRecord, writeRecord, type PinnedRecord, type RecordFile } from './loadoutRecord.js';
import { extractLoadout, TarError } from './loadoutTar.js';
import type { Logger } from './log.js';

export type SyncStage = 'config' | 'record' | 'token' | 'resolve' | 'download' | 'extract' | 'verify' | 'revert' | 'apply' | 'timeout';

export interface ScriptRun {
  exitCode: number;
  output: string;
}

export interface SyncOptions {
  /** FLEET_LOADOUTS, FLEET_LOADOUTS_REPO and FLEET_LOADOUTS_API. */
  env: NodeJS.ProcessEnv;
  target: string;
  log: Logger;
  token(owner: string, repo: string): Promise<string>;
  runScript(command: string, cwd: string, timeoutMs: number): Promise<ScriptRun>;
  budgetMs: number;
  stagingRoot?: string;
  /** Rejects when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface SyncSummary {
  installed: string[];
  reverted: string[];
  unchanged: string[];
  failed: string[];
}

type Applied = Pick<PinnedRecord, 'files' | 'claudeMd' | 'settingsKeys' | 'mcpServers' | 'hooks'> & { skipped: string[] };

interface Ctx {
  o: SyncOptions;
  src: GithubSource;
  branch: string;
  repoName: string;
  pinned: Set<string>;
  signal: AbortSignal;
  deadline: number;
  out: SyncSummary;
  fail(stage: SyncStage, error: string, pin?: Pin): void;
  commitRecord(id: string, rec: PinnedRecord | null): Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const label = (p: Pin): string => `${p.id}@${p.version}`;
const present = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function stageOf(e: unknown, signal: AbortSignal): SyncStage {
  if (signal.aborted) return 'timeout';
  if (e instanceof FetchError) return e.stage;
  if (e instanceof TarError) return 'extract';
  return 'verify';
}

function toRecord(pin: Pin, repo: string, commit: string, a: Applied): PinnedRecord {
  return {
    id: pin.id,
    version: pin.version,
    repo,
    commit,
    files: a.files,
    claudeMd: a.claudeMd,
    settingsKeys: a.settingsKeys,
    mcpServers: a.mcpServers,
    hooks: a.hooks,
    installedAt: Date.now()
  };
}

async function revertRecord(target: string, r: PinnedRecord): Promise<void> {
  await revertLoadoutFiles(target, { files: r.files, claudeMd: r.claudeMd }, r.id);
  await revertLoadoutMerges(target, { settingsKeys: r.settingsKeys, mcpServers: r.mcpServers, hooks: r.hooks });
}

const MERGED_FILES = [join('.claude', 'settings.json'), '.mcp.json'];

/** Contents, null if absent, undefined if unreadable (left alone on restore). */
async function snapshot(path: string): Promise<Buffer | null | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

async function restore(path: string, before: Buffer | null | undefined): Promise<void> {
  if (before === undefined) return;
  if (before === null) await rm(path, { force: true }).catch(() => undefined);
  else await writeFile(path, before).catch(() => undefined);
}

/** On failure, removes the files this apply added and its CLAUDE.md block, restores the merged files, then rethrows. */
async function applyFrom(target: string, dir: string, id: string): Promise<Applied> {
  const planned = await loadoutFileList(dir);
  const before = new Set<string>();
  for (const f of planned) if (await present(join(target, f))) before.add(f);
  const merged = await Promise.all(MERGED_FILES.map((f) => snapshot(join(target, f))));
  try {
    const files = await applyLoadoutFiles(dir, target, id);
    const merges = await applyLoadoutMerges(dir, target);
    return {
      files: files.files,
      claudeMd: files.claudeMd,
      settingsKeys: merges.settingsKeys,
      mcpServers: merges.mcpServers,
      hooks: merges.hooks,
      skipped: [...files.skipped, ...merges.skipped]
    };
  } catch (e) {
    // Per file: one unremovable path (e.g. under a file where a directory should be) mustn't stop the rest.
    for (const f of planned) {
      if (f !== 'CLAUDE.md' && !before.has(f)) await rm(join(target, f), { force: true }).catch(() => undefined);
    }
    if (planned.includes('CLAUDE.md')) await revertLoadoutFiles(target, { files: [], claudeMd: true }, id).catch(() => undefined);
    for (const [i, f] of MERGED_FILES.entries()) await restore(join(target, f), merged[i]);
    throw e;
  }
}

async function fetchInto(ctx: Ctx, id: string, commit: string, dir: string): Promise<void> {
  await extractLoadout(await downloadTarball(ctx.src, commit, ctx.signal), id, dir);
}

function dependencyIds(meta: LoadoutMeta): string[] {
  const raw: unknown = meta.dependencies?.loadouts;
  const deps = Array.isArray(raw) ? (raw as unknown[]) : [];
  return deps.flatMap((d) => {
    if (typeof d === 'string') return [d];
    const id = d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

async function notices(ctx: Ctx, id: string, meta: LoadoutMeta, dir: string): Promise<void> {
  for (const dependency of dependencyIds(meta)) {
    if (!ctx.pinned.has(dependency)) ctx.o.log.log('warn', 'loadout dependency not pinned', { id, dependency });
  }
  if (await present(join(dir, 'automations'))) {
    ctx.o.log.log('info', 'loadout automations not installed', { id, reason: 'remote automations come from the host config' });
  }
}

async function runScripts(ctx: Ctx, id: string, dir: string, meta: LoadoutMeta): Promise<void> {
  const results = await runLoadoutScripts(dir, meta.scripts, async (command) => {
    const left = ctx.deadline - Date.now();
    if (left <= 0) return { exitCode: -1, output: 'the sync ran out of time' };
    return ctx.o.runScript(command, ctx.o.target, left);
  });
  for (const r of results) {
    if (r.status === 'failed') {
      ctx.o.log.log('warn', 'loadout script failed', { id, label: r.label, exitCode: r.exitCode, output: (r.output ?? '').slice(-500) });
    } else {
      ctx.o.log.log('info', 'loadout script', { id, label: r.label, status: r.status });
    }
  }
}

async function rollback(ctx: Ctx, previous: PinnedRecord): Promise<void> {
  if (previous.repo.toLowerCase() !== ctx.repoName.toLowerCase()) {
    await ctx.commitRecord(previous.id, null);
    ctx.o.log.log('error', 'loadout rollback failed', { id: previous.id, version: previous.version, error: 'previous version came from another repo' });
    return;
  }
  let dir: string | undefined;
  try {
    // The record is session-writable.
    if (!(await onBranch(ctx.src, previous.commit, ctx.branch, ctx.signal))) throw new FetchError(`resolve: commit is not on ${ctx.branch}`, 'resolve');
    dir = await mkdtemp(join(ctx.o.stagingRoot ?? tmpdir(), 'fleet-loadout-'));
    await fetchInto(ctx, previous.id, previous.commit, dir);
    const back = await applyFrom(ctx.o.target, dir, previous.id);
    await ctx.commitRecord(previous.id, toRecord(previous, previous.repo, previous.commit, back));
    ctx.o.log.log('warn', 'loadout rolled back', { id: previous.id, version: previous.version });
  } catch (e) {
    await ctx.commitRecord(previous.id, null);
    ctx.o.log.log('error', 'loadout rollback failed', { id: previous.id, version: previous.version, error: errText(e) });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installPin(ctx: Ctx, pin: Pin, previous: PinnedRecord | null): Promise<void> {
  const staging = await mkdtemp(join(ctx.o.stagingRoot ?? tmpdir(), 'fleet-loadout-'));
  try {
    let commit: string;
    let meta: LoadoutMeta;
    try {
      commit = await resolveTag(ctx.src, pinTag(pin), ctx.branch, ctx.signal);
      await fetchInto(ctx, pin.id, commit, staging);
      meta = await parseLoadout(staging, pin.id);
    } catch (e) {
      return ctx.fail(stageOf(e, ctx.signal), errText(e), pin);
    }
    if (meta.version !== pin.version) return ctx.fail('verify', `loadout.md version is ${meta.version ?? 'unset'}, not ${pin.version}`, pin);
    if (previous) {
      try {
        await revertRecord(ctx.o.target, previous);
      } catch (e) {
        return ctx.fail('revert', errText(e), pin);
      }
    }
    let applied: Applied;
    try {
      applied = await applyFrom(ctx.o.target, staging, pin.id);
    } catch (e) {
      ctx.fail('apply', errText(e), pin);
      if (previous) await rollback(ctx, previous);
      return;
    }
    await ctx.commitRecord(pin.id, toRecord(pin, ctx.repoName, commit, applied));
    ctx.out.installed.push(label(pin));
    ctx.o.log.log('info', 'loadout installed', { id: pin.id, version: pin.version, commit, files: applied.files.length, skipped: applied.skipped });
    await notices(ctx, pin.id, meta, staging);
    await runScripts(ctx, pin.id, staging, meta);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('timed out'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      }
    );
  });
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5_000;

/** A standby or restarting credential server; a 4xx is final. */
function retryableCredError(e: unknown): boolean {
  const { status, code } = (e ?? {}) as { status?: unknown; code?: unknown };
  return status === 503 || code === 'ECONNREFUSED' || code === 'ECONNRESET';
}

async function tokenWithRetry(o: SyncOptions, repo: RepoRef, signal: AbortSignal, deadline: number): Promise<string> {
  const sleep = o.sleep ?? ((ms: number, s: AbortSignal) => delay(ms, undefined, { signal: s }));
  for (let attempt = 1; ; attempt++) {
    try {
      return await untilAborted(o.token(repo.owner, repo.repo), signal);
    } catch (e) {
      const wait = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      if (signal.aborted || !retryableCredError(e) || wait >= deadline - Date.now()) throw e;
      o.log.log('info', 'loadout sync token retry', { attempt, delayMs: wait, error: errText(e) });
      await sleep(wait, signal);
    }
  }
}

export async function syncLoadouts(o: SyncOptions): Promise<SyncSummary> {
  const started = Date.now();
  const deadline = started + o.budgetMs;
  const out: SyncSummary = { installed: [], reverted: [], unchanged: [], failed: [] };
  const fail = (stage: SyncStage, error: string, pin?: Pin): void => {
    if (pin) out.failed.push(label(pin));
    o.log.log('error', 'loadout sync failed', { stage, ...(pin ? { id: pin.id, version: pin.version } : {}), error });
  };
  const finish = (): SyncSummary => {
    o.log.log('info', 'loadout sync done', { ...out, ms: Date.now() - started });
    return out;
  };

  let pins: Pin[];
  let repo: RepoRef;
  let api: string;
  try {
    pins = parsePins(o.env.FLEET_LOADOUTS);
    repo = parseRepo(o.env.FLEET_LOADOUTS_REPO);
    api = parseApiBase(o.env.FLEET_LOADOUTS_API);
  } catch (e) {
    fail('config', errText(e));
    return finish();
  }
  let record: RecordFile;
  try {
    record = await readRecord(o.target);
  } catch (e) {
    fail('record', errText(e));
    return finish();
  }
  if (api !== DEFAULT_LOADOUTS_API) o.log.log('warn', 'loadout sync uses a non-default API', { api });

  const commitRecord = async (id: string, rec: PinnedRecord | null): Promise<void> => {
    record = { version: 1, loadouts: [...record.loadouts.filter((x) => x.id !== id), ...(rec ? [rec] : [])] };
    try {
      await writeRecord(o.target, record);
    } catch (e) {
      o.log.log('error', 'loadout sync failed', { stage: 'record', id, error: errText(e) });
    }
  };

  const plan = planSync(pins, repo, record.loadouts);
  for (const r of plan.unchanged) out.unchanged.push(label(r));
  for (const r of plan.revert) {
    try {
      await revertRecord(o.target, r);
    } catch (e) {
      fail('revert', errText(e), r);
      continue;
    }
    await commitRecord(r.id, null);
    out.reverted.push(label(r));
    o.log.log('info', 'loadout reverted', { id: r.id, version: r.version });
  }
  if (plan.install.length === 0) return finish();

  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let src: GithubSource;
  let branch: string;
  try {
    const token = await tokenWithRetry(o, repo, signal, deadline);
    if (!isTokenShaped(token)) throw new Error('the credential server returned a malformed token');
    src = { api, owner: repo.owner, repo: repo.repo, token };
    branch = await defaultBranch(src, signal);
  } catch (e) {
    const stage: SyncStage = signal.aborted ? 'timeout' : e instanceof FetchError ? e.stage : 'token';
    for (const { pin } of plan.install) fail(stage, errText(e), pin);
    return finish();
  }
  const ctx: Ctx = {
    o,
    src,
    branch,
    repoName: `${repo.owner}/${repo.repo}`,
    pinned: new Set(pins.map((p) => p.id)),
    signal,
    deadline,
    out,
    fail,
    commitRecord
  };
  for (const { pin, previous } of plan.install) {
    if (signal.aborted) fail('timeout', 'the sync ran out of time', pin);
    else {
      try {
        await installPin(ctx, pin, previous);
      } catch (e) {
        fail(stageOf(e, signal), errText(e), pin);
      }
    }
  }
  return finish();
}
