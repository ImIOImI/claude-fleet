// One JSON line per event on stdout. Every string field passes through
// redactSecrets, and nothing logs request headers.

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9_.~+/=-]+/gi,
  /\bgh[opsu]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(l + '\n'), now: () => number = Date.now): Logger {
  return {
    log(level, msg, fields = {}) {
      const rec: Record<string, unknown> = { ts: new Date(now()).toISOString(), level, msg: redactSecrets(msg) };
      for (const [k, v] of Object.entries(fields)) rec[k] = typeof v === 'string' ? redactSecrets(v) : v;
      sink(JSON.stringify(rec));
    }
  };
}
