// Knowledge capture settings (#483 spec §5a). Pure and import-free, so main
// (manifest parse/clamp, MCP tools, scheduler) and the renderer (workspace
// form, proposal card) share one definition. The parser is an allowlist and
// every value is clamped to its range on read and on write.

export type CaptureVisibility = 'fleet' | 'private';

export interface CaptureSettings {
  enabled: boolean;
  onSearchHit: boolean;
  searchTopSessions: number;
  recaptureAfterTurns: number;
  contextBands: number[];
  turnsEvery: number;
  model: string;
  transcriptRetentionDays: number;
  captureVisibility: CaptureVisibility;
}

export const CAPTURE_SETTING_FIELDS = [
  'enabled', 'onSearchHit', 'searchTopSessions', 'recaptureAfterTurns', 'contextBands',
  'turnsEvery', 'model', 'transcriptRetentionDays', 'captureVisibility'
] as const satisfies ReadonlyArray<keyof CaptureSettings>;

export const CAPTURE_LIMITS = {
  searchTopSessions: { min: 1, max: 5 },
  recaptureAfterTurns: { min: 10, max: 500 },
  contextBand: { min: 0.5, max: 0.95 },
  maxContextBands: 4,
  turnsEvery: { min: 10, max: 500 },
  transcriptRetentionDays: { min: 30, max: 3650 }
} as const;

export const CAPTURE_MODEL_RE = /^claude-[a-z0-9.\-\[\]]{1,60}$/;
export const DAILY_CAP_DEFAULT = 40;
export const DAILY_CAP_MAX = 500;

