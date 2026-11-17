// Settings → Account: the GitHub OAuth client id field (config:*GithubClientId).
// Electron-free so the guards unit-test; ipc.ts wires the real env and config.

import type { IpcHandleLike } from './vaultIpc.js';
import {
  GITHUB_CLIENT_ID_ENV,
  isValidGithubClientId,
  resolveGithubClientId,
  type GithubClientIdSetting
} from '../preload/githubClientId.js';

export const GITHUB_CLIENT_ID_CHANNELS = ['config:getGithubClientId', 'config:setGithubClientId'] as const;

export interface GithubClientIdDeps {
  env(): string | undefined;
  getConfig(): Promise<string | null>;
  setConfig(value: string | null): Promise<void>;
  builtin: string;
}

/** Reads config on every call, so a saved value applies to the next sign-in. */
export async function readGithubClientId(d: GithubClientIdDeps): Promise<GithubClientIdSetting> {
  return resolveGithubClientId({ env: d.env(), config: await d.getConfig(), builtin: d.builtin });
}

export function registerGithubClientIdIpc(ipc: IpcHandleLike, d: GithubClientIdDeps): void {
  ipc.handle('config:getGithubClientId', () => readGithubClientId(d));
  ipc.handle('config:setGithubClientId', async (_e, raw: unknown) => {
    if (raw !== null && typeof raw !== 'string') throw new Error('Invalid GitHub OAuth client ID');
    const v = raw?.trim() || null;
    if (v !== null && !isValidGithubClientId(v)) {
      throw new Error("Invalid GitHub OAuth client ID: use 1-100 letters, digits, '.', '_' or '-'");
    }
    if ((await readGithubClientId(d)).source === 'env') {
      throw new Error(`The GitHub OAuth client ID is set by ${GITHUB_CLIENT_ID_ENV}; the environment variable takes precedence`);
    }
    await d.setConfig(v);
    return readGithubClientId(d);
  });
}
