// Secret shapes cut from text that may be shown or logged. Pure: shared by fleet-host and the desktop.

// `"` is excluded from token classes so redacting a serialized line keeps it valid JSON.
// Not preceded by an alphanumeric, unless that ends a JSON escape (`\n`) or an ANSI CSI code (raw or `\u001b`-escaped).
const NB = '(?:(?<![A-Za-z0-9])|(?<=\\\\[nrtbf])|(?<=\\x1b\\[[0-9;?]*[A-Za-z])|(?<=\\\\u001[bB]\\[[0-9;?]*[A-Za-z]))';
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
