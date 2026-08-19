// Pure toast model — shared by the global bottom-center stack (App.tsx) and the
// in-tab placement (TerminalPane committee toast). The React layer (Toast.tsx)
// renders these and owns auto-dismiss timing (timers aren't pure); this module
// is the unit-tested core: shape, kinds, placement, and the reducer (push /
// dismiss / replace-by-key).

export type ToastKind = 'progress' | 'ok' | 'error' | 'info';
export type ToastPlacement = 'global' | 'tab';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Mono uppercase label (the unified "eyebrow"/"tag"). */
  eyebrow?: string;
  placement: ToastPlacement;
  /** No auto-dismiss; the user closes it via the ✕ (so it's always dismissible). */
  sticky: boolean;
  /** Show a ✕ close affordance. Forced true for sticky toasts (see makeToast). */
  dismissible: boolean;
  /** Optional inline action button, e.g. "Open log". */
  action?: ToastAction;
  /** Optional second inline action, e.g. the "Keep" next to "Use newer" on
   *  the newer-claude toast (#336). Rendered after `action`. */
  secondaryAction?: ToastAction;
  /** Dedupe key: pushing another toast with the same key REPLACES the existing
   *  one rather than stacking — e.g. the single "MCP unreachable" toast. */
  key?: string;
  /** For placement 'tab': which session tab owns the toast. */
  tabId?: string;
}

export type ToastInput = Omit<Toast, 'id'>;

export type ToastEvent =
  | { type: 'push'; toast: Toast }
  | { type: 'dismiss'; id: number }
  | { type: 'dismissKey'; key: string };

/** Normalize an input toast into a full Toast. Sticky toasts are always
 *  dismissible (a sticky toast with no way to close would be a trap). */
export function makeToast(id: number, input: ToastInput): Toast {
  return { ...input, id, dismissible: input.dismissible || input.sticky };
}

export function toastReducer(state: Toast[], ev: ToastEvent): Toast[] {
  switch (ev.type) {
    case 'push': {
      // Replace any existing toast sharing this key, so a keyed toast never
      // stacks duplicates (the MCP toast re-pushed on each drop stays single).
      const base = ev.toast.key ? state.filter((t) => t.key !== ev.toast.key) : state;
      return [...base, ev.toast];
    }
    case 'dismiss':
      return state.filter((t) => t.id !== ev.id);
    case 'dismissKey':
      return state.filter((t) => t.key !== ev.key);
    default:
      return state;
  }
}
