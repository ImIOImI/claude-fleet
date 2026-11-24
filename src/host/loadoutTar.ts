// One loadout out of a GitHub tarball (`git archive`, gzip): regular files and directories only, capped, confined.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MAX_BLOB_BYTES, safeLayerPath } from '../main/ociCore.js';

export interface TarLimits {
  /** Compressed download. */
  tarball: number;
  /** Decompressed archive: the whole repo. */
  tar: number;
  file: number;
  /** One loadout's files together. */
  total: number;
  files: number;
}

export const TAR_LIMITS: Readonly<TarLimits> = Object.freeze({
  tarball: 25 * 1024 * 1024,
  tar: 100 * 1024 * 1024,
  file: MAX_BLOB_BYTES,
  total: 20 * 1024 * 1024,
  files: 1000
});

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface TarEntry {
  path: string;
  type: string;
  mode: number;
  data: Buffer;
}

const LINK_KINDS: Record<string, string> = { '1': 'hardlink', '2': 'symlink' };

function octal(h: Buffer, off: number, len: number, what: string): number {
  const f = h.subarray(off, off + len);
  if (f[0] & 0x80) throw new TarError(`${what}: base-256 numbers are not supported`);
  const z = f.indexOf(0);
  const s = (z === -1 ? f : f.subarray(0, z)).toString('latin1').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`${what} is not octal`);
  return parseInt(s, 8);
}

function cstr(h: Buffer, off: number, len: number): string {
  const f = h.subarray(off, off + len);
  const z = f.indexOf(0);
  return (z === -1 ? f : f.subarray(0, z)).toString('utf8');
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === octal(h, 148, 8, 'checksum');
}

function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const len = sp === -1 ? NaN : Number(data.subarray(i, sp).toString('latin1'));
    if (!Number.isInteger(len) || len <= sp - i + 1 || i + len > data.length) throw new TarError('bad pax record');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') path = rec.slice(eq + 1);
    i += len;
  }
  return path;
}

/** Entries in order; a pax `x` path applies to the next entry and `g` headers are skipped. */
export function* tarEntries(tar: Buffer): Generator<TarEntry> {
  let off = 0;
  let paxNext: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    if (!checksumOk(h)) throw new TarError('bad header checksum');
    const size = octal(h, 124, 12, 'size');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const start = off + 512;
    if (start + size > tar.length) throw new TarError('truncated archive');
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      paxNext = paxPath(data);
      continue;
    }
    if (type === 'L' || type === 'K') throw new TarError('GNU long names are not supported');
    const name = cstr(h, 0, 100);
    const prefix = h.subarray(257, 263).toString('latin1') === 'ustar\0' ? cstr(h, 345, 155) : '';
    yield { path: paxNext ?? (prefix ? `${prefix}/${name}` : name), type, mode: octal(h, 100, 8, 'mode'), data };
    paxNext = null;
  }
  throw new TarError('truncated archive');
}

/** Writes `loadouts/<id>/` into destDir only after the whole archive passed; returns the loadout-relative files. */
export async function extractLoadout(tgz: Buffer, id: string, destDir: string, limits: TarLimits = TAR_LIMITS): Promise<string[]> {
  if (tgz.length > limits.tarball) throw new TarError(`tarball is over ${limits.tarball} bytes`);
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: limits.tar });
  } catch (e) {
    throw new TarError((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? `archive is over ${limits.tar} bytes` : 'not a gzip archive');
  }
  const scope = `loadouts/${id}/`;
  const writes: { target: string; data: Buffer; mode: number }[] = [];
  const seen = new Set<string>();
  const dest = resolve(destDir);
  let root: string | null = null;
  let total = 0;
  for (const e of tarEntries(tar)) {
    const slash = e.path.indexOf('/');
    const top = slash === -1 ? e.path : e.path.slice(0, slash);
    root ??= top;
    if (top !== root) throw new TarError('archive has more than one top-level directory');
    const rel = slash === -1 ? '' : e.path.slice(slash + 1);
    if (!rel.startsWith(scope) || e.type === '5') continue;
    if (e.type !== '0') throw new TarError(`${LINK_KINDS[e.type] ?? `entry type ${JSON.stringify(e.type)}`} at ${rel} is not allowed`);
    const inner = rel.slice(scope.length);
    let target: string;
    let key: string;
    try {
      if (inner.includes('\0')) throw new Error('NUL');
      target = safeLayerPath(destDir, inner);
      // Keyed by the resolved path, so `./x` and `x` collide here rather than at write time.
      key = relative(dest, target).split(sep).join('/');
      if (key === '') throw new Error('root');
    } catch {
      throw new TarError(`unsafe path ${rel}`);
    }
    if (seen.has(key)) throw new TarError(`duplicate entry ${rel}`);
    seen.add(key);
    if (seen.size > limits.files) throw new TarError(`loadouts/${id} has more than ${limits.files} files`);
    if (e.data.length > limits.file) throw new TarError(`${rel} is over ${limits.file} bytes`);
    total += e.data.length;
    if (total > limits.total) throw new TarError(`loadouts/${id} is over ${limits.total} bytes`);
    writes.push({ target, data: e.data, mode: e.mode & 0o111 ? 0o755 : 0o644 });
  }
  if (!seen.has('loadout.md')) throw new TarError(`loadouts/${id}/loadout.md is not in the archive`);
  for (const f of seen) {
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) {
      if (seen.has(f.slice(0, i))) throw new TarError(`${f.slice(0, i)} is both a file and a directory`);
    }
  }
  for (const w of writes) {
    await mkdir(dirname(w.target), { recursive: true });
    await writeFile(w.target, w.data, { mode: w.mode, flag: 'wx' });
  }
  return [...seen].sort();
}
