// Temporary reveal of stored secret env values in the workspace edit form.
// The renderer normally never holds a saved secret value (SPEC §9); a reveal
// is the deliberate exception: fetched once via vault:getSecret on the
// user's click, held only while shown, and dropped on hide / timeout /
// modal close. Kept React-free so the timer logic is unit-testable.

export const REVEAL_SECONDS = 30;

export type RevealState =
  | { status: 'loading' }
  | { status: 'shown'; value: string; remainingS: number }
  | { status: 'missing' }
  | { status: 'error'; message: string };

interface Options {
  /** Fetch the stored value for a key; null when the vault has none. */
  fetch: (key: string) => Promise<string | null>;
  /** Called on every state change; `undefined` means masked again. */
  onChange: (key: string, state: RevealState | undefined) => void;
}

export interface SecretRevealer {
  reveal(key: string): void;
  hide(key: string): void;
  hideAll(): void;
  isActive(key: string): boolean;
}

export function createSecretRevealer({ fetch, onChange }: Options): SecretRevealer {
  // Per-key entry; a fresh object per reveal doubles as the generation token
  // so a fetch that lands after hide() (or a re-reveal) is dropped.
  const active = new Map<string, { timer?: ReturnType<typeof setInterval> }>();

  const hide = (key: string): void => {
    const entry = active.get(key);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    active.delete(key);
    onChange(key, undefined);
  };

  const reveal = (key: string): void => {
    hide(key);
    const entry: { timer?: ReturnType<typeof setInterval> } = {};
    active.set(key, entry);
    onChange(key, { status: 'loading' });
    fetch(key).then(
      (value) => {
        if (active.get(key) !== entry) return;
        if (value == null) {
          onChange(key, { status: 'missing' });
          return;
        }
        let remainingS = REVEAL_SECONDS;
        onChange(key, { status: 'shown', value, remainingS });
        entry.timer = setInterval(() => {
          remainingS -= 1;
          if (remainingS <= 0) hide(key);
          else onChange(key, { status: 'shown', value, remainingS });
        }, 1000);
      },
      (err: unknown) => {
        if (active.get(key) !== entry) return;
        onChange(key, { status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    );
  };

  return {
    reveal,
    hide,
    hideAll: () => {
      for (const key of [...active.keys()]) hide(key);
    },
    isActive: (key) => active.has(key)
  };
}
