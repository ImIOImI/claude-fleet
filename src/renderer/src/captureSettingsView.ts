// Knowledge capture settings (#483 §5a) ⇄ the workspace form's string-backed
// inputs. Pure (the shared settings module has no imports), so unit-testable.
import {
  CAPTURE_MODEL_RE, isDefaultCaptureSettings, normalizeCaptureSettings,
  type CaptureSettings, type CaptureVisibility
} from '../../preload/captureSettings';

export interface CaptureFormState {
  enabled: boolean;
  onSearchHit: boolean;
  searchTopSessions: string;
  recaptureAfterTurns: string;
  contextBands: string;
  turnsEvery: string;
  model: string;
  transcriptRetentionDays: string;
  captureVisibility: CaptureVisibility;
}

export function formatBands(bands: number[]): string {
  return bands.map((b) => String(Math.round(b * 100))).join(', ');
}

/** "60, 85" / "70%" / "0.75" → fractions; blank → []; anything unparseable → null. */
export function parseBands(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).map((p) => p.replace(/%$/, '')).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v)) return null;
    out.push(v > 1 ? v / 100 : v);
  }
  return out;
}

export function toCaptureForm(s: CaptureSettings | undefined): CaptureFormState {
  const n = normalizeCaptureSettings(s);
  return {
    enabled: n.enabled, onSearchHit: n.onSearchHit,
    searchTopSessions: String(n.searchTopSessions), recaptureAfterTurns: String(n.recaptureAfterTurns),
    contextBands: formatBands(n.contextBands), turnsEvery: String(n.turnsEvery), model: n.model,
    transcriptRetentionDays: String(n.transcriptRetentionDays), captureVisibility: n.captureVisibility
  };
}

const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));

export function fromCaptureForm(f: CaptureFormState): { settings: CaptureSettings; error: string | null } {
  const bands = parseBands(f.contextBands);
  const model = f.model.trim() || 'session';
  const settings = normalizeCaptureSettings({
    enabled: f.enabled, onSearchHit: f.onSearchHit,
    searchTopSessions: num(f.searchTopSessions), recaptureAfterTurns: num(f.recaptureAfterTurns),
    contextBands: bands ?? undefined, turnsEvery: num(f.turnsEvery) ?? 0, model,
    transcriptRetentionDays: num(f.transcriptRetentionDays), captureVisibility: f.captureVisibility
  });
  let error: string | null = null;
  if (bands === null) error = 'Context bands must be percentages like "85" or "60, 85".';
  else if (model !== 'session' && !CAPTURE_MODEL_RE.test(model)) error = 'Model must be "session" or a claude model id like claude-sonnet-5.';
  return { settings, error };
}

/** Defaults are submitted as absent so the manifest stays minimal. */
export function captureSubmitValue(s: CaptureSettings): CaptureSettings | undefined {
  return isDefaultCaptureSettings(s) ? undefined : s;
}

export function captureSummary(s: CaptureSettings): string {
  if (!s.enabled) return 'off';
  return [
    s.onSearchHit ? `search top ${s.searchTopSessions}` : 'no search capture',
    s.contextBands.length ? `at ${s.contextBands.map((b) => `${Math.round(b * 100)}%`).join('/')} context` : 'no context bands',
    s.turnsEvery > 0 ? `every ${s.turnsEvery} turns` : null,
    s.model !== 'session' ? s.model : null,
    `keep ${s.transcriptRetentionDays} d`,
    s.captureVisibility === 'private' ? 'private' : null
  ].filter((x): x is string => x !== null).join(' · ');
}
