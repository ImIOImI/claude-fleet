// Install / update / uninstall the automations a loadout ships (#407 Phase 8).
// Pure: the store, clock and names are injected (automationIpc.ts wires it).
// - First install: each valid automation is created, ON unless it's unticked,
//   is missing a secret, or has a host step (host steps need allowHost).
// - Reinstall/update into the same workspace: an automation you haven't edited
//   since install takes the new definition (enabled state kept); one you
//   edited is kept and reported; new ones arrive OFF unless ticked.
// - Uninstall: removes them (run history is kept).
import type { AutomationDef } from '../../preload/inboxTypes.js';
import type { AutomationStore, AutomationRecord } from './automationStore.js';
import type { LoadoutOrigin, PreparedAutomation } from './loadoutAutomations.js';
import { copyName } from './loadoutAutomations.js';
import { riskFlags } from './classify.js';

export type LoadoutAutomationStatus = 'new' | 'update' | 'unchanged' | 'kept-edited' | 'invalid';

export interface LoadoutAutomationPreview {
  folder: string;
  name: string;
  status: LoadoutAutomationStatus;
  /** Ticked in the review by default. */
  defaultOn: boolean;
  /** Why it can't be turned on (missing secret / host step) or installed at all (invalid). */
  blocked: string | null;
  hostStep: boolean;
  missingSecrets: string[];
  flags: string[];
  errors: string[];
}

export interface InstallOpts {
  loadoutId: string;
  version: string | null;
  targetId: string;
  targetName: string;
  /** Folders to turn on; undefined = the review's defaults. */
  enable?: string[];
  /** The user allowed steps that run on this computer for this loadout. */
  allowHost?: boolean;
}

export interface InstallSummary {
  ids: string[];
  created: string[];
  updated: string[];
  kept: string[];
  skipped: Array<{ name: string; reason: string }>;
}

const USER = { kind: 'user' as const, id: null };

function originOf(a: AutomationRecord): LoadoutOrigin | null {
  const o = a.origin as Partial<LoadoutOrigin> | null;
  return o && typeof o.loadoutId === 'string' && typeof o.workspaceId === 'string' && typeof o.folder === 'string' ? (o as LoadoutOrigin) : null;
}

export function createLoadoutInstaller(deps: { store: AutomationStore; now(): number; workspaceName(id: string): string }) {
  const { store } = deps;
  const installedFrom = (loadoutId: string, targetId: string) =>
    store.list().filter((a) => { const o = originOf(a); return o?.loadoutId === loadoutId && o.workspaceId === targetId; });

  function preview(prepared: PreparedAutomation[], loadoutId: string, targetId: string, allowHost = false): LoadoutAutomationPreview[] {
    const existing = installedFrom(loadoutId, targetId);
    const firstInstall = existing.length === 0;
    return prepared.map((p) => {
      const cur = existing.find((a) => originOf(a)!.folder === p.folder);
      const flags = p.definition ? riskFlags(p.definition, deps.workspaceName) : [];
      if (!p.ok || !p.definition) {
        return { folder: p.folder, name: p.name, status: 'invalid', defaultOn: false, blocked: p.errors[0] ?? 'invalid', hostStep: false, missingSecrets: [], flags, errors: p.errors };
      }
      let status: LoadoutAutomationStatus = 'new';
      if (cur) {
        const o = originOf(cur)!;
        status = cur.version > o.installedVersion ? 'kept-edited' : JSON.stringify(cur.definition) === JSON.stringify({ ...p.definition, name: cur.name }) ? 'unchanged' : 'update';
      }
      const blocked = p.hostStep && !allowHost ? 'runs a script on your computer: allow that for this loadout to install it'
        : p.missingSecrets.length ? `add the secret${p.missingSecrets.length > 1 ? 's' : ''} ${p.missingSecrets.join(', ')} to turn it on` : null;
      const defaultOn = status === 'new' ? firstInstall && !blocked : cur ? cur.enabled : false;
      return { folder: p.folder, name: cur?.name ?? p.name, status, defaultOn, blocked, hostStep: p.hostStep, missingSecrets: p.missingSecrets, flags, errors: [] };
    });
  }

  function install(prepared: PreparedAutomation[], opts: InstallOpts): InstallSummary {
    const rows = preview(prepared, opts.loadoutId, opts.targetId, opts.allowHost === true);
    const enable = opts.enable ? new Set(opts.enable) : new Set(rows.filter((r) => r.defaultOn).map((r) => r.folder));
    const out: InstallSummary = { ids: [], created: [], updated: [], kept: [], skipped: [] };
    const existing = installedFrom(opts.loadoutId, opts.targetId);
    prepared.forEach((p, i) => {
      const row = rows[i];
      const cur = existing.find((a) => originOf(a)!.folder === p.folder);
      if (cur) out.ids.push(cur.id);
      if (row.status === 'invalid' || !p.definition) { out.skipped.push({ name: p.name, reason: row.blocked ?? 'invalid' }); return; }
      if (p.hostStep && opts.allowHost !== true) { out.skipped.push({ name: p.name, reason: row.blocked! }); return; }
      const origin = (version: number): LoadoutOrigin => ({ loadoutId: opts.loadoutId, version: opts.version, workspaceId: opts.targetId, folder: p.folder, installedVersion: version });
      if (cur) {
        if (row.status === 'kept-edited') { out.kept.push(cur.name); return; }
        if (row.status === 'update') {
          const def: AutomationDef = { ...p.definition, name: cur.name };
          const next = store.update(cur.id, def, USER, deps.now());
          store.setOrigin(cur.id, { ...origin(next.version) });
          out.updated.push(cur.name);
        } else {
          store.setOrigin(cur.id, { ...origin(cur.version) });
        }
        return;
      }
      const name = copyName(p.definition.name, opts.targetName, (n) => !!store.byName(n));
      const on = enable.has(p.folder) && !row.blocked;
      const a = store.create({ ...p.definition, name }, USER, deps.now(), on, { ...origin(1) });
      out.ids.push(a.id);
      out.created.push(a.name);
    });
    return out;
  }

  function uninstall(loadoutId: string, targetId: string): string[] {
    const gone = installedFrom(loadoutId, targetId);
    for (const a of gone) store.remove(a.id);
    return gone.map((a) => a.name);
  }

  return { preview, install, uninstall };
}

export type LoadoutInstaller = ReturnType<typeof createLoadoutInstaller>;
