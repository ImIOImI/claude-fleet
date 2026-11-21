// tar.gz archives for tests, shaped like `git archive` output (pax global header, ustar entries, pax long paths).
import { gzipSync } from 'node:zlib';

export interface TarSpec {
  path: string;
  /** '0' file (default), '5' directory, '1' hardlink, '2' symlink, … */
  type?: string;
  body?: string | Buffer;
  mode?: number;
  linkname?: string;
}

function paxRecord(key: string, value: string): Buffer {
  const kv = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(kv);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return Buffer.from(`${len}${kv}`);
}

function header(name: string, size: number, type: string, mode: number, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  h.write('0001750\0', 108, 'latin1');
  h.write('0001750\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('14760000000\0', 136, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar' + '\0' + '00', 257, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

function padded(b: Buffer): Buffer[] {
  const r = b.length % 512;
  return r ? [b, Buffer.alloc(512 - r)] : [b];
}

export function buildTar(entries: TarSpec[]): Buffer {
  const global = paxRecord('comment', 'f'.repeat(40));
  const parts: Buffer[] = [header('pax_global_header', global.length, 'g', 0o666), ...padded(global)];
  for (const e of entries) {
    const type = e.type ?? '0';
    const body = typeof e.body === 'string' ? Buffer.from(e.body) : (e.body ?? Buffer.alloc(0));
    let name = e.path;
    if (Buffer.byteLength(name) > 100) {
      const rec = paxRecord('path', e.path);
      parts.push(header('PaxHeader', rec.length, 'x', 0o644), ...padded(rec));
      name = e.path.slice(0, 100);
    }
    const size = type === '0' ? body.length : 0;
    parts.push(header(name, size, type, e.mode ?? (type === '5' ? 0o755 : 0o644), e.linkname));
    if (size) parts.push(...padded(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const buildTarGz = (entries: TarSpec[]): Buffer => gzipSync(buildTar(entries));
