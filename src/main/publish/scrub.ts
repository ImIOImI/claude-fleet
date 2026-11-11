// Publish scrubbing (remote-workspaces §7, §9). Pure: the desktop publisher and fleet-host both run it.
import { redactSecrets } from '../identity/redact.js';

export interface ScrubValue {
  key: string;
  value: string;
}

declare const scrubbedBrand: unique symbol;
/** Only makeScrubber returns this; RemoteClient.publish accepts nothing else. */
export type ScrubbedLine = string & { readonly [scrubbedBrand]: true };

/** Shorter values would match ordinary words. */
export const MIN_SECRET_LEN = 8;

const AWS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g;
// A digit is required so prose like "xoxo-hugs-and-kisses" survives.
const SLACK_TOKEN = /(?<![A-Za-z0-9])xox[abposr]-(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9-]{10,}/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const NAME = String.raw`((?<![A-Za-z0-9_])(?:export\s+)?[A-Za-z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?!\[redacted)`;
// Serialized JSON gets no quoted form: a match there could swallow a string's closing quote.
const ASSIGN_DECODED = new RegExp(`${NAME}("[^"\\n]*"|'[^'\\n]*'|[^\\s"'\\\\]+)`, 'gi');
const ASSIGN_TEXT = new RegExp(`${NAME}([^\\s"'\\\\]+)`, 'gi');

type Swap = Array<[RegExp, string]>;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeKey = (k: string): string => k.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'SECRET';

function compile(values: readonly ScrubValue[]): { decoded: Swap; escaped: Swap } {
  const decoded: Swap = [];
  const escaped: Swap = [];
  const seen = new Set<string>();
  for (const v of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (v.value.length < MIN_SECRET_LEN || seen.has(v.value)) continue;
    seen.add(v.value);
    const label = `[redacted:${safeKey(v.key)}]`;
    decoded.push([new RegExp(escapeRe(v.value), 'g'), label]);
    escaped.push([new RegExp(escapeRe(JSON.stringify(v.value).slice(1, -1)), 'g'), label]);
  }
  return { decoded, escaped };
}

const swap = (s: string, list: Swap): string => list.reduce((acc, [re, label]) => acc.replace(re, () => label), s);
const patterns = (s: string, assign: RegExp): string =>
  redactSecrets(s).replace(AWS_KEY, '[redacted]').replace(SLACK_TOKEN, '[redacted]').replace(JWT, '[redacted]').replace(assign, '$1[redacted]');

/** Strips every secret value and known token shape from one JSONL line; a clean line keeps its bytes (and dedup key). */
export function makeScrubber(values: readonly ScrubValue[]): (line: string) => ScrubbedLine {
  const c = compile(values);
  const text = (s: string): string => patterns(swap(s, c.decoded), ASSIGN_DECODED);
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return text(line) as ScrubbedLine;
    }
    const after = JSON.stringify(deep(parsed));
    const out = after === JSON.stringify(parsed) ? line : after;
    // Backstop on the serialized form, as host ingest's redactJsonLine does.
    return patterns(swap(out, c.escaped), ASSIGN_TEXT) as ScrubbedLine;
  };
}
