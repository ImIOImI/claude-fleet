// Without TLS nothing authenticates the server, so whoever holds the port can
// ask for the password in cleartext (or as a replayable MD5). SCRAM sends
// neither, and pg checks the server signature (sasl.js finalizeSession).
import pg from 'pg';

type AuthHooks = { connection: { emit(e: 'error', err: Error): void; stream: { destroy(): void } } };

function refuse(c: AuthHooks, kind: string): void {
  c.connection.emit('error', new Error(`refusing ${kind} password authentication without TLS; the server must use scram-sha-256`));
  c.connection.stream.destroy();
}

type ConnectHooks = { _handleErrorWhileConnecting(err: Error): void };
const pgConnectError = (pg.Client.prototype as unknown as ConnectHooks)._handleErrorWhileConnecting;

/** A failed login hangs up. pg leaves the socket open (e.g. after a password provider throws mid-SCRAM), so the
 *  server backend waits in authentication until authentication_timeout and blocks every DROP DATABASE meanwhile. */
export class ClosingClient extends pg.Client {
  _handleErrorWhileConnecting(err: Error): void {
    pgConnectError.call(this, err);
    (this as unknown as AuthHooks).connection.stream.destroy();
  }
}

/** Overrides pg private hooks (client.js `_attachListeners`); pgScramOnly.test.ts pins their names. */
export class ScramOnlyClient extends ClosingClient {
  _handleAuthCleartextPassword(): void { refuse(this as unknown as AuthHooks, 'cleartext'); }
  _handleAuthMD5Password(): void { refuse(this as unknown as AuthHooks, 'MD5'); }
}

/** Pool options for a connection's `ssl`: TLS allows cleartext (RDS IAM sends its token that way). */
export function pgClientFor(ssl: unknown): { Client: typeof ClosingClient } {
  return { Client: ssl ? ClosingClient : ScramOnlyClient };
}
