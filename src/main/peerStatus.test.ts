import { describe, expect, it } from 'vitest';
import { parsePeerStatus } from './peerStatus.js';

// A claude peer-status file: ~/.claude/sessions/<pid>.json (#286).
const idle = JSON.stringify({
  pid: 41420,
  sessionId: 'd5253cbc-1111-2222-3333-444455556666',
  cwd: '/workspace',
  status: 'idle',
  statusUpdatedAt: 1786158403021
});

describe('parsePeerStatus', () => {
  it('parses a well-formed idle file', () => {
    expect(parsePeerStatus(idle)).toEqual({
      sessionId: 'd5253cbc-1111-2222-3333-444455556666',
      status: 'idle',
      statusUpdatedAt: 1786158403021
    });
  });

  it('parses busy and waiting, carrying waitingFor', () => {
    expect(parsePeerStatus(JSON.stringify({ sessionId: 's1', status: 'busy' }))).toEqual({
      sessionId: 's1',
      status: 'busy'
    });
    const w = parsePeerStatus(
      JSON.stringify({ sessionId: 's2', status: 'waiting', waitingFor: 'input needed' })
    );
    expect(w).toEqual({ sessionId: 's2', status: 'waiting', waitingFor: 'input needed' });
  });

  it('rejects unknown status values', () => {
    expect(parsePeerStatus(JSON.stringify({ sessionId: 's1', status: 'thinking' }))).toBeNull();
  });

  it('rejects missing/invalid sessionId', () => {
    expect(parsePeerStatus(JSON.stringify({ status: 'idle' }))).toBeNull();
    expect(parsePeerStatus(JSON.stringify({ sessionId: '', status: 'idle' }))).toBeNull();
    expect(parsePeerStatus(JSON.stringify({ sessionId: 42, status: 'idle' }))).toBeNull();
  });

  it('tolerates malformed / partial JSON (mid-write) by returning null', () => {
    expect(parsePeerStatus('{"sessionId":"s1","status":"id')).toBeNull();
    expect(parsePeerStatus('')).toBeNull();
    expect(parsePeerStatus('not json')).toBeNull();
  });

  it('drops a non-numeric statusUpdatedAt rather than failing', () => {
    expect(parsePeerStatus(JSON.stringify({ sessionId: 's1', status: 'idle', statusUpdatedAt: 'x' }))).toEqual({
      sessionId: 's1',
      status: 'idle'
    });
  });
});
