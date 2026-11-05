import { describe, expect, it } from 'vitest';
import { scramVerifier } from './scram.js';

describe('scramVerifier', () => {
  it('matches the verifier Postgres stores for the same salt', () => {
    expect(scramVerifier('pencil', Buffer.from('ZaLhsOYt3HI1Xl6W2BIRVQ==', 'base64'))).toBe(
      'SCRAM-SHA-256$4096:ZaLhsOYt3HI1Xl6W2BIRVQ==$/9fm51v0kDRJ29/IqdwV4XKERxRdSHkXS/k5YnjmWP8=:QKeKcn4lxjHfowZWKEhryi3VPCCRQ0+4xGFR7k7gfH0='
    );
  });

  it('salts each call and never contains the password', () => {
    const a = scramVerifier('pencil-secret');
    expect(a).not.toBe(scramVerifier('pencil-secret'));
    expect(a).not.toContain('pencil-secret');
  });

  it('refuses a non-ASCII password (SASLprep is not implemented)', () => {
    expect(() => scramVerifier('pässword')).toThrow(/printable ASCII/);
  });
});
