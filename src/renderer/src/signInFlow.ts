// One device-flow sign-in shared by the signed-out banner and every remote tab card (D173).
// Main keeps one pending flow, so a start in Settings → Account replaces this one.
import type { SignInPoll, SignInStart } from '../../preload/identityTypes';
import { driveSignIn, parseIdentityError, type SignInRun } from './accountView';

export type SignInFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: 'error'; message: string };

export interface SignInFlowApi {
  start(): Promise<SignInStart>;
  poll(): Promise<SignInPoll>;
  cancel(): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export interface SignInFlow {
  get(): SignInFlowState;
  subscribe(fn: () => void): () => void;
  start(): Promise<void>;
  cancel(): void;
  /** Signed in some other way: stop polling without cancelling main's flow. */
  reset(): void;
}

export function createSignInFlow(api: SignInFlowApi): SignInFlow {
  let state: SignInFlowState = { phase: 'idle' };
  const subs = new Set<() => void>();
  let run: (SignInRun & { wake: () => void }) | null = null;
  /** Bumped by cancel and reset, so a start still in flight doesn't come back to life. */
  let gen = 0;
  const set = (s: SignInFlowState): void => {
    state = s;
    for (const fn of [...subs]) fn();
  };
  const stop = (): void => {
    if (!run) return;
    run.cancelled = true;
    run.wake();
    run = null;
  };
  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    async start() {
      if (state.phase === 'starting' || state.phase === 'waiting') return;
      const my = ++gen;
      set({ phase: 'starting' });
      let f: SignInStart;
      try {
        f = await api.start();
      } catch (e) {
        if (my === gen) set({ phase: 'error', message: parseIdentityError(e).message });
        return;
      }
      if (my !== gen) return;
      const r: SignInRun & { wake: () => void } = { cancelled: false, wake: () => undefined };
      run = r;
      set({ phase: 'waiting', userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt });
      const outcome = await driveSignIn(
        f,
        {
          now: api.now,
          poll: api.poll,
          wait: (ms) =>
            new Promise<void>((resolve) => {
              const h = api.setTimer(resolve, ms);
              r.wake = () => {
                api.clearTimer(h);
                resolve();
              };
            })
        },
        r
      );
      if (my !== gen) return;
      run = null;
      set(outcome.kind === 'error' ? { phase: 'error', message: outcome.message } : { phase: 'idle' });
    },
    cancel() {
      gen++;
      stop();
      set({ phase: 'idle' });
      void api.cancel().catch(() => undefined);
    },
    reset() {
      gen++;
      stop();
      if (state.phase !== 'idle') set({ phase: 'idle' });
    }
  };
}
