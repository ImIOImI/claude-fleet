import { describe, expect, it } from 'vitest';
import { parseSourceError, SOURCE_PRIVATE_PROMPT } from './sourceErrors';

const ipcErr = (msg: string): Error => new Error(`Error invoking remote method 'loadouts:addSource': Error: ${msg}`);

describe('parseSourceError (#444)', () => {
  it('recognises needs-credential through the Electron IPC wrapper', () => {
    expect(parseSourceError(ipcErr('needs-credential: ghcr.io/acme/private'))).toEqual({
      kind: 'needs-credential',
      base: 'ghcr.io/acme/private',
      message: SOURCE_PRIVATE_PROMPT
    });
    expect(SOURCE_PRIVATE_PROMPT).toBe('This source is private. Add a token:');
  });

  it('recognises credential-rejected with its status', () => {
    expect(parseSourceError(ipcErr('credential-rejected: ghcr.io/acme/private (HTTP 403)'))).toEqual({
      kind: 'credential-rejected',
      base: 'ghcr.io/acme/private',
      status: 403,
      message: 'credential rejected (HTTP 403)'
    });
  });

  it('passes other errors through with the IPC prefix stripped', () => {
    expect(parseSourceError(ipcErr('index is not an array of loadouts'))).toEqual({
      kind: 'other',
      message: 'index is not an array of loadouts'
    });
    expect(parseSourceError('boom')).toEqual({ kind: 'other', message: 'boom' });
  });
});

describe('parseSourceError malformed-credential (#444, not in the original brief)', () => {
  it('recognises malformed-credential with UI copy that never fakes an HTTP status', () => {
    expect(parseSourceError(ipcErr('malformed-credential: ghcr.io/acme/private'))).toEqual({
      kind: 'malformed-credential',
      base: 'ghcr.io/acme/private',
      message: 'That token contains spaces or invalid characters. Paste it again.'
    });
  });

  it('passes through the IPC wrapper without the inner "Error: " prefix too', () => {
    const bare = new Error("Error invoking remote method 'loadouts:setSourceCredential': malformed-credential: ghcr.io/acme/private");
    expect(parseSourceError(bare).kind).toBe('malformed-credential');
  });
});
