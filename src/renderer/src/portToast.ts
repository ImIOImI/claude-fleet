import type { PortDetected } from '../../preload';

export function portPopupCopy(p: PortDetected, workspaceName: string): { eyebrow: string; message: string } {
  if (p.declared) {
    const why = p.reason ? ` — ${p.reason}` : '';
    return { eyebrow: 'Preview', message: `${workspaceName} wants to show you ${p.label ?? 'a server'} on :${p.port}${why}` };
  }
  const cmd = p.cmdline ? ` (${p.cmdline})` : '';
  return { eyebrow: 'Preview · undeclared', message: `Server on port ${p.port} in ${workspaceName}${cmd}` };
}
