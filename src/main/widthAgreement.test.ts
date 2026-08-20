import { describe, it, expect } from 'vitest';
import { createWidthAgreementMonitor } from './widthAgreement';

describe('widthAgreement monitor (#268)', () => {
  it('reports a divergence with the signed column delta', () => {
    const m = createWidthAgreementMonitor();
    const d = m.check('h1', { cols: 109, rows: 45 }, { cols: 107, rows: 45 });
    expect(d).toMatchObject({ handleId: 'h1', deltaCols: 2, deltaRows: 0 });
  });

  it('stays quiet when the pty agrees', () => {
    const m = createWidthAgreementMonitor();
    expect(m.check('h1', { cols: 107, rows: 45 }, { cols: 107, rows: 45 })).toBeNull();
  });

  it('reports each distinct divergence once — the condition is sticky', () => {
    const m = createWidthAgreementMonitor();
    const want = { cols: 109, rows: 45 };
    const got = { cols: 107, rows: 45 };
    expect(m.check('h1', want, got)).not.toBeNull();
    // A 15s sweep would otherwise emit this every tick for the whole session.
    expect(m.check('h1', want, got)).toBeNull();
    expect(m.check('h1', want, got)).toBeNull();
  });

  it('reports again when the divergence changes shape', () => {
    const m = createWidthAgreementMonitor();
    expect(m.check('h1', { cols: 109, rows: 45 }, { cols: 107, rows: 45 })).not.toBeNull();
    expect(m.check('h1', { cols: 130, rows: 45 }, { cols: 107, rows: 45 })).not.toBeNull();
  });

  it('keeps handles independent', () => {
    const m = createWidthAgreementMonitor();
    const want = { cols: 109, rows: 45 };
    const got = { cols: 107, rows: 45 };
    expect(m.check('h1', want, got)).not.toBeNull();
    expect(m.check('h2', want, got)).not.toBeNull();
  });

  it('treats an unreportable size as unknown, not as agreement', () => {
    // Container/broker handles cannot read their size back. Absence of
    // evidence must not be logged as evidence of absence.
    const m = createWidthAgreementMonitor();
    expect(m.check('h1', { cols: 109, rows: 45 }, undefined)).toBeNull();
    expect(m.check('h1', undefined, { cols: 107, rows: 45 })).toBeNull();
  });

  it('forget() drops only that handle, so a reused id can report again', () => {
    const m = createWidthAgreementMonitor();
    const want = { cols: 109, rows: 45 };
    const got = { cols: 107, rows: 45 };
    m.check('h1', want, got);
    m.check('h2', want, got);
    expect(m.size).toBe(2);

    m.forget('h1');
    expect(m.size).toBe(1);
    expect(m.check('h1', want, got)).not.toBeNull();
    expect(m.check('h2', want, got)).toBeNull();
  });
});
