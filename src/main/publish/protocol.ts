// POST /publish wire format (remote-workspaces §7). Pure: shared by the desktop publisher and fleet-host.
import { createHash } from 'node:crypto';

export const PUBLISH_MAX_BODY = 1024 * 1024;
/** INGEST_TX_LINES: one request is one fenced ingest transaction on the host. */
export const PUBLISH_MAX_LINES = 500;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PublishBatch<L extends string = string> {
  sourceWorkspaceId: string;
  sessionId: string;
  events: L[];
}

export interface PublishAck {
  ok: true;
  accepted: number;
  inserted: number;
}

/** From the verified identity only, never from a request body. */
export interface PublishOwner {
  provider: string;
  id: number;
  login: string;
}

export class PublishArgError extends Error {}

const FIELDS = new Set(['sourceWorkspaceId', 'sessionId', 'events']);

export function parsePublishBody(v: unknown): PublishBatch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PublishArgError('body must be {sourceWorkspaceId, sessionId, events}');
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.has(k));
  if (extra !== undefined) throw new PublishArgError(`unknown field: ${extra.slice(0, 40)}`);
  if (typeof o.sourceWorkspaceId !== 'string' || !ULID_RE.test(o.sourceWorkspaceId)) throw new PublishArgError('sourceWorkspaceId must be a workspace id');
  if (typeof o.sessionId !== 'string' || !SESSION_UUID_RE.test(o.sessionId)) throw new PublishArgError('sessionId must be a lowercase session UUID');
  const events = o.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > PUBLISH_MAX_LINES) {
    throw new PublishArgError(`events must hold 1-${PUBLISH_MAX_LINES} lines`);
  }
  events.forEach((l, i) => {
    if (typeof l !== 'string' || !l || /[\r\n]/.test(l)) throw new PublishArgError(`events[${i}] must be one JSONL line`);
    let p: unknown;
    try {
      p = JSON.parse(l);
    } catch {
      throw new PublishArgError(`events[${i}] is not JSON`);
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PublishArgError(`events[${i}] must be a JSON object`);
  });
  return { sourceWorkspaceId: o.sourceWorkspaceId, sessionId: o.sessionId, events: events as string[] };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Keyed on the account id, not the login: logins can be renamed and reused. */
export function partitionIdFor(owner: Pick<PublishOwner, 'provider' | 'id'>, sourceWorkspaceId: string): string {
  return `pub_${sha(`${owner.provider}:${owner.id}\0${sourceWorkspaceId}`).slice(0, 32)}`;
}

/** Derived per partition, so no caller can name a session outside its own partition. */
export function publishedSessionId(partitionId: string, sourceSessionId: string): string {
  const h = sha(`${partitionId}\0${sourceSessionId}`);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
