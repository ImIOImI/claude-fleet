// Image library — a growing catalog of Docker images workspaces have
// been created against, with the labels each image was built with.
//
// Auto-populated on workspace creation: every container `workspace:create`
// records the image ref + labels (queried via dockerode inspect), or
// bumps `lastUsedAt` / `useCount` if the image is already known. The
// renderer's image picker lets the user filter the library by free-text
// substring across the ref + every label key/value.
//
// Storage: a single JSON file at <userData>/imageLibrary.json. Writes
// are best-effort atomic (write-to-temp + rename). Reads tolerate a
// missing or malformed file by returning an empty library.

import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ImageEntry {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
}

function libraryPath(): string {
  return join(app.getPath('userData'), 'imageLibrary.json');
}

async function readLibrary(): Promise<ImageEntry[]> {
  try {
    const raw = await readFile(libraryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ImageEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof e.ref === 'string' &&
        typeof e.labels === 'object'
    );
  } catch {
    return [];
  }
}

async function writeLibrary(entries: ImageEntry[]): Promise<void> {
  const path = libraryPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

export async function listImages(): Promise<ImageEntry[]> {
  return readLibrary();
}

/**
 * Record (or update) an image entry. If `ref` is already in the library,
 * bumps `lastUsedAt` and `useCount`, refreshes `labels`/`digest`. Returns
 * the updated entry.
 */
export async function recordImage(input: {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
}): Promise<ImageEntry> {
  const entries = await readLibrary();
  const now = Date.now();
  const idx = entries.findIndex((e) => e.ref === input.ref);
  let updated: ImageEntry;
  if (idx >= 0) {
    updated = {
      ...entries[idx],
      digest: input.digest ?? entries[idx].digest,
      labels: input.labels,
      lastUsedAt: now,
      useCount: entries[idx].useCount + 1
    };
    entries[idx] = updated;
  } else {
    updated = {
      ref: input.ref,
      digest: input.digest,
      labels: input.labels,
      firstUsedAt: now,
      lastUsedAt: now,
      useCount: 1
    };
    entries.push(updated);
  }
  await writeLibrary(entries);
  return updated;
}

export async function removeImage(ref: string): Promise<void> {
  const entries = await readLibrary();
  const filtered = entries.filter((e) => e.ref !== ref);
  if (filtered.length !== entries.length) await writeLibrary(filtered);
}
