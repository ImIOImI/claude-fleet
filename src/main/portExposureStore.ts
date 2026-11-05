// SQL for port_exposures. The lifecycle that decides what to write lives in portExposure.ts.
import { sql, type Kysely, type Updateable } from 'kysely';
import { num } from './store/kysely.js';
import type { PortExposuresTable, StateDb } from './store/stateSchema.js';

export type ExposureSource = 'declared' | 'scanned' | 'both';
export type ExposureOutcome = 'opened' | 'dismissed' | 'ignored' | 'not_serving';
export type OpenVia = 'popup' | 'rail' | 'fallback';

export interface ExposureRow {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  port: number;
  cmdline: string | null;
  label: string | null;
  reason: string | null;
  source: ExposureSource;
  firstScannedAt: number | null;
  declaredAt: number | null;
  popupShownAt: number | null;
  outcome: ExposureOutcome | null;
  openedVia: OpenVia | null;
  openCount: number;
  endedAt: number | null;
}

export type ExposurePatch = Partial<Omit<ExposureRow, 'id' | 'workspaceId' | 'port'>>;

export interface ExposureSink {
  insert(row: ExposureRow): Promise<void>;
  update(id: string, patch: ExposurePatch): Promise<void>;
}

export const PORT_EXPOSURE_RETENTION_MS = 90 * 86_400_000;

const COLUMN: Record<keyof ExposurePatch, keyof PortExposuresTable> = {
  sessionId: 'session_id',
  cmdline: 'cmdline',
  label: 'label',
  reason: 'reason',
  source: 'source',
  firstScannedAt: 'first_scanned_at',
  declaredAt: 'declared_at',
  popupShownAt: 'popup_shown_at',
  outcome: 'outcome',
  openedVia: 'opened_via',
  openCount: 'open_count',
  endedAt: 'ended_at'
};

export class PortExposureStore implements ExposureSink {
  constructor(private readonly db: () => Kysely<StateDb>) {}

  async insert(r: ExposureRow): Promise<void> {
    await this.db()
      .insertInto('port_exposures')
      .values({
        id: r.id,
        workspace_id: r.workspaceId,
        session_id: r.sessionId,
        port: r.port,
        cmdline: r.cmdline,
        label: r.label,
        reason: r.reason,
        source: r.source,
        first_scanned_at: r.firstScannedAt,
        declared_at: r.declaredAt,
        popup_shown_at: r.popupShownAt,
        outcome: r.outcome,
        opened_via: r.openedVia,
        open_count: r.openCount,
        ended_at: r.endedAt
      })
      .execute();
  }

  async update(id: string, patch: ExposurePatch): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) set[COLUMN[k as keyof ExposurePatch]] = v;
    if (Object.keys(set).length === 0) return;
    await this.db()
      .updateTable('port_exposures')
      .set(set as Updateable<PortExposuresTable>)
      .where('id', '=', id)
      .execute();
  }

  /** Close rows a previous run left open (app quit mid-appearance). */
  async closeDangling(now: number = Date.now()): Promise<number> {
    const r = await this.db()
      .updateTable('port_exposures')
      .set({
        ended_at: now,
        outcome: sql<string>`COALESCE(outcome, CASE WHEN first_scanned_at IS NULL THEN 'not_serving' ELSE 'ignored' END)`
      })
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return num(r.numUpdatedRows);
  }

  async prune(olderThanMs: number = PORT_EXPOSURE_RETENTION_MS, now: number = Date.now()): Promise<number> {
    const r = await this.db().deleteFrom('port_exposures').where('ended_at', '<', now - olderThanMs).executeTakeFirst();
    return num(r.numDeletedRows);
  }

  async sweep(now: number = Date.now()): Promise<void> {
    await this.closeDangling(now);
    await this.prune(PORT_EXPOSURE_RETENTION_MS, now);
  }
}

/** Holds every write until `ready` settles, so the startup sweep can't close rows this run inserts. */
export function gatedSink(sink: ExposureSink, ready: Promise<unknown>): ExposureSink {
  const gate = ready.then(
    () => undefined,
    () => undefined
  );
  return {
    insert: async (r) => {
      await gate;
      await sink.insert(r);
    },
    update: async (id, patch) => {
      await gate;
      await sink.update(id, patch);
    }
  };
}
