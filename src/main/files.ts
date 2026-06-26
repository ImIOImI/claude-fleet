// Drag-and-drop file ingestion.
//
// Drops (OS files, pasted images, dragged web content, dragged text) are
// saved into the selected workspace's private folder under `_dropped/`, so
// the in-container agent can read them at `/workspace/_dropped/<name>`. The
// renderer routes every drop to the currently-selected workspace and shows
// the returned container path in a toast (and on the clipboard) for the user
// to paste into their prompt.
//
// Host layout: `<fleetRoot>/<id>/_dropped/`. The dir gets a `.gitignore`
// containing `*` so drops never get committed regardless of the repo's root
// ignore rules. These functions touch only the host filesystem (+ a network
// fetch for URL drops) — no Docker — so they run identically in mock mode.
//
// Caps: a single file is capped at MAX_FILE_BYTES and the whole dropbox at
// MAX_DROPBOX_BYTES. Overflow is REJECTED with a clear message (no eviction)
// so a drop never silently destroys earlier drops the agent may still need.

import { access, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fleetPrivateDir } from './config.js';
import {
  candidateName,
  extFromMime,
  fileStamp,
  filenameFromDisposition,
  sniffExtension,
  splitName
} from './dropNaming.js';

// Re-export the pure helpers so existing importers (and tests via dropNaming)
// have one surface; the implementations live in the electron-free module.
export { sniffExtension, extFromMime, splitName, candidateName, fileStamp, filenameFromDisposition };

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file
export const MAX_DROPBOX_BYTES = 1024 * 1024 * 1024; // 1 GB per workspace dropbox

const DROPBOX_DIRNAME = '_dropped';
const CONTAINER_DROPBOX = '/workspace/_dropped';
// Hard ceiling on a URL fetch before we give up (separate from a stalled
// connection — that's handled by the no-progress idle timeout in fetchUrl).
const URL_FETCH_TIMEOUT_MS = 20_000;

export interface DropBytesPayload {
  suggestedName?: string;
  mime?: string;
  bytes: Uint8Array;
}
export interface DropTextPayload {
  mime: 'text/plain' | 'text/html';
  text: string;
}

function containerPath(name: string): string {
  return `${CONTAINER_DROPBOX}/${name}`;
}

// ── Filesystem-backed helpers ───────────────────────────────────────────

async function ensureDropbox(workspaceId: string): Promise<string> {
  const dir = join(await fleetPrivateDir(workspaceId), DROPBOX_DIRNAME);
  await mkdir(dir, { recursive: true });
  // Keep the dropbox out of git regardless of the consumer repo's rules.
  const gitignore = join(dir, '.gitignore');
  try {
    await access(gitignore);
  } catch {
    await writeFile(gitignore, '*\n', 'utf8');
  }
  return dir;
}

/** Total bytes of dropped files (excludes the .gitignore + any subdirs). */
async function dropboxUsage(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || e.name === '.gitignore') continue;
    total += (await stat(join(dir, e.name))).size;
  }
  return total;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** First non-colliding name in `dir` derived from `desired`. */
