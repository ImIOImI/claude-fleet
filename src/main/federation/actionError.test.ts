import { describe, expect, it } from 'vitest';
import { actionError } from './actionError.js';
import { RemoteError } from '../remoteClient.js';
import { RemoteShapeError } from './remoteRows.js';

describe('actionError', () => {
  it('a connect timeout on a write is unavailable (id kept), not read as unreachable', () => {
    const err = new RemoteError('unreachable', 'http://h is not reachable (timed out); check your network or VPN');
    expect(actionError(err, 'review-bot')).toEqual({
      kind: 'unavailable',
      message: 'No answer from review-bot in 15 s; it may have gone through. Retrying is safe (same request).'
    });
  });

  it('a reply-read timeout maps the same way, and falls back to "the host" without a name', () => {
    const err = new RemoteError('unreachable', 'http://h reply timed out; check your network or VPN');
    expect(actionError(err)).toEqual({
      kind: 'unavailable',
      message: 'No answer from the host in 15 s; it may have gone through. Retrying is safe (same request).'
    });
  });

  it('other reachability failures keep their current mapping (unavailable, original message)', () => {
    expect(actionError(new RemoteError('unreachable', 'http://h is not reachable (ECONNREFUSED); check your network or VPN'))).toEqual({
      kind: 'unavailable', message: 'http://h is not reachable (ECONNREFUSED); check your network or VPN'
    });
    expect(actionError(new RemoteError('standby', 'standby', 503)).kind).toBe('unavailable');
    expect(actionError(new RemoteError('not-signed-in', 'sign in again')).kind).toBe('unavailable');
    expect(actionError(new RemoteError('unauthorized', 'bad token', 401)).kind).toBe('unavailable');
  });

  it('a reply-shape error after the request was sent keeps the id (unavailable), not failed', () => {
    const r = actionError(new RemoteShapeError('malformed action reply'));
    expect(r.kind).toBe('unavailable');
    expect(r.message).toMatch(/may have gone through/);
    expect(r.message).toMatch(/retrying is safe/i);
  });

  it('a malformed rpc envelope or an over-cap reply (both "protocol") also keep the id', () => {
    for (const msg of ['http://h rpc automations:run failed', 'http://h reply is too large']) {
      const r = actionError(new RemoteError('protocol', msg));
      expect(r.kind).toBe('unavailable');
      expect(r.message).toMatch(/may have gone through/);
    }
  });

  it('forbidden, invalid (400) and busy (429, with Retry-After) are unaffected', () => {
    expect(actionError(new RemoteError('forbidden', 'needs steer', 403))).toEqual({ kind: 'forbidden', message: 'needs steer' });
    expect(actionError(new RemoteError('protocol', 'id must be an id', 400)).kind).toBe('invalid');
    expect(actionError(new RemoteError('unreachable', 'busy', 429, 7_000))).toEqual({ kind: 'busy', message: 'the host is busy; try again shortly', retryAfterMs: 7_000 });
  });

  it('a non-RemoteError, non-shape throw stays failed', () => {
    expect(actionError(new Error('boom'))).toEqual({ kind: 'failed', message: 'boom' });
  });
});
