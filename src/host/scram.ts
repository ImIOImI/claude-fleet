// A SCRAM-SHA-256 verifier (RFC 7677, Postgres's rolpassword format), so CREATE ROLE never sends the plaintext.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  // Postgres SASLpreps the password; for printable ASCII that is the identity.
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('the app role password must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (s: string) => createHmac('sha256', salted).update(s).digest();
  const stored = createHash('sha256').update(hmac('Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac('Server Key').toString('base64')}`;
}
