// Without TLS nothing authenticates the server, so whoever holds the port can
// ask for the password in cleartext (or as a replayable MD5). SCRAM sends
// neither, and pg checks the server signature (sasl.js finalizeSession).
import pg from 'pg';

type AuthHooks = { connection: { emit(e: 'error', err: Error): void; stream: { destroy(): void } } };

function refuse(c: AuthHooks, kind: string): void {
  c.connection.emit('error', new Error(`refusing ${kind} password authentication without TLS; the server must use scram-sha-256`));
  c.connection.stream.destroy();
}

/** Overrides pg private hooks (client.js `_attachListeners`); pgScramOnly.test.ts pins their names. */
export class ScramOnlyClient extends pg.Client {
  _handleAuthCleartextPassword(): void { refuse(this as unknown as AuthHooks, 'cleartext'); }
  _handleAuthMD5Password(): void { refuse(this as unknown as AuthHooks, 'MD5'); }
}

/** Pool options for a connection's `ssl`: TLS keeps pg.Client (RDS IAM sends its token as cleartext over TLS). */
export function plaintextAuthGuard(ssl: unknown): { Client?: typeof ScramOnlyClient } {
  return ssl ? {} : { Client: ScramOnlyClient };
}
