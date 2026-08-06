import { describe, expect, it } from 'vitest';
import {
  claudeAuthFromInitial,
  deriveAuthFields,
  modelFromInitial
} from './modelPicker';

describe('modelFromInitial', () => {
  it('defaults to claude when authMode is undefined', () => {
    expect(modelFromInitial(undefined, undefined)).toEqual({ kind: 'claude' });
  });
  it('maps oauth and apikey to claude', () => {
    expect(modelFromInitial('oauth', undefined)).toEqual({ kind: 'claude' });
    expect(modelFromInitial('apikey', undefined)).toEqual({ kind: 'claude' });
  });
  it('maps endpoint + id to an endpoint selection', () => {
    expect(modelFromInitial('endpoint', 'ep1')).toEqual({ kind: 'endpoint', endpointId: 'ep1' });
  });
  it('degrades endpoint WITHOUT id to claude (defensive)', () => {
    expect(modelFromInitial('endpoint', undefined)).toEqual({ kind: 'claude' });
  });
});

describe('claudeAuthFromInitial', () => {
  it('defaults to oauth (undefined, oauth, and endpoint all → oauth)', () => {
    expect(claudeAuthFromInitial(undefined)).toBe('oauth');
    expect(claudeAuthFromInitial('oauth')).toBe('oauth');
    expect(claudeAuthFromInitial('endpoint')).toBe('oauth');
  });
  it('preserves apikey', () => {
    expect(claudeAuthFromInitial('apikey')).toBe('apikey');
  });
});

describe('deriveAuthFields', () => {
  it('claude + oauth', () => {
    expect(deriveAuthFields({ kind: 'claude' }, 'oauth')).toEqual({
      authMode: 'oauth',
      endpointId: undefined
    });
  });
  it('claude + apikey', () => {
    expect(deriveAuthFields({ kind: 'claude' }, 'apikey')).toEqual({
      authMode: 'apikey',
      endpointId: undefined
    });
  });
  it('endpoint ignores the claude radio', () => {
    expect(deriveAuthFields({ kind: 'endpoint', endpointId: 'ep1' }, 'apikey')).toEqual({
      authMode: 'endpoint',
      endpointId: 'ep1'
    });
  });
});

describe('round-trips', () => {
  const cases: Array<['oauth' | 'apikey' | 'endpoint', string | undefined]> = [
    ['oauth', undefined],
    ['apikey', undefined],
    ['endpoint', 'ep1']
  ];
  it.each(cases)('%s/%s survives load → derive', (authMode, endpointId) => {
    const model = modelFromInitial(authMode, endpointId);
    const claudeAuth = claudeAuthFromInitial(authMode);
    expect(deriveAuthFields(model, claudeAuth)).toEqual({ authMode, endpointId });
  });
});
