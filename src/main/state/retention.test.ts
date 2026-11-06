import { describe, it, expect, beforeEach } from 'vitest';
import {
  costForSession, eventsForSession, ingestLine, recentToolCallsForSession, recordUsageEvent,
} from '../db.js';
import { openTestState, queryRows, isPg } from '../store/testStore.js';
import { DAY_MS, retainEvents, type Throttle } from './retention.js';

const WS = '01WS';
const SES = 'ses-old';
const NOW = Date.parse('2026-11-06T00:00:00Z');
const iso = (daysAgo: number, plusMs = 0) => new Date(NOW - daysAgo * DAY_MS + plusMs).toISOString();

const unthrottled: Throttle = { slice: (fn) => fn(), stopped: () => false };

const toolUse = (id: string, daysAgo: number) => JSON.stringify({
  type: 'assistant', uuid: `a-${id}`, timestamp: iso(daysAgo), sessionId: SES,
  message: {
    model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/w/${id}.ts`, content: 'z'.repeat(5000) } }],
  },
});
const toolResult = (id: string, daysAgo: number) => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: iso(daysAgo, 1000), sessionId: SES,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'y'.repeat(6000) }] },
  toolUseResult: { stdout: 'y'.repeat(6000) },
});
const text = (u: string, daysAgo: number) => JSON.stringify({
  type: 'assistant', uuid: u, timestamp: iso(daysAgo, 2000), sessionId: SES,
  message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'prose '.repeat(200) }] },
});
const small = (u: string, daysAgo: number) => JSON.stringify({ type: 'system', uuid: u, timestamp: iso(daysAgo, 3000), sessionId: SES, subtype: 'x' });

const lines = [toolUse('t1', 40), toolResult('t1', 40), text('x1', 40), small('s1', 40), toolUse('t2', 5), toolResult('t2', 5)];

async function stored(): Promise<Map<string, { raw_jsonl: string; raw_z: unknown }>> {
  const rows = await queryRows<{ uuid: string; raw_jsonl: string; raw_z: unknown }>('SELECT uuid, raw_jsonl, raw_z FROM events');
  return new Map(rows.map((r) => [r.uuid, r]));
}
const isCompressed = (r: { raw_z: unknown }) => r.raw_z != null && (r.raw_z as Buffer).length > 0;

beforeEach(async () => {
  await openTestState('cf-retention-');
});

async function ingestAll(ls = lines): Promise<void> {
  for (const l of ls) await ingestLine(WS, SES, l);
}

describe('retainEvents', () => {
  it('strips and compresses rows older than 30 days, leaves recent rows, keeps rollups', async () => {
    await ingestAll();
    const costBefore = await costForSession(SES);
    const toolsBefore = await recentToolCallsForSession(SES);
    const r = await retainEvents(NOW, unthrottled);
    expect(r.rows).toBeGreaterThan(0);
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore);

    const evs = new Map((await eventsForSession(SES)).map((e) => [e.uuid, e]));
    const stub = JSON.parse(evs.get('r-t1')!.rawJsonl);
    expect(stub.fleetStripped).toBeDefined();
    expect(stub.message.content[0].tool_use_id).toBe('t1');
    expect(JSON.parse(evs.get('a-t1')!.rawJsonl).message.content[0].input.file_path).toBe('/w/t1.ts');
    expect(evs.get('x1')!.rawJsonl).toBe(lines[2]);
    expect(evs.get('s1')!.rawJsonl).toBe(lines[3]);
    expect(evs.get('a-t2')!.rawJsonl).toBe(lines[4]);
    expect(evs.get('r-t2')!.rawJsonl).toBe(lines[5]);

    const raw = await stored();
    expect(isCompressed(raw.get('x1')!)).toBe(!isPg);
    expect(isCompressed(raw.get('r-t1')!)).toBe(!isPg);
    expect(isCompressed(raw.get('s1')!)).toBe(false);
    expect(isCompressed(raw.get('r-t2')!)).toBe(false);
    if (!isPg) expect(raw.get('x1')!.raw_jsonl).toBe('');

    expect(await costForSession(SES)).toEqual(costBefore);
    expect(await recentToolCallsForSession(SES)).toEqual(toolsBefore);
  });

  it('keeps a stripped row stripped when its original line is ingested again', async () => {
    await ingestAll();
    await retainEvents(NOW, unthrottled);
    expect((await ingestLine(WS, SES, lines[1])).inserted).toBe(false);
    const ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(JSON.parse(ev.rawJsonl).fleetStripped).toBeDefined();
  });

  it('strips a resumed session only after 90 days, and catches up when it ages out', async () => {
    await ingestAll();
    await recordUsageEvent({ workspaceId: WS, sessionId: SES, kind: 'resumed' });
    await retainEvents(NOW, unthrottled);
    let ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(ev.rawJsonl).toBe(lines[1]);
    expect(isCompressed((await stored()).get('r-t1')!)).toBe(!isPg);

    await retainEvents(NOW + 60 * DAY_MS, unthrottled);
    ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(JSON.parse(ev.rawJsonl).fleetStripped).toBeDefined();
    expect(JSON.parse((await eventsForSession(SES)).find((e) => e.uuid === 'r-t2')!.rawJsonl).fleetStripped).toBeUndefined();
  });

  it('advances watermarks so a repeat pass writes nothing', async () => {
    await ingestAll();
    await retainEvents(NOW, unthrottled);
    expect((await retainEvents(NOW, unthrottled)).rows).toBe(0);
    const [w] = await queryRows<{ compressed_before: unknown; stripped_before: unknown }>(
      'SELECT compressed_before, stripped_before FROM event_retention WHERE session_id = ?', [SES]);
    expect(Number(w.compressed_before)).toBe(NOW - 30 * DAY_MS);
    expect(Number(w.stripped_before)).toBe(NOW - 30 * DAY_MS);
  });

  it('stops between slices and finishes on the next pass', async () => {
    const many = Array.from({ length: 30 }, (_, i) => toolResult(`m${i}`, 40));
    await ingestAll(many);
    let n = 0;
    const stopAfterOne: Throttle = { slice: (fn) => { n++; return fn(); }, stopped: () => n >= 1 };
    await retainEvents(NOW, stopAfterOne, { sliceRows: 10 });
    const strippedNow = (await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length;
    expect(strippedNow).toBe(10);
    expect(await queryRows('SELECT session_id FROM event_retention')).toEqual([]);
    await retainEvents(NOW, unthrottled, { sliceRows: 10 });
    expect((await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length).toBe(30);
  });
});
