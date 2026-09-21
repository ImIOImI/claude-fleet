// qwen→fleet transcript sidecar — ships in the qwen runner image.
//
// Tails every <sid>.jsonl discovered under CF_QWEN_PROJECTS_DIR (the qwen
// projects root, e.g. /home/fleet/.qwen/projects), maps each complete line
// with mapQwenRecord (Task 8), and appends the claude-dialect output to the
// fleet-watched path CF_FLEET_PROJECTS_DIR/<sid>.jsonl so the host watcher
// picks it up without knowing about qwen.
//
// Discovery: instead of trusting a hardcoded project-dir name derived from
// the container cwd (which requires qwen's encodeProjectDir rule to match
// claude's exactly), the sidecar scans all immediate subdirectories of the
// projects root for a `chats/` child and watches every *.jsonl it finds
// there. If CF_QWEN_CHATS_DIR is also set (an exact chats dir — kept for
// back-compat / override), it is treated as one additional chats dir on top
// of the discovered ones.
//
// Idempotency: fleet's SQLite ingest dedups on (session_id, uuid|line-hash);
// the sidecar's own per-file byte-offset prevents re-emitting the same source
// bytes on a re-read. The offset map is keyed by the ABSOLUTE source path
// (not the bare sid) so two different project dirs with the same sid (won't
// happen in practice — one workspace = one project dir) don't collide.
//
// NOT YET RUNNABLE: two sibling imports are produced by later tasks:
//   • ./qwenAdapter.mjs  — bundled from src/main/qwenAdapter.ts at image build
//                          (Task 11 esbuild step in the qwen Dockerfile).
//   • ./title.mjs        — OSC busy/idle title helper (Task 10).
// Both are referenced below; the sidecar will fail to start until they exist.

import { watch, promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import { nextLines } from './lines.mjs';
import { listChatsFiles, listChatsDirs } from './discover.mjs';

// Task 11 bundles qwenAdapter.ts → ./qwenAdapter.mjs (esbuild, no external deps).
import { mapQwenRecord } from './qwenAdapter.mjs';   // NOT present until Task 11

// Task 10 creates ./title.mjs — emits OSC 0 busy/idle title string.
import { titleFor } from './title.mjs';              // NOT present until Task 10

// ── Environment ──────────────────────────────────────────────────────────────
// CF_QWEN_PROJECTS_DIR  : qwen's ~/.qwen/projects root   (discovery source)
// CF_QWEN_CHATS_DIR     : optional exact chats dir       (back-compat / override)
// CF_FLEET_PROJECTS_DIR : container-side output for the fleet host watcher
const PROJECTS_DIR = process.env.CF_QWEN_PROJECTS_DIR;
const EXACT_CHATS  = process.env.CF_QWEN_CHATS_DIR;   // optional
const OUT          = process.env.CF_FLEET_PROJECTS_DIR;

if (!PROJECTS_DIR || !OUT) {
  process.stderr.write(
    '[qwen-sidecar] CF_QWEN_PROJECTS_DIR and CF_FLEET_PROJECTS_DIR must be set\n'
  );
  process.exit(1);
}

// Ensure the output dir exists before any appendFile calls so the sidecar is
// self-sufficient even when the host jsonlWatcher hasn't mkdir'd it yet.
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

// Per-file byte offset — keyed by absolute source path so two project dirs
// that happen to contain a same-named sid don't collide. Advances only after
// a successful append so a crash before fsp.appendFile leaves the source
// bytes available for the next pump().
const offsets = new Map(); // absPath → number

// ── Core pump ─────────────────────────────────────────────────────────────────

async function pump(absPath) {
  const sid = sidFromName(basename(absPath));
  if (!sid) return;
  const dst = join(OUT, `${sid}.jsonl`);

  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat) return;

  let off = offsets.get(absPath) ?? 0;

  // Compaction / rotation: if the source shrank, restart from byte 0.
  // Mirrors jsonlWatcher.ts lines 165–204 compaction handling.
  if (stat.size < off) off = 0;

  // Read only the new bytes since our last offset.
  const fh = await fsp.open(absPath, 'r');
  const toRead = stat.size - off;
  if (toRead <= 0) { await fh.close(); return; }
  const raw = Buffer.alloc(toRead);
  const { bytesRead } = await fh.read(raw, 0, toRead, off);
  await fh.close();

  const chunk = raw.slice(0, bytesRead).toString('utf8');
  const { lines, offset } = nextLines(chunk);
  if (!lines.length) return;

  const mapped = lines.map(mapLine).filter(Boolean);
  if (mapped.length) {
    await fsp.appendFile(dst, mapped.join('\n') + '\n', 'utf8');
  }

  // Advance offset by the number of complete bytes consumed.
  offsets.set(absPath, off + offset);

  // Emit OSC busy/idle title so the fleet UI can reflect qwen activity.
  process.stdout.write(titleFor(lines));
}

function mapLine(l) {
  try {
    return mapQwenRecord(JSON.parse(l));
  } catch {
    return null;
  }
}

// ── Extract sid from filename ─────────────────────────────────────────────────

function sidFromName(name) {
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
}

// ── Handle a single file event inside a known chats dir ───────────────────────

async function handleChange(chatsDir, filename) {
  if (!filename) return;
  if (!filename.endsWith('.jsonl')) return;
  const absPath = join(chatsDir, filename);
  await pump(absPath).catch((err) =>
    process.stderr.write(`[qwen-sidecar] pump(${absPath}): ${err.message}\n`)
  );
}

// ── Watch a single chats dir (inotify + poll fallback already provided) ───────

const watchedDirs = new Set();

function watchChatsDir(chatsDir) {
  if (watchedDirs.has(chatsDir)) return;
  watchedDirs.add(chatsDir);
  try {
    watch(chatsDir, { persistent: true }, (_eventType, filename) => {
      handleChange(chatsDir, filename).catch(() => {});
    });
  } catch {
    // Dir may not exist yet or watch failed; the poll loop will cover it.
  }
}

// ── Collect all current chats dirs (discovery + optional exact hint) ──────────

function allChatsDirs() {
  const dirs = listChatsDirs(PROJECTS_DIR);
  if (EXACT_CHATS && !dirs.includes(EXACT_CHATS)) {
    dirs.push(EXACT_CHATS);
  }
  return dirs;
}

// ── Initial scan: process any lines already written before sidecar started ────

async function initialScan() {
  // Discover all *.jsonl files under the projects root.
  const files = listChatsFiles(PROJECTS_DIR);

  // Also include any files in the exact chats dir hint.
  if (EXACT_CHATS) {
    let entries;
    try {
      entries = await fsp.readdir(EXACT_CHATS);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) {
        const abs = join(EXACT_CHATS, name);
        if (!files.includes(abs)) files.push(abs);
      }
    }
  }

  for (const absPath of files) {
    await pump(absPath).catch((err) =>
      process.stderr.write(`[qwen-sidecar] pump(${absPath}): ${err.message}\n`)
    );
  }

  // Wire up watchers for any newly-discovered chats dirs.
  for (const dir of allChatsDirs()) {
    watchChatsDir(dir);
  }
}

// ── Watch loop ────────────────────────────────────────────────────────────────

async function main() {
  await initialScan();

  // ~1 s poll fallback — re-scans even when fs.watch misses events (e.g.
  // new project dirs created after startup, or file systems without inotify).
  // Also wires up watchers for newly-discovered chats dirs each tick.
  setInterval(async () => {
    await initialScan();
  }, 1000);
}

main().catch((err) => {
  process.stderr.write(`[qwen-sidecar] fatal: ${err.message}\n`);
  process.exit(1);
});
