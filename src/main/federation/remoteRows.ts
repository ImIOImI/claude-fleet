// Host replies are untrusted (remote-workspaces §9): every field checked,
// strings one-lined and capped, arrays capped. A bad row is dropped; a bad
// envelope throws, which marks the source unavailable.
import { oneLine } from '../remoteUrl.js';
import type { WorkspaceSummary } from '../db.js';
import type { SessionCursor } from '../../preload/federation.js';
import { MAX_OWNER_COST_ROWS, parseSessionOwner, type OwnerCostRow, type SessionOwner } from '../../preload/sessionOwner.js';

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
  owner: SessionOwner | null;
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
  const owner = r.owner === undefined || r.owner === null ? null : parseSessionOwner(r.owner);
  return { id: r.id, workspaceId, aiTitle, firstUserMessage, userSetName, startedAt, lastActiveAt, eventCount: r.eventCount, usd: r.usd, tags, headless: r.headless, owner };
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

export const MAX_SEARCH_HITS = 50;
const MAX_HIT_TEXT = 1000;

export type RemoteSearchHit = { sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; score: number };

/** Hit text keeps newlines and tabs; the renderer shows it as a text node. */
export function parseSearchReply(v: unknown, workspaceId: string): { modelId: string; hits: RemoteSearchHit[] } {
  const o = v as { modelId?: unknown; hits?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.modelId !== 'string' || !Array.isArray(o.hits) || o.hits.length > MAX_SEARCH_HITS) return fail('search reply');
  const hits: RemoteSearchHit[] = [];
  for (const raw of o.hits) {
    const h = raw as Record<string, unknown> | null;
    if (!h || typeof h !== 'object' || typeof h.sessionId !== 'string' || !ID_RE.test(h.sessionId) || h.workspaceId !== workspaceId) continue;
    const ts = natOrNull(h.ts);
    if ((h.kind !== 'turn' && h.kind !== 'summary') || ts === undefined || typeof h.text !== 'string') continue;
    if (typeof h.score !== 'number' || !Number.isFinite(h.score) || h.score < -1.0001 || h.score > 1.0001) continue;
    hits.push({ sessionId: h.sessionId, workspaceId, kind: h.kind, ts, text: h.text.replace(/[\x00-\x08\x0b-\x1f\x7f\p{Cf}]/gu, ' ').slice(0, MAX_HIT_TEXT), score: h.score });
  }
  return { modelId: oneLine(o.modelId, 128), hits };
}

/** `history:owners`. A row with a malformed owner is dropped rather than shown as unattributed. */
export function parseOwnerCosts(v: unknown): OwnerCostRow[] {
  const o = v as { rows?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows) || o.rows.length > MAX_OWNER_COST_ROWS) return fail('owner costs');
  const out: OwnerCostRow[] = [];
  for (const raw of o.rows) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !nat(r.sessions) || !nonNeg(r.usd)) continue;
    const owner = r.owner === null ? null : parseSessionOwner(r.owner);
    if (r.owner !== null && !owner) continue;
    out.push({ owner, sessions: r.sessions, usd: r.usd });
  }
  return out;
}
