#!/usr/bin/env node
// Read-only size report for a COPY of state.db (never the live file):
//   node scripts/measure-statedb.mjs --db /path/to/state.db [--state-dir <userData>/state] [--sample 0.02]
// Prints per-object sizes (dbstat), raw_jsonl bytes per event class, the
// share older than 30/90 days, a zlib estimate on a sample, embedding
// placeholder counts, and (with --state-dir) workspaces with no state dir.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
if (!args.db) {
  console.error('usage: measure-statedb.mjs --db <copy of state.db> [--state-dir <dir>] [--sample 0.02]');
  process.exit(2);
}
const sample = Number(args.sample ?? 0.02);
const d = new Database(args.db, { readonly: true, fileMustExist: true });
const mb = (b) => (Number(b) / 1e6).toFixed(1);
const table = (rows) => console.table(rows);
const hasCol = (t, c) => d.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);

console.log(`\n# ${args.db}  user_version=${d.pragma('user_version', { simple: true })}  auto_vacuum=${d.pragma('auto_vacuum', { simple: true })}  freelist=${d.pragma('freelist_count', { simple: true })} pages`);

try {
  table(d.prepare(`SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20`).all()
    .map((r) => ({ object: r.name, MB: mb(r.bytes) })));
} catch {
  console.log('(dbstat unavailable in this SQLite build)');
}

const rawZ = hasCol('events', 'raw_z') ? 'raw_z' : 'NULL';
const klass = `CASE
  WHEN type = 'user' AND tool_use_id IS NOT NULL THEN 'user:tool_result'
  WHEN type = 'assistant' AND tool_name IS NOT NULL THEN 'assistant:tool_use'
  ELSE type END`;
const now = Date.now();
const day = 86_400_000;
table(d.prepare(`
  SELECT ${klass} AS class, count(*) AS rows,
         sum(length(CAST(raw_jsonl AS BLOB)) + COALESCE(length(${rawZ}), 0)) AS bytes,
         sum(CASE WHEN ts < ? THEN 1 ELSE 0 END) AS older30,
         sum(CASE WHEN ts < ? THEN 1 ELSE 0 END) AS older90,
         sum(CASE WHEN ${rawZ} IS NOT NULL THEN 1 ELSE 0 END) AS compressed
  FROM events GROUP BY class ORDER BY bytes DESC`).all(now - 30 * day, now - 90 * day)
  .map(({ bytes, ...r }) => ({ ...r, MB: mb(bytes), avgB: Math.round(bytes / r.rows) })));

let raw = 0;
let z = 0;
let n = 0;
for (const r of d.prepare(`SELECT raw_jsonl, ${rawZ} AS raw_z FROM events WHERE abs(random()) % 10000 < ?`).iterate(Math.round(sample * 10000))) {
  const line = r.raw_z ? inflateSync(r.raw_z).toString('utf8') : r.raw_jsonl;
  const b = Buffer.byteLength(line);
  raw += b;
  z += b < 512 ? b : deflateSync(line).length;
  n++;
}
if (n) console.log(`zlib sample: ${n} rows, ${mb(raw)} MB raw → ${mb(z)} MB (${((100 * z) / raw).toFixed(0)}%)`);

const vecLen = 'length(vec)';
table(d.prepare(`SELECT kind, CASE WHEN text = '' THEN 'placeholder' ELSE 'text' END AS what, count(*) AS rows,
  sum(${vecLen}) AS vecBytes, sum(length(CAST(text AS BLOB))) AS textBytes FROM embeddings GROUP BY kind, what`).all()
  .map(({ vecBytes, textBytes, ...r }) => ({ ...r, vecMB: mb(vecBytes ?? 0), textMB: mb(textBytes ?? 0) })));

if (args['state-dir']) {
  const ids = d.prepare(`SELECT workspace_id AS id, count(*) AS sessions FROM sessions GROUP BY workspace_id`).all();
  const orphans = ids.filter((r) => !existsSync(join(args['state-dir'], r.id)));
  console.log(`workspaces with no state dir: ${orphans.length}`);
  for (const o of orphans) {
    const ev = d.prepare(`SELECT count(*) AS n, sum(length(CAST(raw_jsonl AS BLOB))) AS b FROM events WHERE workspace_id = ?`).get(o.id);
    console.log(`  ${o.id}: ${o.sessions} sessions, ${ev.n} events, ${mb(ev.b ?? 0)} MB raw`);
  }
}
d.close();
