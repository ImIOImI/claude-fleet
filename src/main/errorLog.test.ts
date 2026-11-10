import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setErrorLogForTests, batchedErrorSink, flushErrorLog, flushErrorLogSync, installMainProcessHandlers, logError, setErrorSink } from './errorLog.js';
import type { ErrorRow } from './db.js';

afterEach(() => setErrorSink(null));

describe('error sink', () => {
  it('forwards each logError to the registered sink with an epoch-ms ts', () => {
    const seen: unknown[] = [];
    setErrorSink((row) => seen.push(row));
    logError({ source: 'main', type: 't', message: 'm', workspaceId: 'ws-a', level: 'warn' });
    expect(seen).toHaveLength(1);
    const row = seen[0] as Record<string, unknown>;
    expect(row.type).toBe('t');
    expect(row.workspaceId).toBe('ws-a');
    expect(row.level).toBe('warn');
    expect(typeof row.ts).toBe('number'); // epoch ms, not ISO string
  });

  it('never throws when the sink throws (crash-safety)', () => {
    setErrorSink(() => { throw new Error('db wedged'); });
    expect(() => logError({ source: 'main', type: 't', message: 'm' })).not.toThrow();
  });
});

describe('entry size', () => {
  it('caps message and stack so a huge error never reaches the log whole', () => {
    const seen: Array<{ message: string; stack?: string }> = [];
    setErrorSink((row) => seen.push(row as unknown as { message: string; stack?: string }));
    logError({ source: 'main', type: 't', message: 'm'.repeat(1_000_000), stack: 's'.repeat(1_000_000) });
    expect(seen[0].message.length).toBeLessThanOrEqual(8_300);
    expect(seen[0].stack!.length).toBeLessThanOrEqual(8_300);
    expect(seen[0].message).toMatch(/truncated/);
  });
});


describe('rotation', () => {
  afterEach(() => _setErrorLogForTests(null));

  it('moves error.log to error.log.1 once the next line would pass the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-errlog-'));
    const p = join(dir, 'error.log');
    writeFileSync(p, 'x'.repeat(700) + '\n');
    _setErrorLogForTests(p, 1000);
    logError({ source: 'main', type: 'first', message: 'm'.repeat(50) });
    flushErrorLogSync();
    expect(existsSync(`${p}.1`)).toBe(false);
    logError({ source: 'main', type: 'second', message: 'm'.repeat(200) });
    flushErrorLogSync();
    expect(readFileSync(`${p}.1`, 'utf8')).toContain('"type":"first"');
    const current = readFileSync(p, 'utf8');
    expect(current).toContain('"type":"second"');
    expect(current).not.toContain('"type":"first"');
    logError({ source: 'main', type: 'third', message: 'm'.repeat(900) });
    flushErrorLogSync();
    expect(readFileSync(`${p}.1`, 'utf8')).toContain('"type":"second"');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates inside one async batch at the line that passes the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-errlog-'));
    const p = join(dir, 'error.log');
    writeFileSync(p, 'x'.repeat(700) + '\n');
    _setErrorLogForTests(p, 1000);
    logError({ source: 'main', type: 'first', message: 'm'.repeat(50) });
    logError({ source: 'main', type: 'second', message: 'm'.repeat(200) });
    await flushErrorLog();
    expect(readFileSync(`${p}.1`, 'utf8')).toContain('"type":"first"');
    const current = readFileSync(p, 'utf8');
    expect(current).toContain('"type":"second"');
    expect(current).not.toContain('"type":"first"');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buffered writes', () => {
  let dir: string;
  const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type) : []);
  afterEach(() => {
    _setErrorLogForTests(null);
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-errlog-'));
    const p = join(dir, 'error.log');
    _setErrorLogForTests(p);
    return p;
  };

  it('does not touch the file on the logError call and appends the burst together on the timer', async () => {
    const p = setup();
    for (let i = 0; i < 50; i++) logError({ source: 'main', type: `t${i}`, message: 'm' });
    expect(lines(p)).toEqual([]);
    await vi.waitFor(() => expect(lines(p)).toHaveLength(50), { timeout: 2000 });
    expect(lines(p)[0]).toBe('t0');
    expect(lines(p)[49]).toBe('t49');
  });

  it('keeps order across lines logged while an append is running', async () => {
    const p = setup();
    logError({ source: 'main', type: 'a', message: 'm' });
    const first = flushErrorLog();
    logError({ source: 'main', type: 'b', message: 'm' });
    await first;
    await flushErrorLog();
    expect(lines(p)).toEqual(['a', 'b']);
  });

  it('flushErrorLogSync writes buffered lines before returning', () => {
    const p = setup();
    logError({ source: 'main', type: 'crash', message: 'm' });
    flushErrorLogSync();
    expect(lines(p)).toEqual(['crash']);
  });

  it('flushErrorLogSync also writes the lines of an append still running', async () => {
    const p = setup();
    logError({ source: 'main', type: 'mid', message: 'm' });
    const running = flushErrorLog();
    flushErrorLogSync();
    expect(lines(p)).toContain('mid');
    await running;
  });

  it('flushes synchronously on process exit', () => {
    const p = setup();
    const exit = process.listeners('exit');
    const uncaught = process.listeners('uncaughtException');
    const rejection = process.listeners('unhandledRejection');
    installMainProcessHandlers();
    try {
      logError({ source: 'main', type: 'last', message: 'm' });
      for (const l of process.listeners('exit')) if (!exit.includes(l)) l(0);
      expect(lines(p)).toEqual(['last']);
    } finally {
      for (const l of process.listeners('exit')) if (!exit.includes(l)) process.off('exit', l);
      for (const l of process.listeners('uncaughtException')) if (!uncaught.includes(l)) process.off('uncaughtException', l);
      for (const l of process.listeners('unhandledRejection')) if (!rejection.includes(l)) process.off('unhandledRejection', l);
    }
  });
});

describe('batchedErrorSink', () => {
  const row = (type: string): ErrorRow => ({ ts: 1, source: 'main', type, message: 'm' });

  it('hands a burst to one write call', async () => {
    const calls: string[][] = [];
    const b = batchedErrorSink(async (rows) => { calls.push(rows.map((r) => r.type)); }, 20);
    b.sink(row('a'));
    b.sink(row('b'));
    b.sink(row('c'));
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(calls).toEqual([['a', 'b', 'c']]));
  });

  it('flush writes at once, runs writes one at a time, and survives a rejected write', async () => {
    const calls: string[][] = [];
    let active = 0;
    const b = batchedErrorSink(async (rows) => {
      active++;
      expect(active).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      calls.push(rows.map((r) => r.type));
      if (rows[0].type === 'bad') throw new Error('db wedged');
    }, 10_000);
    b.sink(row('bad'));
    void b.flush();
    b.sink(row('good'));
    await b.flush();
    expect(calls).toEqual([['bad'], ['good']]);
  });
});
