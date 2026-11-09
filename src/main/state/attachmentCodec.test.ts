import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MIN_BYTES, dedupeAttachment, deflatePayload, expandLine, partMarker } from './attachmentCodec.js';

const att = (payload: unknown) => JSON.stringify({ parentUuid: 'p', type: 'attachment', attachment: payload, uuid: 'u', timestamp: '2026-11-01T00:00:00Z' });
const big = { type: 'instructions', content: 'x'.repeat(ATTACHMENT_MIN_BYTES) };

describe('attachment codec', () => {
  it('round-trips a large payload byte-for-byte', () => {
    const line = att(big);
    const d = dedupeAttachment(line)!;
    expect(d.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(d.stored).toBe(line.replace(JSON.stringify(big), partMarker(d.ref, 0)));
    expect(JSON.parse(d.stored).attachment).toEqual({ fleetRef: d.ref, part: 0 });
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(line);
  });

  it('moves rendered with the attachment into one blob', () => {
    const rendered = [{ content: `<system-reminder>${'r'.repeat(3000)}</system-reminder>` }];
    const line = JSON.stringify({ parentUuid: 'p', attachment: big, type: 'attachment', uuid: 'u', rendered, cwd: '/w' });
    const d = dedupeAttachment(line)!;
    const o = JSON.parse(d.stored);
    expect(o.attachment).toEqual({ fleetRef: d.ref, part: 0 });
    expect(o.rendered).toEqual({ fleetRef: d.ref, part: 1 });
    expect(d.stored.length).toBeLessThan(300);
    expect(JSON.parse(d.payload)).toEqual([JSON.stringify(big), JSON.stringify(rendered)]);
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(line);
  });

  it('counts both parts toward the size threshold', () => {
    const half = { type: 'x', content: 'a'.repeat(ATTACHMENT_MIN_BYTES / 2) };
    expect(dedupeAttachment(att(half))).toBeNull();
    expect(dedupeAttachment(JSON.stringify({ type: 'attachment', attachment: half, rendered: 'b'.repeat(ATTACHMENT_MIN_BYTES / 2) }))).not.toBeNull();
  });

  it('skips a line whose only literal match is nested, not the top-level key', () => {
    const canon = JSON.stringify(big);
    // Top-level value written with a space (not what JSON.stringify produces); a nested copy is canonical.
    const line = `{"type":"attachment","attachment": ${canon},"meta":{"attachment":${canon}}}`;
    expect(JSON.parse(line).attachment).toEqual(big);
    expect(dedupeAttachment(line)).toBeNull();
  });

  it('gives the same payload the same ref', () => {
    expect(dedupeAttachment(att(big))!.ref).toBe(dedupeAttachment(att(big).replace('"u"', '"v"'))!.ref);
  });

  it('skips small payloads, non-attachments, non-JSON and marker collisions', () => {
    expect(dedupeAttachment(att({ type: 'x', content: 'small' }))).toBeNull();
    expect(dedupeAttachment(JSON.stringify({ type: 'user', attachment: big }))).toBeNull();
    expect(dedupeAttachment('{not json')).toBeNull();
    expect(dedupeAttachment(JSON.stringify({ type: 'attachment', fleetRef: 'x', attachment: big }))).toBeNull();
    // Inside a string value the quotes are escaped, so it can't collide with the marker.
    const quoted = att({ ...big, note: '{"fleetRef":"0"}' });
    const d = dedupeAttachment(quoted)!;
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(quoted);
  });

  it('skips a payload whose text is not what JSON.stringify produces', () => {
    const line = att(big).replace('"instructions"', '"instructi\\u006fns"');
    expect(dedupeAttachment(line)).toBeNull();
  });

  it('keeps $ patterns literal', () => {
    const line = att({ type: 'instructions', content: `$& $1 $$ ${'y'.repeat(ATTACHMENT_MIN_BYTES)}` });
    const d = dedupeAttachment(line)!;
    expect(expandLine(d.stored, d.ref, deflatePayload(d.payload))).toBe(line);
  });

  it('reads a missing or corrupt body as the stored form; strict throws', () => {
    const d = dedupeAttachment(att(big))!;
    expect(expandLine(d.stored, d.ref, null)).toBe(d.stored);
    expect(expandLine(d.stored, d.ref, Buffer.from('junk'))).toBe(d.stored);
    expect(() => expandLine(d.stored, d.ref, Buffer.from('junk'), true)).toThrow();
    expect(expandLine('plain', null, null)).toBe('plain');
  });
});
