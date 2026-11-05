import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** A SCRAM-SHA-256 verifier in Postgres's stored form. `ALTER ROLE … PASSWORD
 *  '<verifier>'` sets a password without the plaintext reaching the server, its
 *  logs or a process argument list. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
