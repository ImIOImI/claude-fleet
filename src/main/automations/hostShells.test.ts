import { describe, it, expect } from 'vitest';
import { detectHostShells, onPath } from './hostShells.js';

describe('detectHostShells', () => {
  it('Windows: PowerShell 7 if installed, Windows PowerShell always, then each WSL distro', () => {
    expect(detectHostShells('win32', (c) => c === 'pwsh', ['Ubuntu', 'Debian'], 'Ubuntu')).toEqual([
      { id: 'pwsh', label: 'PowerShell 7', isDefault: true },
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'wsl:Ubuntu', label: 'WSL · Ubuntu (default)' },
      { id: 'wsl:Debian', label: 'WSL · Debian' }
    ]);
    expect(detectHostShells('win32', () => false, [])).toEqual([{ id: 'powershell', label: 'Windows PowerShell', isDefault: true }]);
  });
  it('macOS/Linux: what is installed, sh always', () => {
    expect(detectHostShells('darwin', (c) => c !== 'pwsh', []).map((s) => s.id)).toEqual(['bash', 'zsh', 'sh']);
  });
});

describe('onPath', () => {
  it('checks each PATH dir, with Windows extensions', () => {
    const files = new Set(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/usr/bin/zsh']);
    expect(onPath('pwsh', 'C:\\Windows;C:\\Program Files\\PowerShell\\7\\', 'win32', (p) => files.has(p))).toBe(true);
    expect(onPath('zsh', '/bin:/usr/bin', 'linux', (p) => files.has(p))).toBe(true);
    expect(onPath('fish', '/bin:/usr/bin', 'linux', (p) => files.has(p))).toBe(false);
  });
});
