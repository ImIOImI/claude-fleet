// What a definition may do on a remote host (SPEC §7 *Host automations*).
import type { AutomationDef } from '../preload/inboxTypes.js';

const NO_EVENTS = new Set(['session.idle', 'workspace.started']);

export function remoteHostRefusals(def: AutomationDef): string[] {
  const errors: string[] = [];
  def.triggers.forEach((t, i) => {
    if ('event' in t && NO_EVENTS.has(t.event.on)) errors.push(`triggers[${i}].event.on: ${t.event.on} events are not available on a remote host`);
  });
  def.steps.forEach((s, i) => {
    if ('script' in s) errors.push(`steps[${i}].script: script steps are not available on a remote host yet`);
    else if ((s.prompt.mode ?? 'live') === 'live') errors.push(`steps[${i}].prompt.mode: live is not available on a remote host; use mode: fresh`);
  });
  return errors;
}

/** Only the hosted workspace resolves, by id or name. */
export function hostResolver(workspace: { id: string; name: string }): (idOrName: string) => string | null {
  return (v) => (v === workspace.id || v === workspace.name ? workspace.id : null);
}

/** `$self` means the hosted workspace, in the fields a loadout binds it in. Returns a copy. */
export function substituteSelf(def: unknown, workspaceId: string): unknown {
  const out = structuredClone(def ?? null) as Record<string, unknown> | null;
  if (!out || typeof out !== 'object') return out;
  const self = (v: unknown): unknown => (v === '$self' ? workspaceId : v);
  const bind = (o: Record<string, unknown> | undefined, k: string): void => {
    if (o && typeof o === 'object' && o[k] === '$self') o[k] = workspaceId;
  };
  for (const t of Array.isArray(out.triggers) ? out.triggers : []) {
    const tt = t as Record<string, Record<string, unknown> | undefined> | null;
    bind(tt?.event, 'workspace');
    if (tt?.manual && Array.isArray(tt.manual.allowFrom)) tt.manual.allowFrom = tt.manual.allowFrom.map(self);
  }
  for (const s of Array.isArray(out.steps) ? out.steps : []) {
    const st = s as Record<string, Record<string, unknown> | undefined> | null;
    bind(st?.prompt, 'workspace');
    bind(st?.script, 'runIn');
  }
  return out;
}
