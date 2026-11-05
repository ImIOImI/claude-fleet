// Knowledge claims (#483): input validation + secret backstop for record_claim.
import { CLAIM_KINDS, CLAIM_TEXT_MAX, TOPIC_RE, type ClaimInput, type ClaimKind } from './types.js';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function validateClaimInput(a: Record<string, unknown>): ClaimInput {
  const text = str(a.text)?.trim() ?? '';
  if (!text) throw new Error('text is required');
  if (text.length > CLAIM_TEXT_MAX) throw new Error(`text must be at most ${CLAIM_TEXT_MAX} characters — split it into separate claims`);
  const kind = str(a.kind);
  if (!kind || !(CLAIM_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${CLAIM_KINDS.join(', ')}`);
  if (!Array.isArray(a.topics)) throw new Error('topics must be an array of 1-3 slugs');
  const topics = [...new Set(a.topics.map((t) => String(t).trim().toLowerCase()))];
  if (topics.length < 1 || topics.length > 3) throw new Error('topics must be an array of 1-3 slugs');
  const badTopic = topics.find((t) => !TOPIC_RE.test(t));
  if (badTopic !== undefined) throw new Error(`topic "${badTopic}" must match ${TOPIC_RE}`);
  let refs: string[] = [];
  if (a.refs !== undefined) {
    if (!Array.isArray(a.refs) || a.refs.length > 10) throw new Error('refs must be an array of at most 10 strings');
    refs = a.refs.map((r) => String(r).slice(0, 200));
  }
  const visibility = a.visibility === undefined ? 'fleet' : a.visibility;
  if (visibility !== 'fleet' && visibility !== 'private') throw new Error('visibility must be "fleet" or "private"');
  return {
    text, kind: kind as ClaimKind, topics, refs, visibility,
    supersedes: str(a.supersedes), captureRun: str(a.capture_run)
  };
}

// Pattern classes, most specific first. A backstop, not a guarantee (spec §7).
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
  ['assignment-secret', /\b(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*['"]?[A-Za-z0-9_\-/+]{16,}/i]
];

export function findSecret(text: string): string | null {
  for (const [cls, re] of SECRET_PATTERNS) if (re.test(text)) return cls;
  return null;
}
