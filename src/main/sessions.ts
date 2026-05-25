// Per-workspace session inventory.
//
// A workspace can have multiple terminal sessions open in its main pane
// (one xterm + PTY each). Before this layer they lived only in renderer
// state, so quitting the app forgot every tab — even though the
// workspace itself (the container, the manifest) survived. This file
// persists the tab list on disk so the next launch can recreate it.
//
// Storage: <userData>/state/<name>/sessions.json. Atomic writes
// (write-to-temp + rename), same pattern as imageLibrary.ts. Reads
// tolerate a missing or malformed file by returning an empty inventory.
//
// What's NOT here: any PTY handles or live process state. Each entry is
// just a stable display id + name. In PR1 we re-spawn fresh PTYs on
// relaunch (in-memory context is lost). PR2 layers in real re-attach via
// the in-container broker — at that point sessions.json will pair with
// broker session ids to reconnect to the still-alive claude processes.
//
// Concurrency: the renderer is the only writer and writes
// read-modify-write style (api.sessions.read → mutate → api.sessions.write).
// There's no cross-process contention today; if a second writer ever
// appears, switch to fine-grained add/remove handlers in main and drop
// the whole-file write path.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { workspaceStateDir, assertValidWorkspaceName } from './paths.js';

export interface SessionEntry {
  id: string; // stable across app restarts; NOT the PTY session id (which is per-attach)
  name: string; // display name: 'main', 'session 2', 'session 3', …
  createdAt: number;
}

export interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  // Auto-increment for "session N" naming. Doesn't decrement on close
  // so a deleted session 2 doesn't get renumbered when session 3 stays.
  nextNum: number;
  // Which tab the renderer should select at attach time. Persisted so
  // quit-and-relaunch lands the user on the session they were last using.
  activeId?: string;
}

function inventoryPath(workspaceName: string): string {
  assertValidWorkspaceName(workspaceName);
  return join(workspaceStateDir(workspaceName), 'sessions.json');
}

function emptyInventory(): SessionInventory {
  return { version: 1, sessions: [], nextNum: 2 };
}

export async function readInventory(workspaceName: string): Promise<SessionInventory> {
  try {
    const raw = await readFile(inventoryPath(workspaceName), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionInventory>;
    if (!parsed || !Array.isArray(parsed.sessions)) return emptyInventory();
    const sessions = parsed.sessions.filter(
      (s): s is SessionEntry =>
        s != null &&
        typeof s === 'object' &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.createdAt === 'number'
    );
    return {
      version: 1,
      sessions,
      nextNum: typeof parsed.nextNum === 'number' && parsed.nextNum >= 2 ? parsed.nextNum : 2,
      activeId:
        typeof parsed.activeId === 'string' && sessions.some((s) => s.id === parsed.activeId)
          ? parsed.activeId
          : undefined
    };
  } catch {
    return emptyInventory();
  }
}

export async function writeInventory(
  workspaceName: string,
  inventory: SessionInventory
): Promise<void> {
  const path = inventoryPath(workspaceName);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}
