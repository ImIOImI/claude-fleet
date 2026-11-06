// Knowledge capture (#483 §5a): a workspace reads and changes its OWN capture
// settings over MCP. Cost-reducing/neutral changes apply now (logged + a
// low-priority notification); cost-increasing ones apply now only for a
// trusted workspace, otherwise they become a proposal the user approves.
import {
  classifyNeedsApproval, defaultCaptureSettings, describeCaptureChange, diffCaptureSettings, effectiveCaptureSettings,
  isDefaultCaptureSettings, normalizeCaptureSettings, parseCaptureSettingsPatch, type CaptureSettings
} from '../../preload/captureSettings.js';
import type { CaptureSettingsChange } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import type { WorkspaceSpec } from '../workspaces.js';
import { emitCaptureSettingsChanged } from './captureSettingsEvents.js';
import type { CaptureSettingsLogStore } from './captureSettingsLog.js';

export interface CaptureSettingsDeps {
  readManifest(id: string): Promise<WorkspaceSpec | null>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  /** Same rule as automation proposals: container && (inbox.trusted || role automations). */
  trusted(id: string): Promise<boolean>;
  log: Pick<CaptureSettingsLogStore, 'append'>;
  propose(callerId: string, change: CaptureSettingsChange, reason: string): Promise<{ id: string }>;
  notify(n: NotifyInput): void;
  globalEnabled(): Promise<boolean>;
  dailyCap(): Promise<number>;
  capturesToday(): Promise<number>;
  workspaceName(id: string): Promise<string>;
  now(): number;
  /** Invalidates the cached workspace list (ipc.ts) after a manifest write, so
   *  an open edit form or live list doesn't hold a stale knowledgeCapture.
   *  Injected rather than importing ipc.ts, which would pull Electron into
   *  this otherwise Electron-free module. */
  invalidateWorkspaceList(): void;
}

export function createCaptureSettingsService(d: CaptureSettingsDeps) {
  async function load(id: string): Promise<WorkspaceSpec> {
    const m = await d.readManifest(id);
    if (!m) throw new Error('workspace not found');
    return m;
  }

  async function write(
    m: WorkspaceSpec, next: CaptureSettings, actor: 'user' | 'workspace', source: 'mcp' | 'proposal',
    reason: string | null, proposalId: string | null
  ): Promise<void> {
    const before = effectiveCaptureSettings(m);
    await d.writeManifest({ ...m, knowledgeCapture: isDefaultCaptureSettings(next) ? undefined : next });
    d.invalidateWorkspaceList();
    await d.log.append({ workspaceId: m.id, actor, before, after: next, reason, applied: true, proposalId, now: d.now() });
    emitCaptureSettingsChanged({ workspaceId: m.id, before, after: next, actor, source });
  }

  return {
    async get(callerId: string) {
      const m = await load(callerId);
      return {
        settings: effectiveCaptureSettings(m),
        defaults: defaultCaptureSettings(),
        global: { enabled: await d.globalEnabled(), dailyCap: await d.dailyCap(), capturesToday: await d.capturesToday() }
      };
    },

    async set(callerId: string, args: Record<string, unknown>) {
      const { patch, reason } = parseCaptureSettingsPatch(args);
      const m = await load(callerId);
      // A remote bookmark's sessions run on its fleet-host, which this desktop
      // never captures (captureExec.ts:resolveCaptureTarget): a change would be a no-op.
      if (m.kind === 'remote') throw new Error('knowledge capture is not available for remote workspaces');
      const before = effectiveCaptureSettings(m);
      const after = normalizeCaptureSettings({ ...before, ...patch });
      const changes = describeCaptureChange(before, after);
      if (changes.length === 0) return { status: 'unchanged' as const, settings: before, changes, reasons: [] as string[] };
      const gate = classifyNeedsApproval(before, after);
      if (!gate.needsApproval || (await d.trusted(callerId))) {
        await write(m, after, 'workspace', 'mcp', reason, null);
        const who = await d.workspaceName(callerId);
        d.notify({
          kind: 'capture-settings', title: `${who} changed its knowledge-capture settings: ${changes.join(', ')}`.slice(0, 200),
          body: reason, priority: 'low', source: { kind: 'workspace', id: callerId }, workspaceId: callerId
        });
        return { status: 'applied' as const, settings: after, changes, needsApproval: gate.needsApproval, reasons: gate.reasons };
      }
      const p = await d.propose(callerId, { workspaceId: callerId, before, after, changes, reasons: gate.reasons }, reason);
      await d.log.append({ workspaceId: callerId, actor: 'workspace', before, after, reason, applied: false, proposalId: p.id, now: d.now() });
      return { status: 'proposed' as const, proposalId: p.id, changes, reasons: gate.reasons };
    },

    /** The user approved a proposal: apply only the fields it changed onto the
     *  workspace's current settings, so an unrelated edit made since survives. */
    async applyApproved(workspaceId: string, change: CaptureSettingsChange, proposalId: string): Promise<void> {
      const m = await load(workspaceId);
      const next = normalizeCaptureSettings({ ...effectiveCaptureSettings(m), ...diffCaptureSettings(change.before, change.after) });
      await write(m, next, 'user', 'proposal', 'approved proposal', proposalId);
    }
  };
}

export type CaptureSettingsService = ReturnType<typeof createCaptureSettingsService>;
