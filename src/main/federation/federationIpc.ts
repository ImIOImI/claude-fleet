// sessions:listRemote: the remote half of the Sessions list (remote-workspaces
// (d)). The local half stays sessions:list; the renderer merges the two.
import type { IpcMain } from 'electron';
import type { SessionCursor } from '../../preload/federation.js';
import type { FederatedReader } from './federatedReader.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** workspaces.ts REMOTE_ID_RE, kept local so this module stays Electron-free. */
const REMOTE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function parseReq(v: unknown): { origin?: string; after?: SessionCursor } {
  if (v === undefined || v === null) return {};
  const o = v as { origin?: unknown; after?: { lastActiveAt?: unknown; id?: unknown } };
  if (typeof o.origin !== 'string' || !REMOTE_ID_RE.test(o.origin)) throw new Error('origin must be a remote workspace id');
  if (!('after' in o) || o.after === undefined) return { origin: o.origin };
  const a = o.after;
  if (!a || typeof a.lastActiveAt !== 'number' || !Number.isSafeInteger(a.lastActiveAt) || a.lastActiveAt < 0 || typeof a.id !== 'string' || !ID_RE.test(a.id)) {
    throw new Error('after must be a session cursor');
  }
  return { origin: o.origin, after: { lastActiveAt: a.lastActiveAt, id: a.id } };
}

export function registerFederationIpc(ipc: Pick<IpcMain, 'handle'>, reader: FederatedReader): void {
  ipc.handle('sessions:listRemote', async (_e, req: unknown) => reader.listSessions(parseReq(req)));
}
