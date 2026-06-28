// Pure naming/sniffing helpers for drag-and-drop ingestion (files.ts).
// Kept electron-free so they're unit-testable under vitest — files.ts pulls
// in config.ts → electron, which can't load in the test runner.

import { basename, extname } from 'node:path';

/**
 * Magic-number sniff for the formats a drop realistically carries when the
 * source gave us no filename (clipboard images, web bytes). Returns the
 * dotted extension or null when unrecognized (caller saves extensionless).
 */
export function sniffExtension(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return '.gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  )
    return '.webp';
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return '.pdf'; // "%PDF"
  return null;
}

/** Fallback extension from a MIME type when bytes don't sniff. */
export function extFromMime(mime?: string): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/html': '.html'
  };
  return map[mime.split(';')[0].trim().toLowerCase()] ?? null;
}

/** `foo.png` → {stem:'foo', ext:'.png'}; `foo` → {stem:'foo', ext:''}. */
export function splitName(name: string): { stem: string; ext: string } {
  const ext = extname(name);
  return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}

/** Collision suffixing: n=1 → `foo.png`, n=2 → `foo-2.png`, … */
export function candidateName(stem: string, ext: string, n: number): string {
  return n <= 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
}

/** Filesystem-safe ISO-ish timestamp for generated names (no colons/dots). */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Parse `filename="…"` / `filename*=UTF-8''…` from Content-Disposition. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(header);
  if (star) {
    try {
      return basename(decodeURIComponent(star[1]));
    } catch {
      return basename(star[1]);
    }
  }
  const plain = /filename\s*=\s*["']?([^"';]+)["']?/i.exec(header);
  return plain ? basename(plain[1]) : null;
}
