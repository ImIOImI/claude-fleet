import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { scramVerifier } from './scram.js';

// RFC 7677 §3: user "user", password "pencil".
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const AUTH_MESSAGE =
  'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
  'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
  'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

function parse(v: string) {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(v);
  if (!m) throw new Error(`not a verifier: ${v}`);
  return { iterations: Number(m[1]), salt: m[2], storedKey: Buffer.from(m[3], 'base64'), serverKey: Buffer.from(m[4], 'base64') };
}

it('matches the RFC 7677 test vector (server signature and stored key)', () => {
  const v = parse(scramVerifier('pencil', SALT));
  expect(v.iterations).toBe(4096);
  expect(v.salt).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
  expect(createHmac('sha256', v.serverKey).update(AUTH_MESSAGE).digest('base64')).toBe(SERVER_SIGNATURE);
  const sig = createHmac('sha256', v.storedKey).update(AUTH_MESSAGE).digest();
  const clientKey = Buffer.from(Buffer.from(CLIENT_PROOF, 'base64').map((b, i) => b ^ sig[i]));
  expect(createHash('sha256').update(clientKey).digest().equals(v.storedKey)).toBe(true);
});

it('uses a fresh salt by default and never contains the password', () => {
  const a = scramVerifier('s3cret-value');
  expect(a).not.toBe(scramVerifier('s3cret-value'));
  expect(a).not.toContain('s3cret-value');
  expect(a).not.toContain("'");
});
