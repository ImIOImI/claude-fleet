import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { appVersionString } from './appVersion.js';
import { getLogPath } from './errorLog.js';
import { openHostPath } from './openHostPath.js';

interface MenuActions {
  openDataFolder: () => void;
  openLog: () => void;
}

/**
 * Build the application-menu template. Electron has no "append to the default
 * Help submenu" API, so we supply a full template using role-based submenus
 * (File/Edit/View/Window behave identically to the default) and add our items
 * under Help. The macOS app-name submenu is included only on darwin. Pure +
 * exported so the Help items can be unit-tested without an Electron runtime.
 */
export function buildAppMenuTemplate(actions: MenuActions, version: string): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: `claude-fleet v${version}`, enabled: false },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => actions.openDataFolder() },
        { label: 'Open Log', click: () => actions.openLog() }
      ]
    }
  ];
  return template;
}

/** Build the menu with real actions and install it as the application menu. */
export function installAppMenu(): void {
  const template = buildAppMenuTemplate(
    {
      openDataFolder: () => void openHostPath(app.getPath('userData')),
      openLog: () => void openHostPath(getLogPath())
    },
    appVersionString()
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
