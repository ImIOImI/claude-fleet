// The renderer-facing identity:* IPC (Settings → Account). Responses are
// AccountStatus / SignInStart / SignInPoll only; the token and device code stay
// in main. Renderer arguments are never forwarded beyond a literal refresh flag.

import type { IpcHandleLike } from './vaultIpc.js';
import type { AccountStatus, SignInPoll, SignInStart } from '../preload/identityTypes.js';

export const IDENTITY_CHANNELS = [
  'identity:status',
  'identity:signInStart',
  'identity:signInPoll',
  'identity:signInCancel',
  'identity:signOut'
] as const;

export interface IdentityIpcApi {
  status(opts?: { refresh?: boolean }): Promise<AccountStatus>;
  signInStart(): Promise<SignInStart>;
  signInPoll(): Promise<SignInPoll>;
  signInCancel(): void;
  signOut(): Promise<void>;
}

export function registerIdentityIpc(ipc: IpcHandleLike, svc: IdentityIpcApi): void {
  ipc.handle('identity:status', (_e, opts: unknown) => {
    const refresh =
      typeof opts === 'object' && opts !== null && Object.hasOwn(opts, 'refresh') && (opts as { refresh?: unknown }).refresh === true;
    return svc.status({ refresh });
  });
  ipc.handle('identity:signInStart', () => svc.signInStart());
  ipc.handle('identity:signInPoll', () => svc.signInPoll());
  ipc.handle('identity:signInCancel', () => {
    svc.signInCancel();
  });
  ipc.handle('identity:signOut', async () => {
    await svc.signOut();
  });
}
