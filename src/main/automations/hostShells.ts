// Shells this computer can run `runIn: host` script steps with (#407). Pure:
// PATH lookup and the WSL distro list are injected. Windows: Windows
// PowerShell (always), PowerShell 7 if installed, and each WSL distro. macOS /
// Linux: bash, zsh, pwsh when installed, plus sh.
import type { HostShell, ScriptShell } from '../../preload/inboxTypes.js';

export function detectHostShells(platform: NodeJS.Platform, has: (cmd: string) => boolean, wslDistros: string[], wslDefault: string | null = null): HostShell[] {
  const out: HostShell[] = [];
  if (platform === 'win32') {
    if (has('pwsh')) out.push({ id: 'pwsh', label: 'PowerShell 7' });
    out.push({ id: 'powershell', label: 'Windows PowerShell' });
    for (const d of wslDistros) out.push({ id: `wsl:${d}`, label: `WSL · ${d}${d === wslDefault ? ' (default)' : ''}` });
  } else {
    if (has('bash')) out.push({ id: 'bash', label: 'bash' });
    if (has('zsh')) out.push({ id: 'zsh', label: 'zsh' });
    out.push({ id: 'sh', label: 'sh' });
    if (has('pwsh')) out.push({ id: 'pwsh', label: 'PowerShell 7' });
  }
  out[0].isDefault = true;
  return out;
}

/** Is `cmd` an executable on PATH? (`exists` injected.) */
export function onPath(cmd: string, pathVar: string | undefined, platform: NodeJS.Platform, exists: (p: string) => boolean): boolean {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const join = (d: string) => (d.endsWith('/') || d.endsWith('\\') ? d : d + (platform === 'win32' ? '\\' : '/'));
  return (pathVar ?? '').split(sep).filter(Boolean).some((d) => exts.some((e) => exists(join(d) + cmd + e)));
}

export const shellIds = (shells: HostShell[]): ScriptShell[] => shells.map((s) => s.id);
