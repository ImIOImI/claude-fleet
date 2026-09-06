// Pure discovery helper for the qwen→fleet transcript sidecar.
//
// Scans a qwen projects root (e.g. /home/fleet/.qwen/projects) and returns
// all <sid>.jsonl files reachable under any immediate subdirectory's `chats/`
// folder. This lets the sidecar discover the correct project dir without
// assuming the sanitized CWD name — if qwen's encodeProjectDir rule differs
// from claude's, discovery still finds the files.
//
// Pure and synchronous so it can be unit-tested without spawning a process.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Return an array of absolute paths to every `*.jsonl` file found under
 * `<projectsRoot>/<anySubdir>/chats/`. Subdirectories with no `chats/`
 * child are silently skipped.
 *
 * @param {string} projectsRoot  e.g. /home/fleet/.qwen/projects
 * @returns {string[]}           absolute paths — may be empty
 */
export function listChatsFiles(projectsRoot) {
  let subdirs;
  try {
    subdirs = readdirSync(projectsRoot);
  } catch {
    return []; // projects root doesn't exist yet — caller retries later
  }

  const results = [];
  for (const sub of subdirs) {
    const chatsDir = join(projectsRoot, sub, 'chats');
    let entries;
    try {
      const st = statSync(chatsDir);
      if (!st.isDirectory()) continue;
      entries = readdirSync(chatsDir);
    } catch {
      continue; // no chats/ under this subdir — skip silently
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) {
        results.push(join(chatsDir, name));
      }
    }
  }
  return results;
}

/**
 * Return the set of unique `chats/` directories under `projectsRoot`.
 * Used by the sidecar to know which directories to `fs.watch`.
 *
 * @param {string} projectsRoot
 * @returns {string[]}  absolute paths to existing `chats/` dirs
 */
export function listChatsDirs(projectsRoot) {
  let subdirs;
  try {
    subdirs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  const dirs = [];
  for (const sub of subdirs) {
    const chatsDir = join(projectsRoot, sub, 'chats');
    try {
      const st = statSync(chatsDir);
      if (st.isDirectory()) dirs.push(chatsDir);
    } catch {
      // skip
    }
  }
  return dirs;
}
