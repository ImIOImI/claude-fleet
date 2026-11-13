// Pure rules for remote automations in the Inbox. Display only: the host
// tier-checks every action and dedupes each request id.
import { stringify } from 'yaml';
import type { AutomationDef, TodoSource } from '../../preload/inboxTypes';
import type { RemoteActionResult, RemoteAutomation, RemoteTierName, RemoteTodo } from '../../preload/remoteAutomations';

export function actionGate(tier: RemoteTierName | null | undefined, name: string): string | null {
  if (tier === 'steer' || tier === 'session') return null;
  return `Needs steer on ${name}; ${tier ? `you have ${tier}` : "your tier isn't known yet"}`;
}

/** Deterministic JSON for a payload: object keys sorted recursively, so two payloads that only differ in key order fingerprint the same. */
export function stableFingerprint(payload: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, x]) => [k, sorted(x)]));
    }
    return v;
  };
  return JSON.stringify(sorted(payload));
}

/**
 * One request id per (intent key, payload fingerprint) (D128): kept for a retry after
 * unavailable/busy, dropped once the action settles. A fingerprint change under the same key
 * (the user edited the payload before a retry landed) mints a new id — the old request, if it
 * lands late, must not be mistaken for this one.
 */
export function intentKeys(now: () => number = Date.now) {
  const ids = new Map<string, { id: string; fingerprint: string }>();
  const notBefore = new Map<string, number>();
  return {
    idFor(key: string, fingerprint: string): string {
      const existing = ids.get(key);
      if (existing && existing.fingerprint === fingerprint) return existing.id;
      const id = crypto.randomUUID();
      ids.set(key, { id, fingerprint });
      return id;
    },
    settle(key: string, r: RemoteActionResult<unknown>): void {
      if (!r.ok && r.kind === 'busy') {
        if (r.retryAfterMs) notBefore.set(key, now() + r.retryAfterMs);
        return;
      }
      if (!r.ok && r.kind === 'unavailable') return;
      // An unsettled replay (ok, replayed, result null) lands here too: terminal for this intent.
      ids.delete(key);
      notBefore.delete(key);
    },
    has: (key: string): boolean => ids.has(key),
    /** How long the host asked this intent to wait (Retry-After); 0 when it may send. */
    waitMs: (key: string): number => Math.max(0, (notBefore.get(key) ?? 0) - now())
  };
}

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

/** Sends at most once per call; a second call for the same in-flight key AND fingerprint shares the first request. */
export function intentRunner(keys = intentKeys()) {
  const inflight = new Map<string, { fingerprint: string; promise: Promise<RemoteActionResult<unknown>> }>();
  return {
    run<T>(key: string, fingerprint: string, send: (requestId: string) => Promise<RemoteActionResult<T>>): Promise<RemoteActionResult<T>> {
      const pending = inflight.get(key);
      if (pending && pending.fingerprint === fingerprint) return pending.promise as Promise<RemoteActionResult<T>>;
      const wait = keys.waitMs(key);
      if (wait > 0) {
        return Promise.resolve({ ok: false, kind: 'busy', message: `the host is busy; try again in ${Math.ceil(wait / 1000)} s`, retryAfterMs: wait });
      }
      const p = (async (): Promise<RemoteActionResult<T>> => {
        let r: RemoteActionResult<T>;
        try {
          r = await send(keys.idFor(key, fingerprint));
        } catch (e) {
          r = { ok: false, kind: 'invalid', message: String(e instanceof Error ? e.message : e).replace(IPC_PREFIX, '') };
        }
        keys.settle(key, r);
        return r;
      })().finally(() => inflight.delete(key));
      inflight.set(key, { fingerprint, promise: p as Promise<RemoteActionResult<unknown>> });
      return p;
    },
    busy: (key: string): boolean => inflight.has(key)
  };
}

export function actionMessage(r: RemoteActionResult<unknown>): string | null {
  if (r.ok) return r.replayed ? (r.result === null ? 'Already sent — check Runs/Inbox' : 'Already sent') : null;
  return r.message;
}

export function remoteSourceLabel(s: TodoSource, origin: string, names: Record<string, string>): string {
  if (s.kind === 'user') return s.id ? `@${s.id}` : 'host operator';
  if (s.kind === 'workspace') return names[origin] ?? 'remote workspace';
  return 'automation';
}

export const rowKey = (origin: string, id: string): string => `${origin}:${id}`;

const RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export function sortRemoteTodos<T extends Pick<RemoteTodo, 'priority' | 'lastSeenAt' | 'id'>>(ts: readonly T[]): T[] {
  return [...ts].sort((a, b) => (RANK[a.priority] - RANK[b.priority]) || (b.lastSeenAt - a.lastSeenAt) || (a.id < b.id ? -1 : 1));
}

export function sortRemoteAutomations<T extends Pick<RemoteAutomation, 'workspaceName' | 'name'>>(as: readonly T[]): T[] {
  return [...as].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name));
}

/** The host config's `automations:` entry for a definition, with the hosted id written back as `$self`. */
export function configEntryYaml(def: AutomationDef, origin: string): string {
  const d = structuredClone(def) as unknown as Record<string, unknown>;
  const self = (v: unknown) => (v === origin ? '$self' : v);
  for (const t of (d.triggers as Array<Record<string, Record<string, unknown>>>) ?? []) {
    if (t.event?.workspace === origin) t.event.workspace = '$self';
    if (Array.isArray(t.manual?.allowFrom)) t.manual.allowFrom = (t.manual.allowFrom as unknown[]).map(self);
  }
  for (const s of (d.steps as Array<Record<string, Record<string, unknown>>>) ?? []) {
    if (s.prompt?.workspace === origin) s.prompt.workspace = '$self';
    if (s.script?.runIn === origin) s.script.runIn = '$self';
  }
  return stringify([{ definition: d, enabled: true }], { lineWidth: 0 });
}
