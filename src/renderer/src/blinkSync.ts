// Synchronized "busy" pulse (#…): every busy indicator in the app — the
// workspace chip's status dot, each terminal session tab's dot, and the
// left-rail Sessions rows — uses the same `chipBusyPulse` animation. CSS
// animations start counting from when they're applied to an element, so two
// elements that begin pulsing at different times (e.g. a Sessions row that
// remounts on a list refresh while a chip has been pulsing for a while) drift
// out of phase. Aligning each element's `animation-delay` to a shared
// wall-clock phase makes the pulse position depend only on the clock, so they
// all blink in lockstep regardless of when they mounted.

import { useMemo } from 'react';

/** The pulse period, in ms. Mirrors the `chipBusyPulse 1s` rule in styles.css. */
export const BLINK_CYCLE_MS = 1000;

/**
 * The `animation-delay` (ms, always ≤ 0) that snaps a `cycleMs`-period
 * animation applied at `nowMs` to the shared wall-clock phase. A negative delay
 * makes the animation start already advanced into its cycle, so an element that
 * mounts mid-cycle lands at the same point as one that has been animating since
 * the cycle's start. Pure for unit testing.
 */
export function blinkDelayMs(nowMs: number, cycleMs: number = BLINK_CYCLE_MS): number {
  // `% ` can go negative for negative clocks; normalize into [0, cycleMs).
  const phase = ((nowMs % cycleMs) + cycleMs) % cycleMs;
  // `-phase || 0` avoids returning `-0` when phase is 0 (start of a cycle).
  return -phase || 0;
}

/**
 * Inline style that synchronizes an element's busy pulse to wall-clock phase,
 * or `undefined` when not active (no animation, no override needed).
 *
 * The delay is captured once, when `active` flips true — i.e. the moment the
 * animation begins on the element — so it equals `-(applyTime mod cycle)` and
 * the element lands exactly on the shared phase. Recomputing it on every render
 * would shift the running animation and cause a visible jump, hence the
 * `[active]` memo dependency. Components that render busy dots inside a `.map()`
 * must wrap each dot in its own component so this hook is called unconditionally.
 */
export function useBlinkSync(active: boolean): { animationDelay: string } | undefined {
  return useMemo(
    () => (active ? { animationDelay: `${blinkDelayMs(Date.now())}ms` } : undefined),
    [active]
  );
}
