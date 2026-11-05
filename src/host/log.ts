// One JSON line per event on stdout. Strings are redacted, then the whole
// serialized line is redacted again so nested values can't leak. Nothing logs
// request headers.

import { redactSecrets } from '../main/identity/redact.js';

export { redactSecrets };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

function redactValue(_key: string, v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(l + '\n'), now: () => number = Date.now): Logger {
  return {
    log(level, msg, fields = {}) {
      const head = { ts: new Date(now()).toISOString(), level, msg: redactSecrets(msg) };
      let line: string;
      try {
        line = JSON.stringify({ ...head, ...fields, ...head }, redactValue);
      } catch {
        line = JSON.stringify({ ...head, error: 'unserializable fields' });
      }
      // Backstop only: escapes such as `\n` hide token boundaries from this pass.
      sink(redactSecrets(line));
    }
  };
}