export function defaultCaptureSettings(): CaptureSettings {
  return {
    enabled: true, onSearchHit: true, searchTopSessions: 3, recaptureAfterTurns: 30, contextBands: [0.85],
    turnsEvery: 0, model: 'session', transcriptRetentionDays: 365, captureVisibility: 'fleet'
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function normalizeContextBands(v: unknown): number[] {
  if (!Array.isArray(v)) return defaultCaptureSettings().contextBands;
  const { min, max } = CAPTURE_LIMITS.contextBand;
  const vals = v
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    .map((x) => Math.round(Math.min(max, Math.max(min, x)) * 100) / 100);
  return [...new Set(vals)].sort((a, b) => a - b).slice(0, CAPTURE_LIMITS.maxContextBands);
}

export function clampDailyCap(v: unknown): number {
  return clampInt(v, 0, DAILY_CAP_MAX, DAILY_CAP_DEFAULT);
}

export function normalizeCaptureSettings(v: unknown): CaptureSettings {
  const d = defaultCaptureSettings();
  if (v === false) return { ...d, enabled: false };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
  const o = v as Record<string, unknown>;
  const L = CAPTURE_LIMITS;
  const t = typeof o.turnsEvery === 'number' && Number.isFinite(o.turnsEvery) ? Math.round(o.turnsEvery) : 0;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    onSearchHit: typeof o.onSearchHit === 'boolean' ? o.onSearchHit : d.onSearchHit,
    searchTopSessions: clampInt(o.searchTopSessions, L.searchTopSessions.min, L.searchTopSessions.max, d.searchTopSessions),
    recaptureAfterTurns: clampInt(o.recaptureAfterTurns, L.recaptureAfterTurns.min, L.recaptureAfterTurns.max, d.recaptureAfterTurns),
    contextBands: o.contextBands === undefined ? d.contextBands : normalizeContextBands(o.contextBands),
    turnsEvery: t <= 0 ? 0 : Math.min(L.turnsEvery.max, Math.max(L.turnsEvery.min, t)),
    model: o.model === 'session' || (typeof o.model === 'string' && CAPTURE_MODEL_RE.test(o.model)) ? (o.model as string) : d.model,
    transcriptRetentionDays: clampInt(o.transcriptRetentionDays, L.transcriptRetentionDays.min, L.transcriptRetentionDays.max, d.transcriptRetentionDays),
    captureVisibility: o.captureVisibility === 'private' ? 'private' : 'fleet'
  };
}

/** The settings a workspace runs with: its manifest object, clamped, with defaults filled in. */
export function effectiveCaptureSettings(spec: { knowledgeCapture?: unknown } | null | undefined): CaptureSettings {
  return normalizeCaptureSettings(spec?.knowledgeCapture);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

export function captureSettingsEqual(a: CaptureSettings, b: CaptureSettings): boolean {
  return CAPTURE_SETTING_FIELDS.every((k) => sameValue(a[k], b[k]));
}

export function isDefaultCaptureSettings(s: CaptureSettings): boolean {
  return captureSettingsEqual(s, defaultCaptureSettings());
}

/** Only the fields whose value differs, carrying the `after` value. */
export function diffCaptureSettings(before: CaptureSettings, after: CaptureSettings): Partial<CaptureSettings> {
  const out: Record<string, unknown> = {};
  for (const k of CAPTURE_SETTING_FIELDS) if (!sameValue(before[k], after[k])) out[k] = after[k];
  return out as Partial<CaptureSettings>;
}

const pct = (b: number): string => `${Math.round(b * 100)}%`;
function fmt(k: keyof CaptureSettings, v: unknown): string {
  if (k === 'contextBands') return (v as number[]).length ? (v as number[]).map(pct).join(', ') : 'none';
  if (k === 'turnsEvery' && v === 0) return 'off';
  return String(v);
}

/** "field: before → after" for each changed field, in field order. */
export function describeCaptureChange(before: CaptureSettings, after: CaptureSettings): string[] {
  return CAPTURE_SETTING_FIELDS.filter((k) => !sameValue(before[k], after[k]))
    .map((k) => `${k}: ${fmt(k, before[k])} → ${fmt(k, after[k])}`);
}

/** Spec §5a step 2: which changes raise capture cost (and so need approval
 *  unless the workspace is trusted). Everything else is neutral or cheaper. */
export function classifyCostIncrease(before: CaptureSettings, after: CaptureSettings): { increases: boolean; reasons: string[] } {
  const r: string[] = [];
  if (!before.enabled && after.enabled) r.push('turns knowledge capture on');
  if (!before.onSearchHit && after.onSearchHit) r.push('turns search-hit capture on');
  if (after.searchTopSessions > before.searchTopSessions) {
    r.push(`captures more sessions per search (${before.searchTopSessions} → ${after.searchTopSessions})`);
  }
  if (after.recaptureAfterTurns < before.recaptureAfterTurns) {
    r.push(`recaptures sooner (after ${before.recaptureAfterTurns} → ${after.recaptureAfterTurns} new turns)`);
  }
  const b = [...before.contextBands].sort((x, y) => x - y);
  const a = [...after.contextBands].sort((x, y) => x - y);
  if (a.length > b.length) r.push(`adds a context band (${fmt('contextBands', b)} → ${fmt('contextBands', a)})`);
  else if (a.some((v, i) => v < b[i])) r.push(`lowers a context band (${fmt('contextBands', b)} → ${fmt('contextBands', a)})`);
  if (before.turnsEvery === 0 && after.turnsEvery > 0) r.push(`turns periodic capture on (every ${after.turnsEvery} turns)`);
  else if (before.turnsEvery > 0 && after.turnsEvery > 0 && after.turnsEvery < before.turnsEvery) {
    r.push(`captures more often (every ${before.turnsEvery} → ${after.turnsEvery} turns)`);
  }
  if (after.model !== 'session' && after.model !== before.model) {
    r.push(`uses ${after.model} instead of the session's model (no prompt-cache reuse)`);
  }
  return { increases: r.length > 0, reasons: r };
}

/** set_capture_settings args → a typed partial. Unknown fields and wrong types
 *  are rejected; numbers are clamped later by normalizeCaptureSettings. */
export function parseCaptureSettingsPatch(args: Record<string, unknown>): { patch: Partial<CaptureSettings>; reason: string } {
  const allowed = new Set<string>([...CAPTURE_SETTING_FIELDS, 'reason']);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`unknown capture setting(s): ${unknown.join(', ')}`);
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
  if (!reason) throw new Error('reason is required (say why the change helps)');
  const patch: Partial<CaptureSettings> = {};
  for (const k of ['enabled', 'onSearchHit'] as const) {
    if (!(k in args)) continue;
    const v = args[k];
    if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
    patch[k] = v;
  }
  for (const k of ['searchTopSessions', 'recaptureAfterTurns', 'turnsEvery', 'transcriptRetentionDays'] as const) {
    if (!(k in args)) continue;
    const v = args[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    patch[k] = v;
  }
  if ('contextBands' in args) {
    const v = args.contextBands;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error('contextBands must be an array of fractions like [0.85]');
    }
    patch.contextBands = v as number[];
  }
  if ('model' in args) {
    const v = args.model;
    if (typeof v !== 'string' || (v !== 'session' && !CAPTURE_MODEL_RE.test(v))) {
      throw new Error('model must be "session" or a claude model id like "claude-sonnet-5"');
    }
    patch.model = v;
  }
  if ('captureVisibility' in args) {
    const v = args.captureVisibility;
    if (v !== 'fleet' && v !== 'private') throw new Error('captureVisibility must be "fleet" or "private"');
    patch.captureVisibility = v;
  }
  if (Object.keys(patch).length === 0) throw new Error('no settings to change');
  return { patch, reason };
}
