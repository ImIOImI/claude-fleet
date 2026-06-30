// Single source of truth for status-dot classes so the precedence rule
// (waiting wins over busy) is identical on the workspace chip, session tab,
// and Sessions row. `waiting` and `busy` both pulse (same chipBusyPulse);
// `waiting` adds the violet `.waiting` colour + "?" glyph at the call site.
export function dotClass({ base, busy, waiting }: { base: string; busy: boolean; waiting: boolean }): string {
  if (waiting) return `${base} waiting`;
  if (busy) return `${base} busy`;
  return base;
}
