// The startup dialog when the store can't be chosen or opened. Pure, so the
// choice logic is testable without Electron.
import { ConfigJsonError } from './storeConfig.js';

export interface StoreStartupPrompt {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: 0;
  cancelId: 0;
  canContinue: boolean;
}

export type StoreStartupOutcome = 'quit' | 'continue-without-settings';

export function storeStartupPrompt(e: unknown, configPath: string): StoreStartupPrompt {
  if (e instanceof ConfigJsonError) {
    return {
      title: 'Settings file unreadable',
      message: 'config.json is not valid JSON.',
      detail:
        `${configPath} could not be parsed. ` +
        'Continue without settings to start with default settings. Settings changes can\'t be saved until the file is fixed, ' +
        'and the file is left untouched. If config.json configured Postgres, continuing uses the local SQLite store instead.',
      buttons: ['Quit', 'Continue without settings'],
      defaultId: 0, cancelId: 0, canContinue: true,
    };
  }
  return {
    title: 'Postgres store unavailable',
    message: 'The configured store could not be opened.',
    detail: `${String(e)}\n\nFix ${configPath}, or remove its "store" key to use the built-in SQLite store.`,
    buttons: ['Quit'],
    defaultId: 0, cancelId: 0, canContinue: false,
  };
}

export function storeStartupOutcome(p: StoreStartupPrompt, response: number): StoreStartupOutcome {
  return p.canContinue && response === 1 ? 'continue-without-settings' : 'quit';
}
