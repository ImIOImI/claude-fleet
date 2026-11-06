import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/** No mode between: TLS that skips verification is never configurable. */
export type SslMode = 'disable' | 'verify-full';

/** pg `ssl` for a mode. verify-full = chain to `caFile` + hostname check
 *  (Node's default checkServerIdentity against the connect host). */
export function pgSsl(mode: SslMode | undefined, caFile?: string): false | ConnectionOptions {
  if (!mode || mode === 'disable') return false;
  if (mode !== 'verify-full') throw new Error('ssl mode must be "disable" or "verify-full"');
  if (!caFile) throw new Error('ssl verify-full needs caFile (the server CA bundle)');
  return Object.freeze({ ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true });
}
