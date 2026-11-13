// Desktop automations run only on this computer's workspaces; a remote bookmark's
// automations come from its host config (SPEC §8 *Automations*, D125).
export interface NamedWorkspace { id: string; name: string; kind: string }

const find = (list: NamedWorkspace[], v: string): NamedWorkspace | undefined =>
  list.find((n) => n.id === v) ?? list.find((n) => n.name === v);

export const localWorkspaces = (names: NamedWorkspace[]): NamedWorkspace[] => names.filter((n) => n.kind !== 'remote');

export function resolveLocalWorkspace(names: NamedWorkspace[], v: string): string | null {
  return find(localWorkspaces(names), v)?.id ?? null;
}

export function remoteTargetRefusal(names: NamedWorkspace[], v: string): string | null {
  if (resolveLocalWorkspace(names, v)) return null;
  const r = find(names.filter((n) => n.kind === 'remote'), v);
  return r ? `${r.name} is a remote workspace: its automations come from its host config; use Draft for ${r.name}` : null;
}
