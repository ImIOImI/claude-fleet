import { describe, expect, it, vi } from 'vitest';
import { buildAppMenuTemplate } from './appMenu.js';

describe('buildAppMenuTemplate', () => {
  it('adds Open Data Folder and Open Log under a Help submenu, wired to the actions', () => {
    const openDataFolder = vi.fn();
    const openLog = vi.fn();
    const template = buildAppMenuTemplate({ openDataFolder, openLog });

    const help = template.find((m) => m.role === 'help' || m.label === 'Help');
    expect(help).toBeDefined();
    const items = (help!.submenu as Array<{ label?: string; click?: () => void }>) ?? [];
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Open Data Folder');
    expect(labels).toContain('Open Log');

    items.find((i) => i.label === 'Open Data Folder')!.click!();
    items.find((i) => i.label === 'Open Log')!.click!();
    expect(openDataFolder).toHaveBeenCalledOnce();
    expect(openLog).toHaveBeenCalledOnce();
  });

  it('preserves the standard role-based submenus', () => {
    const template = buildAppMenuTemplate({ openDataFolder: () => {}, openLog: () => {} });
    const roles = template.map((m) => m.role);
    expect(roles).toContain('editMenu');
    expect(roles).toContain('viewMenu');
    expect(roles).toContain('windowMenu');
  });
});
