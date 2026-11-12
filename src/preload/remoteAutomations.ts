// Remote automations (remote-workspaces (g)): types and constants shared by
// fleet-host, main and the renderer. Pure.
import type { Automation, InboxCounts, NotificationKind, Proposal, RunRow, Todo, TodoPriority } from './inboxTypes.js';
import type { UnavailableSource } from './federation.js';

/** A lowercase UUID v4: one per user intent; a retry reuses it (D128). */
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every host action channel's reply. result null and error null on a replay: the first attempt is in flight or was interrupted. */
export interface HostActionReply {
  replayed: boolean;
  result: unknown;
  error: string | null;
}

export type RemoteTierName = 'read' | 'steer' | 'session';

/** What every federated row carries: which host, its name and hue, and the viewer's tier there (display only). */
export interface RemoteOriginInfo {
  origin: string;
  workspaceName: string;
  workspaceColorHue: number | null;
  tier: RemoteTierName | null;
}

export type RemoteAutomation = Omit<Automation, 'origin'> & RemoteOriginInfo & { managedBy: 'host-config' | null };
export type RemoteTodo = Todo & RemoteOriginInfo;
export type RemoteProposal = Proposal & RemoteOriginInfo;

export interface Federated<T> { items: T[]; unavailable: UnavailableSource[] }
export interface RemoteAutomationDetail { automation: RemoteAutomation; runs: RunRow[]; yaml: string }
export interface RemoteCounts extends Required<InboxCounts> { unavailable: UnavailableSource[] }

export type RemoteActionErrorKind = 'forbidden' | 'unavailable' | 'invalid' | 'busy' | 'failed';
export type RemoteActionResult<T> =
  | { ok: true; replayed: boolean; result: T | null }
  | { ok: false; kind: RemoteActionErrorKind; message: string; retryAfterMs?: number };

export type RemoteChangeChannel = 'automations:changed' | 'proposals:changed' | 'inbox:changed' | 'notices:changed';
export const REMOTE_CHANGE_CHANNELS: readonly RemoteChangeChannel[] = ['automations:changed', 'proposals:changed', 'inbox:changed', 'notices:changed'];
export interface RemoteChange { origin: string; channel: RemoteChangeChannel }

export const NOTICE_KINDS: readonly NotificationKind[] = ['post', 'todo', 'run-failed', 'proposal'];
export interface RemoteNotice {
  id: string;
  ts: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  priority: TodoPriority;
  dedupeKey: string | null;
}
