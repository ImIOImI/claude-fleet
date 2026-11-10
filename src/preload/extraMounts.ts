// Shared by main and renderer (the only dir both tsconfigs compile).

export interface ExtraMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

const RESERVED: ReadonlyArray<readonly [prefix: string, what: string]> = [
  ['/shared', "the fleet's shared folder"],
  ['/home/fleet/.claude.json', "claude's settings file"],
  ['/home/fleet/.claude', "claude's settings folder"],
  ['/run/broker', "the app's session broker folder"],
  ['/fleet/mcp', "the app's MCP socket folder"],
  ['/proc', 'a system folder'],
  ['/sys', 'a system folder'],
  ['/dev', 'a system folder'],
  ['/etc', 'a system folder'],
  ['/usr', 'a system folder'],
  ['/bin', 'a system folder'],
  ['/sbin', 'a system folder'],
  ['/lib64', 'a system folder'],
  ['/lib', 'a system folder']
];

function basename(hostPath: string): string {
  const parts = hostPath.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  // A bare drive ("C:") has no usable name.
  if (/^[A-Za-z]:$/.test(last)) return '';
  return last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function defaultContainerPath(hostPath: string): string {
  return `/mnt/${basename(hostPath) || 'folder'}`;
}

export function normalizeContainerPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

export function containerPathError(containerPath: string, hostPath: string): string | null {
  const suggestion = defaultContainerPath(hostPath);
  const name = suggestion.slice('/mnt/'.length);
  if (!containerPath.startsWith('/')) return 'Container path must start with /.';
  const p = normalizeContainerPath(containerPath);
  if (p === '/') return `/ can't be replaced. Use a path like ${suggestion}.`;
  if (p === '/workspace') {
    return `/workspace is this workspace's private folder. Mount inside it, like /workspace/${name}, or use ${suggestion}.`;
  }
  for (const [prefix, what] of RESERVED) {
    if (under(p, prefix)) return `${prefix} is ${what}. Use a path outside it, like ${suggestion}.`;
  }
  return null;
}

export function duplicateContainerPaths(mounts: Pick<ExtraMount, 'containerPath'>[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const m of mounts) {
    const p = normalizeContainerPath(m.containerPath);
    if (seen.has(p)) dupes.add(p);
    seen.add(p);
  }
  return dupes;
}

export function sanitizeMounts(raw: unknown): ExtraMount[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ExtraMount[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const { hostPath, containerPath, readOnly } = m as Record<string, unknown>;
    if (typeof hostPath !== 'string' || !hostPath) continue;
    if (typeof containerPath !== 'string' || !containerPath) continue;
    out.push({ hostPath, containerPath, readOnly: readOnly === true });
  }
  return out.length ? out : undefined;
}
