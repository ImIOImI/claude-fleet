import { stat, mkdir } from 'node:fs/promises';

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function mkdirp(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
