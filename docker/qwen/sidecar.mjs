// qwen→fleet transcript sidecar — ships in the qwen runner image.
//
// Tails every <sid>.jsonl in CF_QWEN_CHATS_DIR, maps each complete line with
// mapQwenRecord (Task 8), and appends the claude-dialect output to the
// fleet-watched path CF_FLEET_PROJECTS_DIR/<sid>.jsonl so the host watcher
// picks it up without knowing about qwen.
//
// Idempotency: fleet's SQLite ingest dedups on (session_id, uuid|line-hash);
// the sidecar's own per-sid byte-offset prevents re-emitting the same source
// bytes on a re-read. No additional dedup is done inside this file.
//
// NOT YET RUNNABLE: two sibling imports are produced by later tasks:
//   • ./qwenAdapter.mjs  — bundled from src/main/qwenAdapter.ts at image build
//                          (Task 11 esbuild step in the qwen Dockerfile).
//   • ./title.mjs        — OSC busy/idle title helper (Task 10).
// Both are referenced below; the sidecar will fail to start until they exist.

import { watch, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { nextLines } from './lines.mjs';

// Task 11 bundles qwenAdapter.ts → ./qwenAdapter.mjs (esbuild, no external deps).
import { mapQwenRecord } from './qwenAdapter.mjs';   // NOT present until Task 11

// Task 10 creates ./title.mjs — emits OSC 0 busy/idle title string.
import { titleFor } from './title.mjs';              // NOT present until Task 10

// ── Environment ──────────────────────────────────────────────────────────────
// CF_QWEN_CHATS_DIR  : qwen's ~/.qwen/projects/<proj>/chats  (source side)
// CF_FLEET_PROJECTS_DIR : container-side view of <state>/.claude/projects/-workspace
const CHATS = process.env.CF_QWEN_CHATS_DIR;
const OUT   = process.env.CF_FLEET_PROJECTS_DIR;

if (!CHATS || !OUT) {
  process.stderr.write(
    '[qwen-sidecar] CF_QWEN_CHATS_DIR and CF_FLEET_PROJECTS_DIR must be set\n'
  );
  process.exit(1);
}

// Per-session byte offset — advances only after a successful append so a crash
// before fsp.appendFile leaves the source bytes available for the next pump().
const offsets = new Map(); // sid → number

// ── Core pump ─────────────────────────────────────────────────────────────────

async function pump(sid) {
  const src = join(CHATS, `${sid}.jsonl`);
  const dst = join(OUT,   `${sid}.jsonl`);

  const stat = await fsp.stat(src).catch(() => null);
  if (!stat) return;

  let off = offsets.get(sid) ?? 0;

  // Compaction / rotation: if the source shrank, restart from byte 0.
  // Mirrors jsonlWatcher.ts lines 165–204 compaction handling.
  if (stat.size < off) off = 0;

  // Read only the new bytes since our last offset.
  const fh = await fsp.open(src, 'r');
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
  offsets.set(sid, off + offset);

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

// ── Handle a single file event ────────────────────────────────────────────────

async function handleChange(filename) {
  if (!filename) return;
  const sid = sidFromName(filename);
  if (!sid) return;
  await pump(sid).catch((err) =>
    process.stderr.write(`[qwen-sidecar] pump(${sid}): ${err.message}\n`)
  );
}

// ── Initial scan: process any lines already written before sidecar started ───

async function initialScan() {
  let entries;
  try {
    entries = await fsp.readdir(CHATS);
  } catch {
    return; // chats dir doesn't exist yet — watcher will catch it when created
  }
  for (const name of entries) {
    await handleChange(name);
  }
}

// ── Watch loop ────────────────────────────────────────────────────────────────

async function main() {
  await initialScan();

  // Primary watcher via fs.watch (inotify on Linux inside the container).
  try {
    watch(CHATS, { persistent: true }, (_eventType, filename) => {
      handleChange(filename).catch(() => {});
    });
  } catch {
    // CHATS dir may not exist yet; the poll fallback below will cover it.
  }

  // ~1 s poll fallback — re-scans even when fs.watch misses events (e.g.
  // the chats dir is created after the watcher starts, or on file systems
  // that don't support inotify reliably).
  setInterval(async () => {
    await initialScan();
  }, 1000);
}

main().catch((err) => {
  process.stderr.write(`[qwen-sidecar] fatal: ${err.message}\n`);
  process.exit(1);
});
