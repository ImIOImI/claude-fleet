// Knowledge capture (#483 §5a): append-only log of capture-settings changes,
// whoever made them (the user in the form, or a workspace over MCP) and
// whether they applied or became a proposal.
import type { Kysely } from 'kysely';
import type { CaptureSettings } from '../../preload/captureSettings.js';
import { newId } from '../inbox/inboxDb.js';
import type { InboxDb } from '../store/inboxSchema.js';

export interface CaptureSettingsLogEntry {
  id: string; workspaceId: string; ts: number; actor: 'user' | 'workspace';
  before: CaptureSettings; after: CaptureSettings; reason: string | null; applied: boolean; proposalId: string | null;
}

export class CaptureSettingsLogStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async append(o: {
    workspaceId: string; actor: 'user' | 'workspace'; before: CaptureSettings; after: CaptureSettings;
    reason: string | null; applied: boolean; proposalId: string | null; now: number;
  }): Promise<string> {
    const id = newId(o.now);
    await this.db.insertInto('capture_settings_log').values({
      id, workspace_id: o.workspaceId, ts: o.now, actor: o.actor, before: JSON.stringify(o.before),
      after: JSON.stringify(o.after), reason: o.reason, applied: o.applied ? 1 : 0, proposal_id: o.proposalId
    }).execute();
    return id;
  }

  async listFor(workspaceId: string, limit = 50): Promise<CaptureSettingsLogEntry[]> {
    const rows = await this.db.selectFrom('capture_settings_log').selectAll().where('workspace_id', '=', workspaceId)
      .orderBy('ts', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map((r) => ({
      id: r.id, workspaceId: r.workspace_id, ts: r.ts, actor: r.actor === 'user' ? 'user' : 'workspace',
      before: JSON.parse(r.before) as CaptureSettings, after: JSON.parse(r.after) as CaptureSettings,
      reason: r.reason, applied: r.applied === 1, proposalId: r.proposal_id
    }));
  }
}
