// Notifications repository (#407 Phase 2) over the inbox.db connection: the
// notification log, the user's rules, downtime schedules and small state
// (pause, default level). No policy here — see notifyPolicy.ts. Async on the
// Kysely store layer (store/kysely.ts).
import type { Kysely } from 'kysely';
import type {
  Downtime, NotificationRow, NotifyLevel, NotifyRule, PauseState
} from '../../preload/inboxTypes.js';
import { newId } from './inboxDb.js';
import type { InboxDb, NotificationRowSql } from '../store/inboxSchema.js';

export type NewNotification = Omit<NotificationRow, 'id' | 'clearedAt'>;

const LEVELS = new Set<NotifyLevel>(['all', 'high', 'urgent', 'off']);

function toRow(r: NotificationRowSql): NotificationRow {
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
  constructor(private readonly db: Kysely<InboxDb>) {}

  // --- notification log ---------------------------------------------------

  async insert(n: NewNotification): Promise<NotificationRow> {
    const id = newId(n.ts);
    await this.db.insertInto('notifications').values({
      id, ts: n.ts, kind: n.kind, title: n.title, body: n.body, priority: n.priority, source_kind: n.source.kind,
      source_id: n.source.id, todo_id: n.todoId, workspace_id: n.workspaceId, dedupe_key: n.dedupeKey,
      tags: n.tags.length ? JSON.stringify(n.tags) : null, delivered: n.delivered ? 1 : 0,
      held_reason: n.heldReason, channel: n.channel
    }).execute();
    return (await this.get(id))!;
  }

  async setChannel(id: string, channel: 'os' | 'in-app'): Promise<void> {
    await this.db.updateTable('notifications').set({ channel }).where('id', '=', id).execute();
  }

  async get(id: string): Promise<NotificationRow | null> {
    const r = await this.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRow(r) : null;
  }

  async list(opts: { filter?: 'all' | 'delivered' | 'held'; limit?: number; workspaceId?: string } = {}): Promise<NotificationRow[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000);
    let q = this.db.selectFrom('notifications').selectAll();
    if (opts.filter === 'held') q = q.where('delivered', '=', 0);
    else if (opts.filter === 'delivered') q = q.where('delivered', '=', 1);
    if (opts.workspaceId !== undefined) q = q.where('workspace_id', '=', opts.workspaceId);
    const rows = await q.orderBy('ts', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map(toRow);
  }

  /** Oldest first from `ts` (inclusive): the host's notices feed. */
  async since(ts: number, limit: number, workspaceId?: string): Promise<NotificationRow[]> {
    let q = this.db.selectFrom('notifications').selectAll().where('ts', '>=', ts);
    if (workspaceId !== undefined) q = q.where('workspace_id', '=', workspaceId);
    const rows = await q.orderBy('ts', 'asc').orderBy('id', 'asc').limit(Math.min(Math.max(1, Math.floor(limit)), 1000)).execute();
    return rows.map(toRow);
  }

  /** Mark every uncleared notification with this dedupe key cleared; returns their ids. */
  async clearByKey(key: string, now: number): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      const ids = (await trx.selectFrom('notifications').select('id')
        .where('dedupe_key', '=', key).where('cleared_at', 'is', null).execute()).map((r) => r.id);
      if (ids.length) {
        await trx.updateTable('notifications').set({ cleared_at: now })
          .where('dedupe_key', '=', key).where('cleared_at', 'is', null).execute();
      }
      return ids;
    });
  }

  /** Held by a pause or downtime since `since`, and not yet summarized in a digest. */
  async heldQuietSince(since: number): Promise<NotificationRow[]> {
    const rows = await this.db.selectFrom('notifications').selectAll()
      .where('delivered', '=', 0).where('digested', '=', 0).where('ts', '>=', since)
      .where((eb) => eb.or([eb('held_reason', '=', 'pause'), eb('held_reason', 'like', 'downtime:%')]))
      .orderBy('ts').orderBy('id').execute();
    return rows.map(toRow);
  }

  async markDigested(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.updateTable('notifications').set({ digested: 1 }).where('id', 'in', ids).execute();
  }

  async prune(olderThan: number): Promise<number> {
    const r = await this.db.deleteFrom('notifications').where('ts', '<', olderThan).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  // --- rules ---------------------------------------------------------------

  async rules(): Promise<NotifyRule[]> {
    const rows = await this.db.selectFrom('notification_rules')
      .select(['id', 'scope_kind', 'scope_value', 'level', 'snooze_until'])
      .orderBy('created_at').orderBy('id').execute();
    return rows.map((r) => ({ id: r.id, scopeKind: r.scope_kind, scopeValue: r.scope_value, level: r.level, snoozeUntil: r.snooze_until }));
  }

  /** Upsert by (scopeKind, scopeValue): one rule per scope. */
  async setRule(rule: Omit<NotifyRule, 'id'>, now = Date.now()): Promise<NotifyRule> {
    if (!LEVELS.has(rule.level)) throw new Error(`invalid level ${rule.level}`);
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('notification_rules').select('id')
        .where('scope_kind', '=', rule.scopeKind).where('scope_value', '=', rule.scopeValue).executeTakeFirst();
      if (existing) {
        await trx.updateTable('notification_rules').set({ level: rule.level, snooze_until: rule.snoozeUntil, updated_at: now })
          .where('id', '=', existing.id).execute();
        return { ...rule, id: existing.id };
      }
      const id = newId(now);
      await trx.insertInto('notification_rules').values({
        id, scope_kind: rule.scopeKind, scope_value: rule.scopeValue, level: rule.level, snooze_until: rule.snoozeUntil,
        created_at: now, updated_at: now
      }).execute();
      return { ...rule, id };
    });
  }

  async removeRule(id: string): Promise<void> {
    await this.db.deleteFrom('notification_rules').where('id', '=', id).execute();
  }

  // --- downtimes -----------------------------------------------------------

  async downtimes(): Promise<Downtime[]> {
    const rows = await this.db.selectFrom('downtimes').selectAll().orderBy('created_at').orderBy('id').execute();
    return rows.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled === 1, days: daysOf(d.days_mask), startMin: d.start_min, endMin: d.end_min, bypass: d.bypass }));
  }

  async saveDowntime(d: Omit<Downtime, 'id'> & { id?: string }, now = Date.now()): Promise<Downtime> {
    const clamp = (m: number) => Math.min(Math.max(0, Math.floor(m)), 1439);
    const row = { ...d, startMin: clamp(d.startMin), endMin: clamp(d.endMin), name: d.name.trim().slice(0, 60) || 'Downtime' };
    return this.db.transaction().execute(async (trx) => {
      const found = d.id ? await trx.selectFrom('downtimes').select('id').where('id', '=', d.id).executeTakeFirst() : undefined;
      if (d.id && found) {
        await trx.updateTable('downtimes').set({
          name: row.name, enabled: row.enabled ? 1 : 0, days_mask: maskOf(row.days), start_min: row.startMin, end_min: row.endMin, bypass: row.bypass
        }).where('id', '=', d.id).execute();
        return { ...row, id: d.id, days: daysOf(maskOf(row.days)) };
      }
      const id = newId(now);
      await trx.insertInto('downtimes').values({
        id, name: row.name, enabled: row.enabled ? 1 : 0, days_mask: maskOf(row.days), start_min: row.startMin,
        end_min: row.endMin, bypass: row.bypass, created_at: now
      }).execute();
      return { id, name: row.name, enabled: row.enabled, days: daysOf(maskOf(row.days)), startMin: row.startMin, endMin: row.endMin, bypass: row.bypass };
    });
  }

  async removeDowntime(id: string): Promise<void> {
    await this.db.deleteFrom('downtimes').where('id', '=', id).execute();
  }

  // --- small state ---------------------------------------------------------

  private async getState(k: string): Promise<string | null> {
    const r = await this.db.selectFrom('notify_state').select('v').where('k', '=', k).executeTakeFirst();
    return r?.v ?? null;
  }
  private async setState(k: string, v: string | null): Promise<void> {
    if (v === null) {
      await this.db.deleteFrom('notify_state').where('k', '=', k).execute();
      return;
    }
    await this.db.insertInto('notify_state').values({ k, v })
      .onConflict((oc) => oc.column('k').doUpdateSet({ v: (eb) => eb.ref('excluded.v') })).execute();
  }

  async getPause(): Promise<PauseState | null> {
    const v = await this.getState('pause');
    return v ? (JSON.parse(v) as PauseState) : null;
  }
  async setPause(p: PauseState): Promise<void> {
    await this.setState('pause', JSON.stringify(p));
  }
  async clearPause(): Promise<void> {
    await this.setState('pause', null);
  }

  async getDefaultLevel(): Promise<NotifyLevel> {
    const v = (await this.getState('defaultLevel')) as NotifyLevel | null;
    return v && LEVELS.has(v) ? v : 'all';
  }
  async setDefaultLevel(level: NotifyLevel): Promise<void> {
    if (!LEVELS.has(level)) throw new Error(`invalid level ${level}`);
    await this.setState('defaultLevel', level);
  }

  /** Marker for digest bookkeeping: when the current quiet period began (or null). */
  async getQuietSince(): Promise<number | null> {
    const v = await this.getState('quietSince');
    return v ? Number(v) : null;
  }
  async setQuietSince(ts: number | null): Promise<void> {
    await this.setState('quietSince', ts === null ? null : String(ts));
  }
}
