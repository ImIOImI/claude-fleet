// Knowledge capture (#483): pure trigger policy. State lives in the scheduler.
import { contextWindowFor } from '../contextWindow.js';
import type { CaptureSignals } from '../db.js';
import type { CaptureTrigger } from './captureRunStore.js';

export interface CapturePolicyConfig { bands: [number, number]; turnsEvery: number; minIntervalMs: number }
export const DEFAULT_CAPTURE_POLICY: CapturePolicyConfig = { bands: [0.6, 0.85], turnsEvery: 30, minIntervalMs: 10 * 60_000 };

export interface SessionCaptureState {
  fired: Array<'ctx-60' | 'ctx-85'>; compactionsSeen: number; turnsAtLastCapture: number; lastCaptureAt: number | null;
}

export function decideCapture(
  sig: CaptureSignals, state: SessionCaptureState | undefined, hasPriorRun: boolean, cfg: CapturePolicyConfig, now: number
): { trigger: CaptureTrigger | null; next: SessionCaptureState } {
  let s: SessionCaptureState = state ?? {
    fired: [], compactionsSeen: sig.compactions,
    // A never-captured session gets its history captured once (turn counter from 0).
    turnsAtLastCapture: hasPriorRun ? sig.userTurns : 0, lastCaptureAt: null
  };
  if (sig.compactions > s.compactionsSeen) s = { ...s, fired: [], compactionsSeen: sig.compactions };
  if (s.lastCaptureAt !== null && now - s.lastCaptureAt < cfg.minIntervalMs) return { trigger: null, next: s };
  const fill = sig.contextTokens / contextWindowFor(sig.model, sig.contextTokens);
  let trigger: CaptureTrigger | null = null;
  if (fill >= cfg.bands[1] && !s.fired.includes('ctx-85')) trigger = 'ctx-85';
  else if (fill >= cfg.bands[0] && !s.fired.includes('ctx-60')) trigger = 'ctx-60';
  else if (sig.userTurns - s.turnsAtLastCapture >= cfg.turnsEvery) trigger = 'turns';
  if (!trigger) return { trigger: null, next: s };
  const fired = trigger === 'turns' ? s.fired
    : trigger === 'ctx-85' ? [...new Set([...s.fired, 'ctx-60', 'ctx-85'] as const)] : [...s.fired, 'ctx-60' as const];
  return { trigger, next: { ...s, fired, turnsAtLastCapture: sig.userTurns, lastCaptureAt: now } };
}
