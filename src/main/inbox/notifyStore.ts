// Notifications repository (#407 Phase 2) over the inbox.db connection: the
// notification log, the user's rules, downtime schedules and small state
// (pause, default level). No policy here — see notifyPolicy.ts.
import type Database from 'better-sqlite3';
import type {
  Downtime, NotificationKind, NotificationRow, NotifyLevel, NotifyRule, PauseState, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';
import { newId } from './inboxDb.js';

export type NewNotification = Omit<NotificationRow, 'id' | 'clearedAt'>;

interface NRow {
  id: string; ts: number; kind: NotificationKind; title: string; body: string | null; priority: TodoPriority;
  source_kind: TodoSource['kind']; source_id: string | null; todo_id: string | null; workspace_id: string | null;
  dedupe_key: string | null; tags: string | null; delivered: number; held_reason: string | null;
  channel: 'os' | 'in-app' | null; cleared_at: number | null;
}

const LEVELS = new Set<NotifyLevel>(['all', 'high', 'urgent', 'off']);

function toRow(r: NRow): NotificationRow {
  return {
    id: r.id, ts: r.ts, kind: r.kind, title: r.title, body: r.body, priority: r.priority,
    source: { kind: r.source_kind, id: r.source_id }, todoId: r.todo_id, workspaceId: r.workspace_id,
    dedupeKey: r.dedupe_key, tags: r.tags ? (JSON.parse(r.tags) as string[]) : [], delivered: r.delivered === 1,
    heldReason: r.held_reason, channel: r.channel, clearedAt: r.cleared_at
  };
}

function maskOf(days: number[]): number {
  return days.reduce((m, d) => (d >= 0 && d <= 6 ? m | (1 << d) : m), 0);
}
function daysOf(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
}

export class NotifyStore {
  constructor(private readonly db: Database.Database) {}

  // --- notification log ---------------------------------------------------

  insert(n: NewNotification): NotificationRow {
    const id = newId(n.ts);
    this.db.prepare(
      `INSERT INTO notifications (id, ts, kind, title, body, priority, source_kind, source_id, todo_id, workspace_id,
         dedupe_key, tags, delivered, held_reason, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, n.ts, n.kind, n.title, n.body, n.priority, n.source.kind, n.source.id, n.todoId, n.workspaceId,
      n.dedupeKey, n.tags.length ? JSON.stringify(n.tags) : null, n.delivered ? 1 : 0, n.heldReason, n.channel);
    return this.get(id)!;
  }

  get(id: string): NotificationRow | null {
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NRow | undefined;
    return r ? toRow(r) : null;
  }

  list(opts: { filter?: 'all' | 'delivered' | 'held'; limit?: number } = {}): NotificationRow[] {
    const where = opts.filter === 'held' ? 'WHERE delivered = 0' : opts.filter === 'delivered' ? 'WHERE delivered = 1' : '';
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000);
    return (this.db.prepare(`SELECT * FROM notifications ${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`).all() as NRow[]).map(toRow);
  }

  /** Mark every uncleared notification with this dedupe key cleared; returns their ids. */
  clearByKey(key: string, now: number): string[] {
    const ids = (this.db.prepare('SELECT id FROM notifications WHERE dedupe_key = ? AND cleared_at IS NULL').all(key) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) this.db.prepare('UPDATE notifications SET cleared_at = ? WHERE dedupe_key = ? AND cleared_at IS NULL').run(now, key);
    return ids;
  }

  /** Held by a pause or downtime since `since`, and not yet summarized in a digest. */
  heldQuietSince(since: number): NotificationRow[] {
    return (this.db.prepare(
      `SELECT * FROM notifications WHERE delivered = 0 AND digested = 0 AND ts >= ?
         AND (held_reason = 'pause' OR held_reason LIKE 'downtime:%') ORDER BY ts`
    ).all(since) as NRow[]).map(toRow);
  }

  markDigested(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE notifications SET digested = 1 WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  prune(olderThan: number): number {
    return this.db.prepare('DELETE FROM notifications WHERE ts < ?').run(olderThan).changes;
  }

  // --- rules ---------------------------------------------------------------

  rules(): NotifyRule[] {
    return (this.db.prepare('SELECT id, scope_kind, scope_value, level, snooze_until FROM notification_rules ORDER BY created_at, id').all() as Array<{
      id: string; scope_kind: NotifyRule['scopeKind']; scope_value: string; level: NotifyLevel; snooze_until: number | null;
    }>).map((r) => ({ id: r.id, scopeKind: r.scope_kind, scopeValue: r.scope_value, level: r.level, snoozeUntil: r.snooze_until }));
  }

  /** Upsert by (scopeKind, scopeValue): one rule per scope. */
  setRule(rule: Omit<NotifyRule, 'id'>, now = Date.now()): NotifyRule {
    if (!LEVELS.has(rule.level)) throw new Error(`invalid level ${rule.level}`);
    const existing = this.db.prepare('SELECT id FROM notification_rules WHERE scope_kind = ? AND scope_value = ?')
      .get(rule.scopeKind, rule.scopeValue) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE notification_rules SET level = ?, snooze_until = ?, updated_at = ? WHERE id = ?')
        .run(rule.level, rule.snoozeUntil, now, existing.id);
      return { ...rule, id: existing.id };
    }
    const id = newId(now);
    this.db.prepare(
      'INSERT INTO notification_rules (id, scope_kind, scope_value, level, snooze_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, rule.scopeKind, rule.scopeValue, rule.level, rule.snoozeUntil, now, now);
    return { ...rule, id };
  }

  removeRule(id: string): void {
    this.db.prepare('DELETE FROM notification_rules WHERE id = ?').run(id);
  }

  // --- downtimes -----------------------------------------------------------

  downtimes(): Downtime[] {
    return (this.db.prepare('SELECT * FROM downtimes ORDER BY created_at, id').all() as Array<{
      id: string; name: string; enabled: number; days_mask: number; start_min: number; end_min: number; bypass: Downtime['bypass'];
    }>).map((d) => ({ id: d.id, name: d.name, enabled: d.enabled === 1, days: daysOf(d.days_mask), startMin: d.start_min, endMin: d.end_min, bypass: d.bypass }));
  }

  saveDowntime(d: Omit<Downtime, 'id'> & { id?: string }, now = Date.now()): Downtime {
    const clamp = (m: number) => Math.min(Math.max(0, Math.floor(m)), 1439);
    const row = { ...d, startMin: clamp(d.startMin), endMin: clamp(d.endMin), name: d.name.trim().slice(0, 60) || 'Downtime' };
    if (d.id && this.db.prepare('SELECT 1 FROM downtimes WHERE id = ?').get(d.id)) {
      this.db.prepare('UPDATE downtimes SET name = ?, enabled = ?, days_mask = ?, start_min = ?, end_min = ?, bypass = ? WHERE id = ?')
        .run(row.name, row.enabled ? 1 : 0, maskOf(row.days), row.startMin, row.endMin, row.bypass, d.id);
      return { ...row, id: d.id, days: daysOf(maskOf(row.days)) };
    }
    const id = newId(now);
    this.db.prepare('INSERT INTO downtimes (id, name, enabled, days_mask, start_min, end_min, bypass, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, row.name, row.enabled ? 1 : 0, maskOf(row.days), row.startMin, row.endMin, row.bypass, now);
    return { id, name: row.name, enabled: row.enabled, days: daysOf(maskOf(row.days)), startMin: row.startMin, endMin: row.endMin, bypass: row.bypass };
  }

  removeDowntime(id: string): void {
    this.db.prepare('DELETE FROM downtimes WHERE id = ?').run(id);
  }

  // --- small state ---------------------------------------------------------

  private getState(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM notify_state WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }
  private setState(k: string, v: string | null): void {
    if (v === null) this.db.prepare('DELETE FROM notify_state WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO notify_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  getPause(): PauseState | null {
    const v = this.getState('pause');
    return v ? (JSON.parse(v) as PauseState) : null;
  }
  setPause(p: PauseState): void {
    this.setState('pause', JSON.stringify(p));
  }
  clearPause(): void {
    this.setState('pause', null);
  }

  getDefaultLevel(): NotifyLevel {
    const v = this.getState('defaultLevel') as NotifyLevel | null;
    return v && LEVELS.has(v) ? v : 'all';
  }
  setDefaultLevel(level: NotifyLevel): void {
    if (!LEVELS.has(level)) throw new Error(`invalid level ${level}`);
    this.setState('defaultLevel', level);
  }

  /** Marker for digest bookkeeping: when the current quiet period began (or null). */
  getQuietSince(): number | null {
    const v = this.getState('quietSince');
    return v ? Number(v) : null;
  }
  setQuietSince(ts: number | null): void {
    this.setState('quietSince', ts === null ? null : String(ts));
  }
}