async function uniqueName(dir: string, desired: string): Promise<string> {
  const { stem, ext } = splitName(desired);
  for (let n = 1; ; n++) {
    const candidate = candidateName(stem, ext, n);
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
}

function tooLargeError(label: string): Error {
  return new Error(`${label} is larger than the ${fmtMb(MAX_FILE_BYTES)} per-file limit.`);
}
function dropboxFullError(): Error {
  return new Error(`Dropbox is full (${fmtMb(MAX_DROPBOX_BYTES)} max). Remove some files in _dropped/ and retry.`);
}
function fmtMb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${bytes / 1024 / 1024 / 1024} GB` : `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Save raw bytes under `desiredName` (collision-suffixed), enforcing caps. */
async function saveBytes(
  workspaceId: string,
  desiredName: string,
  bytes: Uint8Array
): Promise<string> {
  if (bytes.length > MAX_FILE_BYTES) throw tooLargeError(desiredName);
  const dir = await ensureDropbox(workspaceId);
  if ((await dropboxUsage(dir)) + bytes.length > MAX_DROPBOX_BYTES) throw dropboxFullError();
  const name = await uniqueName(dir, desiredName);
  await writeFile(join(dir, name), bytes);
  return containerPath(name);
}

// ── Drop entry points (one per source) ──────────────────────────────────

/** OS file drag (Explorer/Finder/Nautilus). Caps validated across the whole
 *  drop before any copy, so a partial over-limit batch writes nothing. */
export async function dropOsFiles(workspaceId: string, sourcePaths: string[]): Promise<string[]> {
  if (sourcePaths.length === 0) return [];
  const dir = await ensureDropbox(workspaceId);
  const stats = await Promise.all(sourcePaths.map((p) => stat(p)));
  let incoming = 0;
  for (let i = 0; i < stats.length; i++) {
    if (!stats[i].isFile()) throw new Error(`${basename(sourcePaths[i])} is not a file.`);
    if (stats[i].size > MAX_FILE_BYTES) throw tooLargeError(basename(sourcePaths[i]));
    incoming += stats[i].size;
  }
  if ((await dropboxUsage(dir)) + incoming > MAX_DROPBOX_BYTES) throw dropboxFullError();

  const saved: string[] = [];
  for (const src of sourcePaths) {
    const name = await uniqueName(dir, basename(src));
    await copyFile(src, join(dir, name));
    saved.push(containerPath(name));
  }
  return saved;
}

/** Clipboard image paste / inline web bytes. */
export async function dropBytes(workspaceId: string, payload: DropBytesPayload): Promise<string> {
  const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload.bytes);
  let name = payload.suggestedName?.trim();
  if (!name || !extname(name)) {
    const ext = sniffExtension(bytes) ?? extFromMime(payload.mime) ?? '';
    name = name ? `${name}${ext}` : `paste-${fileStamp(new Date())}${ext}`;
  }
  return saveBytes(workspaceId, name, bytes);
}

/** Dragged-in selected text / HTML. */
export async function dropText(workspaceId: string, payload: DropTextPayload): Promise<string> {
  const ext = payload.mime === 'text/html' ? '.html' : '.txt';
  return saveBytes(workspaceId, `dropped-${fileStamp(new Date())}${ext}`, Buffer.from(payload.text, 'utf8'));
}

/** Web-content drag: fetch the URL in main and save the body. */
export async function dropUrl(workspaceId: string, url: string): Promise<string> {
  const { bytes, filename, contentType } = await fetchUrl(url);
  let name = filename?.trim();
  if (!name || !extname(name)) {
    const ext = sniffExtension(bytes) ?? extFromMime(contentType ?? undefined) ?? '';
    name = name ? `${name}${ext}` : `web-${fileStamp(new Date())}${ext}`;
  }
  return saveBytes(workspaceId, name, bytes);
}

async function fetchUrl(
  url: string
): Promise<{ bytes: Uint8Array; filename: string | null; contentType: string | null }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Couldn't fetch ${url} (HTTP ${res.status}).`);

    const contentType = res.headers.get('content-type');
    // Reject early when the server declares an over-limit size.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw tooLargeError(url);

    // Stream so we can abort a body that exceeds the cap even when the server
    // didn't declare content-length.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_FILE_BYTES) {
            await reader.cancel();
            throw tooLargeError(url);
          }
          chunks.push(value);
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      total = buf.length;
      if (total > MAX_FILE_BYTES) throw tooLargeError(url);
      chunks.push(buf);
    }

    const bytes = concat(chunks, total);
    return {
      bytes,
      filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? urlBasename(parsed),
      contentType
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Fetching ${url} timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s.`);
    }
    if (err instanceof TypeError) {
      // fetch throws TypeError for network/DNS/CORS-ish failures.
      throw new Error(`Couldn't reach ${url}: ${err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function urlBasename(parsed: URL): string | null {
  const base = basename(parsed.pathname);
  return base && base !== '/' ? decodeURIComponent(base) : null;
}
