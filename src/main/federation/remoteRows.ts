// Host replies are untrusted (remote-workspaces §9): every field checked,
// strings one-lined and capped, arrays capped. A bad row is dropped; a bad
// envelope throws, which marks the source unavailable.
import { oneLine } from '../remoteUrl.js';
import type { WorkspaceSummary } from '../db.js';
import type { SessionCursor } from '../../preload/federation.js';

export class RemoteShapeError extends Error {}

export const MAX_REMOTE_SESSIONS = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TITLE = 500;

export interface RemoteSessionItem {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  tags: string[];
  headless: boolean;
}

const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const natOrNull = (v: unknown): number | null | undefined => (v === null ? null : nat(v) ? v : undefined);
const text = (v: unknown, max: number): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? oneLine(v, max) || null : undefined;
const fail = (what: string): never => { throw new RemoteShapeError(`malformed ${what}`); };

function parseCursor(v: unknown): SessionCursor | null {
  if (v === null || v === undefined) return null;
  const c = v as { lastActiveAt?: unknown; id?: unknown };
  if (!c || typeof c !== 'object' || !nat(c.lastActiveAt) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return fail('cursor');
  return { lastActiveAt: c.lastActiveAt, id: c.id };
}

function parseSessionRow(v: unknown, workspaceId: string): RemoteSessionItem | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id) || r.workspaceId !== workspaceId) return null;
  const aiTitle = text(r.aiTitle, MAX_TITLE), firstUserMessage = text(r.firstUserMessage, MAX_TITLE), userSetName = text(r.userSetName, MAX_TITLE);
  const startedAt = natOrNull(r.startedAt), lastActiveAt = natOrNull(r.lastActiveAt);
  if (aiTitle === undefined || firstUserMessage === undefined || userSetName === undefined || startedAt === undefined || lastActiveAt === undefined) return null;
  if (!nat(r.eventCount) || typeof r.usd !== 'number' || !Number.isFinite(r.usd) || r.usd < 0 || typeof r.headless !== 'boolean' || !Array.isArray(r.tags)) return null;
  const tags = r.tags.filter((t): t is string => typeof t === 'string').slice(0, 20).map((t) => oneLine(t, 64)).filter(Boolean);
  return { id: r.id, workspaceId, aiTitle, firstUserMessage, userSetName, startedAt, lastActiveAt, eventCount: r.eventCount, usd: r.usd, tags, headless: r.headless };
}

export function parseSessionsPage(v: unknown, workspaceId: string): { rows: RemoteSessionItem[]; next: SessionCursor | null } {
  const o = v as { rows?: unknown; next?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows) || o.rows.length > MAX_REMOTE_SESSIONS) return fail('sessions page');
  const rows: RemoteSessionItem[] = [];
  for (const r of o.rows) {
    const row = parseSessionRow(r, workspaceId);
    if (row) rows.push(row);
  }
  return { rows, next: parseCursor(o.next) };
}

const STATUSES = new Set(['ok', 'error', 'pending']);
const nonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const series = (v: unknown, max: number, ok: (n: unknown) => n is number): number[] => {
  if (!Array.isArray(v)) return fail('summary series');
  return v.slice(-max).map((n) => (ok(n) ? n : fail('summary series')));
};

type ToolCall = WorkspaceSummary['recentToolCalls'][number];
function parseToolCall(v: unknown): ToolCall | null {
  const x = v as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return null;
  const input = text(x.input, 2000), durationMs = natOrNull(x.durationMs), ts = natOrNull(x.ts);
  if (typeof x.name !== 'string' || input === undefined || durationMs === undefined || ts === undefined || !STATUSES.has(x.status as string)) return null;
  return { name: oneLine(x.name, 64), input, durationMs, status: x.status as ToolCall['status'], ts };
}

export function parseSummary(v: unknown): WorkspaceSummary | null {
  if (v === null) return null;
  const s = v as Record<string, unknown>;
  if (!s || typeof s !== 'object') return fail('summary');
  const sessionId = s.sessionId === null ? null : typeof s.sessionId === 'string' && ID_RE.test(s.sessionId) ? s.sessionId : fail('summary');
  const title = text(s.title, MAX_TITLE), model = text(s.model, 128);
  const startedAt = natOrNull(s.startedAt), lastActiveAt = natOrNull(s.lastActiveAt), lastTurn = natOrNull(s.lastTurnContextTokens);
  if (title === undefined || model === undefined || startedAt === undefined || lastActiveAt === undefined || lastTurn === undefined) return fail('summary');
  for (const k of ['eventCount', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'contextWindowTokens']) {
    if (!nat(s[k])) return fail('summary');
  }
  if (!nonNeg(s.usd) || !Array.isArray(s.topTools) || !Array.isArray(s.recentToolCalls)) return fail('summary');
  const topTools = s.topTools.slice(0, 20).map((t) => {
    const x = t as { name?: unknown; count?: unknown };
    if (typeof x?.name !== 'string' || !nat(x.count)) return fail('summary tool');
    return { name: oneLine(x.name, 64), count: x.count };
  });
  const recentToolCalls = s.recentToolCalls.slice(0, 50).map(parseToolCall).filter((c): c is ToolCall => c !== null);
  return {
    sessionId, title, model, startedAt, lastActiveAt,
    eventCount: s.eventCount as number, inputTokens: s.inputTokens as number, outputTokens: s.outputTokens as number,
    cacheReadInputTokens: s.cacheReadInputTokens as number, cacheCreationInputTokens: s.cacheCreationInputTokens as number,
    usd: s.usd, lastTurnContextTokens: lastTurn, contextWindowTokens: s.contextWindowTokens as number,
    topTools, recentToolCalls, costSeries: series(s.costSeries, 200, nonNeg), tokenSeries: series(s.tokenSeries, 200, nat),
  };
}
