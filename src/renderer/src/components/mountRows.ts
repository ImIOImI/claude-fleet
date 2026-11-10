import {
  containerPathError,
  defaultContainerPath,
  normalizeContainerPath,
  type ExtraMount
} from '../../../preload/extraMounts';

export interface MountRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export const rowsFromMounts = (m?: ExtraMount[]): MountRow[] => (m ?? []).map((x) => ({ ...x }));

const effectivePath = (r: MountRow) => normalizeContainerPath(r.containerPath.trim() || defaultContainerPath(r.hostPath));

export function mountsFromRows(rows: MountRow[]): ExtraMount[] | undefined {
  const out = rows
    .filter((r) => r.hostPath.trim())
    .map((r) => ({ hostPath: r.hostPath.trim(), containerPath: effectivePath(r), readOnly: r.readOnly }));
  return out.length ? out : undefined;
}

export function mountRowErrors(rows: MountRow[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!r.hostPath.trim()) return null;
    const raw = r.containerPath.trim() || defaultContainerPath(r.hostPath);
    const err = containerPathError(raw, r.hostPath);
    if (err) return err;
    const p = normalizeContainerPath(raw);
    if (seen.has(p)) return `${p} is already used by another mount.`;
    seen.add(p);
    return null;
  });
}

export function mountsSummary(m?: ExtraMount[]): string {
  if (!m?.length) return '(none)';
  const ro = m.filter((x) => x.readOnly).length;
  return `${m.length} folder${m.length === 1 ? '' : 's'}${ro ? ` · ${ro} read-only` : ''}`;
}

export const hostPlaceholder = (platform: string) => (platform === 'win32' ? 'C:\\path\\to\\folder' : '/home/you/folder');

export function mountsEqual(a?: ExtraMount[], b?: ExtraMount[]): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return (
    x.length === y.length &&
    x.every((m, i) => m.hostPath === y[i].hostPath && m.containerPath === y[i].containerPath && m.readOnly === y[i].readOnly)
  );
}
