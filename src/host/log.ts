// One JSON line per event on stdout. Strings are redacted, then the whole
// serialized line is redacted again so nested values can't leak. Nothing logs
// request headers.

// `"` is excluded from token classes so redacting a serialized line keeps it valid JSON.
const NB = '(?<![A-Za-z0-9])';
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=")|$)/g, '[redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"]+:[^\s/@"]+@/gi, '$1[redacted]@'],
  [new RegExp(`${NB}Bearer\\s+[A-Za-z0-9_.~+/=-]+`, 'gi'), '[redacted]'],
  [new RegExp(`${NB}Basic\\s+[A-Za-z0-9+/]{8,}={0,2}`, 'gi'), '[redacted]'],
  [new RegExp(`${NB}token\\s+[0-9a-f]{40}(?![0-9a-f])`, 'gi'), '[redacted]'],
  [new RegExp(`${NB}gh[oprsu]_[A-Za-z0-9]{16,}`, 'g'), '[redacted]'],
  [new RegExp(`${NB}github_pat_[A-Za-z0-9_]{20,}`, 'g'), '[redacted]'],
  [new RegExp(`${NB}sk-ant-[A-Za-z0-9_-]{10,}`, 'g'), '[redacted]']
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(l + '\n'), now: () => number = Date.now): Logger {
  return {
    log(level, msg, fields = {}) {
      const rec: Record<string, unknown> = { ts: new Date(now()).toISOString(), level, msg: redactSecrets(msg) };
      for (const [k, v] of Object.entries(fields)) rec[k] = typeof v === 'string' ? redactSecrets(v) : v;
      sink(redactSecrets(JSON.stringify(rec)));
    }
  };
}
