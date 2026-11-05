// Knowledge capture (#483): pure ingest-trigger policy (context bands +
// optional periodic turns). State lives in the scheduler. Search-hit triggers
// are decided in the scheduler, not here.
import type { CaptureSettings } from '../../preload/captureSettings.js';
import { contextWindowFor } from '../contextWindow.js';
import type { CaptureSignals } from '../db.js';
import type { CaptureTrigger } from './captureRunStore.js';

export interface CapturePolicyConfig { bands: number[]; turnsEvery: number; minIntervalMs: number }
export const CAPTURE_MIN_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_CAPTURE_POLICY: CapturePolicyConfig = { bands: [0.85], turnsEvery: 0, minIntervalMs: CAPTURE_MIN_INTERVAL_MS };

export interface SessionCaptureState {
  /** Band values already fired since the last compaction. */
  fired: number[];
  compactionsSeen: number;
  turnsAtLastCapture: number;
  lastCaptureAt: number | null;
}

export function bandTrigger(band: number): CaptureTrigger {
  return `ctx-${Math.round(band * 100)}`;
}

export function policyFromSettings(s: CaptureSettings): CapturePolicyConfig {
  return { bands: [...s.contextBands].sort((a, b) => a - b), turnsEvery: s.turnsEvery, minIntervalMs: CAPTURE_MIN_INTERVAL_MS };
}

/** The policy state for a session first seen in this app run, rebuilt from its
 *  last persisted capture run so an app restart doesn't re-fire a band. When
 *  that run was a context-band capture and the session hasn't compacted since
 *  (`capture_runs.compactions`), every band up to it counts as already fired. */
export function seedCaptureState(
  sig: CaptureSignals,
  last: { trigger: string; compactions: number | null; started_at: number } | null,
  cfg: CapturePolicyConfig
): SessionCaptureState {
  // A never-captured session gets its history captured once (turn counter from 0).
  if (!last) return { fired: [], compactionsSeen: sig.compactions, turnsAtLastCapture: 0, lastCaptureAt: null };
  const m = /^ctx-(\d+)$/.exec(last.trigger);
  const sameEpoch = last.compactions !== null && last.compactions === sig.compactions;
  const fired = m && sameEpoch ? cfg.bands.filter((b) => Math.round(b * 100) <= Number(m[1])) : [];
  return { fired, compactionsSeen: sig.compactions, turnsAtLastCapture: sig.userTurns, lastCaptureAt: last.started_at };
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
  const bands = [...cfg.bands].sort((a, b) => a - b);
  const crossed = bands.filter((b) => fill >= b && !s.fired.includes(b));
  if (crossed.length) {
    const top = crossed[crossed.length - 1];
    const fired = [...new Set([...s.fired, ...bands.filter((b) => b <= top)])];
    return { trigger: bandTrigger(top), next: { ...s, fired, turnsAtLastCapture: sig.userTurns, lastCaptureAt: now } };
  }
  if (cfg.turnsEvery > 0 && sig.userTurns - s.turnsAtLastCapture >= cfg.turnsEvery) {
    return { trigger: 'turns', next: { ...s, turnsAtLastCapture: sig.userTurns, lastCaptureAt: now } };
  }
  return { trigger: null, next: s };
}
