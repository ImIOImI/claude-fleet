// The app's one sign-in flow, over the existing identity:* IPC (D173).
import { createSignInFlow } from './signInFlow';

export const signInFlow = createSignInFlow({
  start: () => window.api.identity.signInStart(),
  poll: () => window.api.identity.signInPoll(),
  cancel: async () => {
    await window.api.identity.signInCancel();
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
});
