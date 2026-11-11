// Publish scrubbing (remote-workspaces §7, §9). Pure: the desktop publisher and fleet-host both run it.
import { redactSecrets } from '../identity/redact.js';

export interface ScrubValue {
  key: string;
  value: string;
}

declare const scrubbedBrand: unique symbol;
/** Only makeScrubber returns this; RemoteClient.publish accepts nothing else. Type-level only: scrubBrand.test.ts forbids `as ScrubbedLine` elsewhere. */
export type ScrubbedLine = string & { readonly [scrubbedBrand]: true };

/** Shorter values would match ordinary words. */
export const MIN_SECRET_LEN = 8;
/** Deeper lines are refused, not recursed into. */
export const MAX_SCRUB_DEPTH = 64;

/** The line can't be published: the publish route answers 400, the publisher skips the line. */
export class UnpublishableLineError extends Error {
  override name = 'UnpublishableLineError';
}

// Every pattern must stay linear on 1 MiB input (scrub.timing.test.ts).
const AWS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g;
// The digit check runs on the match: a digit lookahead would rescan the run from every `xox?-` in it.
const SLACK_TOKEN = /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g;
const slackSwap = (m: string): string => (/\d/.test(m) ? '[redacted]' : m);
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const NAME = String.raw`((?<![A-Za-z0-9_])(?:export\s+)?[A-Za-z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?!\[redacted)`;
// Serialized JSON gets no quoted form: a match there could swallow a string's closing quote.
const ASSIGN_DECODED = new RegExp(`${NAME}("[^"\\n]*"|'[^'\\n]*'|[^\\s"'\\\\]+)`, 'gi');
const ASSIGN_TEXT = new RegExp(`${NAME}([^\\s"'\\\\]+)`, 'gi');
const LABEL = String.raw`\[redacted(?::[A-Za-z0-9_.:-]*)?\]`;

/** Exported for the linear-time tests. */
export const SCRUB_PATTERNS: Readonly<Record<string, RegExp>> = { AWS_KEY, SLACK_TOKEN, JWT, ASSIGN_DECODED, ASSIGN_TEXT };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeKey = (k: string): string => k.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'SECRET';
const jsonEscaped = (v: string): string => JSON.stringify(v).slice(1, -1);

/** One alternation, longest value first, so each position is replaced once and an existing label is never rewritten. */
export function secretValuePattern(values: readonly ScrubValue[], form: (v: string) => string = (v) => v): { re: RegExp; labels: Map<string, string> } | null {
  const labels = new Map<string, string>();
  for (const v of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (v.value.length < MIN_SECRET_LEN) continue;
    const f = form(v.value);
    if (!labels.has(f)) labels.set(f, `[redacted:${safeKey(v.key)}]`);
  }
  if (!labels.size) return null;
  const alts = [...labels.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  return { re: new RegExp(`${alts.join('|')}|${LABEL}`, 'g'), labels };
}

function valueSwap(values: readonly ScrubValue[], form?: (v: string) => string): (s: string) => string {
  const p = secretValuePattern(values, form);
  if (!p) return (s) => s;
  return (s) => s.replace(p.re, (m) => p.labels.get(m) ?? m);
}

const patterns = (s: string, assign: RegExp): string =>
  redactSecrets(s).replace(AWS_KEY, '[redacted]').replace(SLACK_TOKEN, slackSwap).replace(JWT, '[redacted]').replace(assign, '$1[redacted]');

/** Strips every secret value and known token shape from one JSONL line; a canonical clean line keeps its bytes (and dedup key). */
export function makeScrubber(values: readonly ScrubValue[]): (line: string) => ScrubbedLine {
  const decoded = valueSwap(values);
  const escaped = valueSwap(values, jsonEscaped);
  const text = (s: string): string => patterns(decoded(s), ASSIGN_DECODED);
  const deep = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (!v || typeof v !== 'object') return v;
    if (depth >= MAX_SCRUB_DEPTH) throw new UnpublishableLineError(`line nests deeper than ${MAX_SCRUB_DEPTH}`);
    if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), deep(x, depth + 1)]));
  };
  return (line) => {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return text(line) as ScrubbedLine;
      }
      // Always the re-serialized form: equal to `line` when it was canonical and clean, and a
      // non-canonical line (duplicate or \u-escaped keys) can't carry bytes the decoded pass never saw.
      const out = JSON.stringify(deep(parsed, 0));
      // Backstop on the serialized form, as host ingest's redactJsonLine does.
      return patterns(escaped(out), ASSIGN_TEXT) as ScrubbedLine;
    } catch (err) {
      if (err instanceof UnpublishableLineError) throw err;
      throw new UnpublishableLineError('line could not be scrubbed', { cause: err });
    }
  };
}
