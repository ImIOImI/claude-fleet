import { afterEach, describe, expect, it } from 'vitest';
import { logError, setErrorSink } from './errorLog.js';

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

