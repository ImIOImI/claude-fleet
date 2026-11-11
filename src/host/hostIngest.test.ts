import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as db from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, queryRows } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { HostIngest, INGEST_STATEMENT_TIMEOUT, type HostIngestOptions } from './hostIngest.js';
import { createLogger } from './log.js';
import { leaseFence } from './pgLease.js';

const WS = '01JC0000000000000000000000';
const S1 = '11111111-1111-4111-8111-111111111111';
const line = (uuid: string, content = `hi ${uuid}`) =>
  JSON.stringify({ type: 'user', uuid, sessionId: S1, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content } }) + '\n';

describe.skipIf(!isPg)('HostIngest', () => {
  const running: HostIngest[] = [];
  afterEach(async () => {
    for (const h of running.splice(0)) await h.stop();
  });

  async function rig() {
    const st = await openTestState();
    const offsetsRead = postgresKysely<HostDb>(st.pg!.pool);
    await migratePostgres(offsetsRead, st.pg!.schema, HOST_TRACK);
    const projects = mkdtempSync(join(tmpdir(), 'proj-'));
    mkdirSync(join(projects, '-workspace'));
    const logs: string[] = [];
    const make = (o: Partial<Pick<HostIngestOptions, 'ingest' | 'maxReadBytes' | 'maxLineBytes' | 'maxChunkBytes' | 'onIngested'>> = {}) => {
      const h = new HostIngest({ projectsDir: projects, workspaceId: WS, offsetsRead, log: createLogger((l) => logs.push(l)), rescanMs: 3_600_000, ...o });
      running.push(h);
      return h;
    };
    return { st, offsetsRead, projects, logs, make, file: join(projects, '-workspace', `${S1}.jsonl`) };
  }
  const events = async (where = 'workspace_id = ?', params: unknown[] = [WS]) =>
    Number((await queryRows<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, params))[0].n);
  const offsets = async () =>
    (await queryRows<{ path: string; byte_offset: number }>('SELECT path, byte_offset FROM host_ingest_offsets ORDER BY path')).map((r) => ({
      path: r.path,
      byte_offset: Number(r.byte_offset)
    }));

  it('calls onIngested after a chunk commits, never for a scan with nothing new', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a'));
    const seen: string[] = [];
    const h = make({ onIngested: (id) => seen.push(id) });
    await h.start();
    await h.scan();
    expect(seen).toEqual([S1]);
    expect(await events()).toBe(1);
    await h.scan();
    expect(seen).toEqual([S1]);
  });

  it('ingests complete lines under the hosted workspace and keeps a partial line for later', async () => {
    const { make, file } = await rig();
    const c = line('c');
    writeFileSync(file, line('a') + line('b') + c.slice(0, 20));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(2);
    expect(await offsets()).toEqual([{ path: file, byte_offset: (line('a') + line('b')).length }]);
    appendFileSync(file, c.slice(20));
    await h.scan();
    expect(await events()).toBe(3);
    expect(await offsets()).toEqual([{ path: file, byte_offset: statSync(file).size }]);
  });

  it('resumes from persisted offsets after a restart instead of re-reading', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a') + line('b'));
    const first = make();
    await first.start();
    await first.scan();
    await first.stop();
    const spy = vi.fn(db.ingestBatch);
    const second = make({ ingest: spy });
    await second.start();
    await second.scan();
    expect(spy).not.toHaveBeenCalled();
    appendFileSync(file, line('c'));
    await second.scan();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toHaveLength(1);
  });

  it('re-reads a file that shrank (compaction) without duplicating rows', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a') + line('b'));
    const h = make();
    await h.start();
    await h.scan();
    writeFileSync(file, line('d'));
    await h.scan();
    expect(await events()).toBe(3);
  });

  it('attributes a subagent transcript to its parent session', async () => {
    const { make, projects } = await rig();
    const sub = join(projects, '-workspace', S1, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-x.jsonl'), line('s'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events('session_id = ?', [S1])).toBe(1);
  });

  it('never follows a symlink out of the projects directory', async () => {
    const { make, projects } = await rig();
    const S2 = '22222222-2222-4222-8222-222222222222';
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'agent-x.jsonl'), line('o'));
    writeFileSync(join(outside, 'top.jsonl'), line('t'));
    mkdirSync(join(projects, '-workspace', S1));
    symlinkSync(outside, join(projects, '-workspace', S1, 'subagents'));
    mkdirSync(join(projects, '-workspace', S2, 'subagents'), { recursive: true });
    symlinkSync(join(outside, 'agent-x.jsonl'), join(projects, '-workspace', S2, 'subagents', 'agent-y.jsonl'));
    symlinkSync(join(outside, 'top.jsonl'), join(projects, '-workspace', `${S2}.jsonl`));
    // A sibling whose path extends the projects directory's.
    const S3 = '33333333-3333-4333-8333-333333333333';
    mkdirSync(`${projects}-sib`);
    writeFileSync(join(`${projects}-sib`, 'agent-z.jsonl'), line('z'));
    mkdirSync(join(projects, '-workspace', S3));
    symlinkSync(`${projects}-sib`, join(projects, '-workspace', S3, 'subagents'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(0);
  });

  it('re-checks containment after open: a directory swapped for a symlink after the pre-check is skipped', async () => {
    const { make, projects } = await rig();
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'agent-x.jsonl'), line('o'));
    const sub = join(projects, '-workspace', S1, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-x.jsonl'), line('i'));
    const h = make();
    const proto = HostIngest.prototype as unknown as { inProjects(p: string): Promise<boolean> };
    const real = proto.inProjects;
    let swapped = false;
    const spy = vi.spyOn(proto, 'inProjects').mockImplementation(async function (this: HostIngest, p: string) {
      const ok = await real.call(this, p);
      if (!swapped) {
        swapped = true;
        renameSync(sub, `${sub}.old`);
        symlinkSync(outside, sub);
      }
      return ok;
    });
    try {
      await h.start();
      await h.scan();
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(await events()).toBe(0);
  });

  it('skips a non-regular transcript without blocking on it', async () => {
    const { make, projects, file, logs } = await rig();
    const sub = join(projects, '-workspace', S1, 'subagents');
    mkdirSync(join(sub, 'agent-d.jsonl'), { recursive: true });
    execFileSync('mkfifo', [join(sub, 'agent-f.jsonl')]);
    writeFileSync(file, line('a'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(1);
    expect(logs.join('\n')).not.toContain('transcript ingest failed');
  }, 10_000);

  it('picks up an append from the directory watch, without a scan call', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a'));
    const h = make();
    await h.start();
    await h.scan();
    appendFileSync(file, line('b'));
    await vi.waitFor(async () => expect(await events()).toBe(2), { timeout: 5_000 });
  });

  it('redacts a printed token before it is stored', async () => {
    const { make, file } = await rig();
    const token = 'ghs_' + 'A1b2C3d4E5'.repeat(3) + 'abcdef';
    writeFileSync(file, line('a', `my token is ${token}`));
    const h = make();
    await h.start();
    await h.scan();
    const rows = await queryRows<Record<string, unknown>>('SELECT * FROM events WHERE workspace_id = ?', [WS]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].raw_jsonl)).toContain('my token is [redacted]');
    const sessions = await queryRows('SELECT * FROM sessions');
    expect(JSON.stringify([rows, sessions])).not.toContain(token);
  });

  it.each(['\n', '\t', '\u001b[0m', '\u001b]8;;x\u0007'])('redacts a token and a Bearer value that follow %j', async (prefix) => {
    const { make, file } = await rig();
    const token = 'ghs_' + 'A1b2C3d4E5'.repeat(3) + 'abcdef';
    writeFileSync(file, line('a', `done${prefix}${token}`) + line('b', `hdr${prefix}Bearer abcDEF123.xyz-TOKEN`));
    const h = make();
    await h.start();
    await h.scan();
    const rows = await queryRows<Record<string, unknown>>('SELECT * FROM events WHERE workspace_id = ?', [WS]);
    expect(rows).toHaveLength(2);
    const sessions = await queryRows('SELECT * FROM sessions');
    const all = JSON.stringify([rows, sessions]);
    expect(all).not.toContain(token);
    expect(all).not.toContain('abcDEF123.xyz-TOKEN');
  });

  it('ingests a line carrying a NUL (U+FFFD on Postgres) and a raw NUL byte does not stick the file', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a', 'x \u0000 y') + `{"type":"user","uuid":"b\u0000","sessionId":"${S1}"}\n` + line('c'));
    const h = make();
    await h.start();
    await h.scan();
    expect(await events()).toBe(2);
    const [{ first_user_message }] = await queryRows<{ first_user_message: string }>('SELECT first_user_message FROM sessions WHERE id = ?', [S1]);
    expect(first_user_message).toBe('x � y');
    expect(await offsets()).toEqual([{ path: file, byte_offset: statSync(file).size }]);
  });

  it('passes at most INGEST_TX_LINES lines per call, each call carrying its offset', async () => {
    const { make, file } = await rig();
    const n = db.INGEST_TX_LINES * 2 + 3;
    writeFileSync(file, Array.from({ length: n }, (_, i) => line(`l${i}`)).join(''));
    const spy = vi.fn(db.ingestBatch);
    const h = make({ ingest: spy });
    await h.start();
    await h.scan();
    expect(spy.mock.calls.map((c) => c[2].length)).toEqual([db.INGEST_TX_LINES, db.INGEST_TX_LINES, 3]);
    expect(spy.mock.calls.every((c) => typeof c[3]?.inTx === 'function')).toBe(true);
    expect(await events()).toBe(n);
    expect(await offsets()).toEqual([{ path: file, byte_offset: statSync(file).size }]);
  });

  it('writes the offset inside the chunk transaction', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a') + line('b'));
    const seen: number[] = [];
    const h = make({
      ingest: (ws, sid, lines, opts) =>
        db.ingestBatch(ws, sid, lines, {
          inTx: async (trx) => {
            await opts!.inTx!(trx);
            const r = await sql<{ byte_offset: string }>`SELECT byte_offset FROM host_ingest_offsets WHERE path = ${file}`.execute(trx);
            seen.push(Number(r.rows[0]?.byte_offset));
          }
        })
    });
    await h.start();
    await h.scan();
    expect(seen).toEqual([statSync(file).size]);
  });

  it('an inTx failure rolls back the chunk’s rows and its offset', async () => {
    const { make, file, logs } = await rig();
    writeFileSync(file, line('a'));
    const h = make({
      ingest: (ws, sid, lines, opts) =>
        db.ingestBatch(ws, sid, lines, {
          inTx: async (trx) => {
            await opts!.inTx!(trx);
            throw new Error('boom');
          }
        })
    });
    await h.start();
    await h.scan();
    expect(await events()).toBe(0);
    expect(await offsets()).toEqual([]);
    expect(logs.join('\n')).toMatch(/transcript ingest failed.*boom/);
  });

  it('a fenced-off holder commits neither rows nor offset, and it is logged', async () => {
    const { make, file, st, logs } = await rig();
    const schema = st.pg!.schema;
    await st.pg!.pool.query(`INSERT INTO ${schema}.host_lease VALUES ($1, 'me', 2, clock_timestamp() + interval '1 minute')`, [WS]);
    await db.closeDb();
    const lost: Error[] = [];
    await db.openDbPostgres(st.pg!.pool, {
      migrate: false,
      afterBeginWrite: leaseFence({ workspaceId: WS, holder: 'me', epoch: () => 1, onLost: (e) => lost.push(e) })
    });
    writeFileSync(file, line('a'));
    const h = make();
    await h.start();
    await h.scan();
    const count = async (t: string) => Number((await st.pg!.pool.query(`SELECT COUNT(*)::int AS n FROM ${schema}.${t}`)).rows[0].n);
    expect(await count('events')).toBe(0);
    expect(await count('host_ingest_offsets')).toBe(0);
    expect(lost).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/transcript ingest failed.*lease lost/);
  });

  it('caps each chunk by bytes as well as lines', async () => {
    const { make, file } = await rig();
    const ls = Array.from({ length: 5 }, (_, i) => line(`b${i}`));
    writeFileSync(file, ls.join(''));
    const cap = ls[0].length * 2 + 10;
    const spy = vi.fn(db.ingestBatch);
    const h = make({ ingest: spy, maxChunkBytes: cap });
    await h.start();
    await h.scan();
    expect(spy.mock.calls.map((c) => c[2].length)).toEqual([2, 2, 1]);
    expect(await events()).toBe(5);
    expect(await offsets()).toEqual([{ path: file, byte_offset: statSync(file).size }]);
  });

  it('runs each ingest transaction under a short statement timeout', async () => {
    const { make, file } = await rig();
    writeFileSync(file, line('a'));
    const seen: string[] = [];
    const h = make({
      ingest: (ws, sid, lines, opts) =>
        db.ingestBatch(ws, sid, lines, {
          ...opts,
          inTx: async (trx) => {
            await opts!.inTx!(trx);
            seen.push((await sql<{ statement_timeout: string }>`SHOW statement_timeout`.execute(trx)).rows[0].statement_timeout);
          }
        })
    });
    await h.start();
    await h.scan();
    expect(seen).toEqual([INGEST_STATEMENT_TIMEOUT]);
  });

  it('skips and logs a line over the size cap, reading a long one under it whole', async () => {
    const { make, file, logs } = await rig();
    const long = line('long', 'x'.repeat(200));
    const huge = line('huge', 'y'.repeat(600));
    writeFileSync(file, line('a') + long + huge + line('b'));
    const h = make({ maxReadBytes: 64, maxLineBytes: 400 });
    await h.start();
    await h.scan();
    expect(await events()).toBe(3);
    expect(await events('dedup_key = ?', ['huge'])).toBe(0);
    expect(logs.join('\n')).toMatch(/transcript line over the size cap; skipped/);
    expect(await offsets()).toEqual([{ path: file, byte_offset: statSync(file).size }]);
  });

  it('re-reads a transcript replaced by a new file, live and across a restart', async () => {
    const { make, file, projects } = await rig();
    const replace = (text: string) => {
      const tmp = join(projects, 'tmp');
      writeFileSync(tmp, text);
      renameSync(tmp, file);
    };
    writeFileSync(file, line('a') + line('b'));
    const first = make();
    await first.start();
    await first.scan();
    replace(line('c') + line('d') + line('e') + line('f'));
    await first.scan();
    expect(await events()).toBe(6);
    await first.stop();
    replace(line('g') + line('h') + line('i') + line('j') + line('k'));
    const second = make();
    await second.start();
    await second.scan();
    expect(await events()).toBe(11);
  });
});
