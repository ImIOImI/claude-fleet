// Which broker frames a viewer may send on /attach, and the tier each needs.
// Absent types (every server-to-client frame) are protocol errors.
import { randomUUID } from 'node:crypto';
import { FrameType } from '../main/broker.js';
import type { Tier } from '../main/identity/grants.js';
import { claudeCreateArgs, RUNNER_HOOK_SETTINGS } from '../main/claudeArgs.js';

export const CLIENT_FRAME_TIER: ReadonlyMap<FrameType, Tier> = new Map<FrameType, Tier>([
  [FrameType.ATTACH, 'read'],
  [FrameType.DETACH, 'read'],
  [FrameType.LIST, 'read'],
  [FrameType.LISTPORTS, 'read'],
  [FrameType.INPUT, 'steer'],
  [FrameType.RESIZE, 'steer'],
  [FrameType.KILLPORT, 'steer'],
  [FrameType.DIAL, 'steer'],
  [FrameType.CREATE, 'session'],
  [FrameType.CLOSE, 'session']
]);

/** The response frame a denied or failed request is answered with. */
export const RESPONSE_OF: ReadonlyMap<FrameType, FrameType> = new Map([
  [FrameType.CREATE, FrameType.CREATED],
  [FrameType.ATTACH, FrameType.ATTACHED],
  [FrameType.DETACH, FrameType.DETACHED],
  [FrameType.CLOSE, FrameType.CLOSED],
  [FrameType.LIST, FrameType.SESSIONS],
  [FrameType.DIAL, FrameType.DIALED],
  [FrameType.LISTPORTS, FrameType.PORTS],
  [FrameType.KILLPORT, FrameType.KILLED]
]);

export function decodeResize(payload: Buffer): { channel: number; cols: number; rows: number } {
  if (payload.length !== 8) throw new Error('resize frame must be 8 bytes');
  return { channel: payload.readUInt32BE(0), cols: payload.readUInt16BE(4), rows: payload.readUInt16BE(6) };
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What claude and randomUUID mint; any other id a viewer pins must already be this host's. */
export const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export interface GatedCreate {
  args: string[];
  /** Lower-cased. */
  sessionId: string;
  /** The viewer named the id (`--resume`/`--session-id`), so it still needs the pin check. */
  fromViewer: boolean;
}

/**
 * A viewer's CREATE args, rebuilt by the host. Only the shape the desktop
 * sends (`claudeCreateArgs`) is accepted, so a viewer can't append arbitrary
 * claude flags. The claude session id is always pinned, so its owner row
 * (D116) names it before claude starts. Null means refuse.
 */
export function hostCreateArgs(args: unknown, mint: () => string = randomUUID): GatedCreate | null {
  const fresh = (): GatedCreate => {
    const id = mint();
    return { args: claudeCreateArgs(undefined, id), sessionId: id, fromViewer: false };
  };
  if (args === undefined) return fresh();
  if (!Array.isArray(args)) return null;
  const rest = args[0] === '--settings' && args[1] === RUNNER_HOOK_SETTINGS ? args.slice(2) : args;
  if (rest.length === 0) return fresh();
  if (rest.length !== 2 || typeof rest[1] !== 'string' || !UUID_RE.test(rest[1])) return null;
  const id = rest[1].toLowerCase();
  if (rest[0] === '--resume') return { args: claudeCreateArgs(id), sessionId: id, fromViewer: true };
  if (rest[0] === '--session-id') return { args: claudeCreateArgs(undefined, id), sessionId: id, fromViewer: true };
  return null;
}
