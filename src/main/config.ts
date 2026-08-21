// App-level settings, persisted to <userData>/config.json. Currently just the
// "fleet root" — the single host directory that holds every workspace's
// private folder (<fleetRoot>/<id>) plus the cross-container shared folder
// (<fleetRoot>/shared). Replaces the old per-workspace "workspace root" the
// create form used to collect.

import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertValidWorkspaceId } from './paths.js';
import { toggleFavorite } from './ociCore.js';

/** Which plan the usage bar measures spend against. `custom` uses the
 *  user-entered token amount; the rest resolve to USAGE_BUDGET_PRESETS. */
export type UsageBudgetPreset = 'pro' | 'max5' | 'max20' | 'custom';

/**
 * Estimated total tokens (input + output + cache create + cache read) available
 * in one rolling window per Claude plan. Anthropic does not publish exact
 * per-window token limits, so these are order-of-magnitude estimates anchored
 * to the official Pro→Max multipliers (Max 5× / Max 20× per session). The user
 * calibrates against their real ceiling via the `custom` preset — the live
 * rolling-spend readout makes the bar self-correcting. Refresh if Anthropic
 * publishes concrete numbers.
 */
export const USAGE_BUDGET_PRESETS: Record<Exclude<UsageBudgetPreset, 'custom'>, number> = {
  pro: 19_000_000,
  max5: 95_000_000,
  max20: 380_000_000
};

/** The trailing window the plan-usage bar meters spend over. Anthropic's
 *  subscription limits reset on a ~5-hour rolling basis. */
export const USAGE_BUDGET_WINDOW_HOURS = 5;

const DEFAULT_USAGE_PRESET: UsageBudgetPreset = 'pro';
const DEFAULT_CUSTOM_TOKENS = USAGE_BUDGET_PRESETS.pro;

interface UsageBudgetConfig {
  preset: UsageBudgetPreset;
  /** The allowance used when `preset === 'custom'`. */
  customTokens: number;
}

/** Stored usage-budget config plus the fields the renderer derives from it. */
export interface ResolvedUsageBudget extends UsageBudgetConfig {
  /** Effective allowance after resolving preset → tokens (0 hides the % bar). */
  allowanceTokens: number;
  windowHours: number;
  presets: typeof USAGE_BUDGET_PRESETS;
}

/** Visual/display preferences: pure UI toggles + left-rail
 *  session filters. All display-only — tracking and the DB are unaffected.
 *  0 means "unlimited" for both numeric filters. */
export interface UiPrefs {
  showBudgetBar: boolean;
  showSessionCost: boolean;
  maxSessions: number;
  maxSessionAgeDays: number;
}

/** Which xterm renderer each terminal pane uses.
 *
 *  `dom` (default) is what the app has always used, and it is the only one
 *  that does native per-glyph CSS font fallback — the bundled Noto Sans
 *  Symbols 2 / Unifont subsets that keep claude's ⏵ (U+23F5) and ⎿ (U+23BF)
 *  from rendering as tofu depend on it. It is also, being thousands of
 *  absolutely-positioned spans in a scrolling container, the renderer most
 *  exposed to Chromium's scroll/paint invalidation leaving narrow stale
 *  strips behind (#268). `canvas` and `webgl` paint the whole grid into one
 *  element, which cannot exhibit that, at the cost of xterm doing its own
 *  glyph fallback. Opt-in until the font trade-off is measured. */
export type TerminalRenderer = 'dom' | 'canvas' | 'webgl';

interface AppConfig {
  fleetRoot?: string;
  /** When true, the app skips Chromium hardware acceleration at startup. */
  disableHardwareAcceleration?: boolean;
  /** xterm renderer for terminal panes. Absent ⇒ 'dom'. See TerminalRenderer. */
  terminalRenderer?: TerminalRenderer;
  /** When true (default), installing/updating a loadout into a running
   *  workspace auto-reloads its Claude session (`--resume`) to load the loadout
   *  — but only while Claude is idle; deferred until it stops working. (#16) */
  autoReloadLoadouts?: boolean;
  /** Plan-usage budget for the observability rail's "tokens left" bar. */
  usageBudget?: UsageBudgetConfig;
  /** Global loadout favorites (loadout ids), shown in every workspace's rail. */
  favorites?: string[];
  /** Display preferences; partial on disk — getUiPrefs() resolves defaults. */
  uiPrefs?: Partial<UiPrefs>;
  /** Perf telemetry recording (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md).
   *  Absent ⇒ default ON. CLAUDE_FLEET_PERF=0 overrides at resolve time (perfConfig.ts). */
  perfTelemetry?: boolean;
  /** OTLP export of perf traces/metrics. Default off; OTEL_EXPORTER_OTLP_ENDPOINT overrides. */
  perfOtlp?: { enabled: boolean; endpoint: string };
}

/** Defensively parse the persisted usageBudget (untrusted JSON on disk). */
function parseUsageBudget(v: unknown): UsageBudgetConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const preset = o.preset;
  if (preset !== 'pro' && preset !== 'max5' && preset !== 'max20' && preset !== 'custom') {
    return undefined;
  }
  const customTokens =
    typeof o.customTokens === 'number' && Number.isFinite(o.customTokens) && o.customTokens >= 0
      ? Math.round(o.customTokens)
      : DEFAULT_CUSTOM_TOKENS;
  return { preset, customTokens };
}

/** Defensively parse persisted/incoming uiPrefs (untrusted JSON). Keeps only
 *  well-typed keys: booleans as-is; numbers rounded, negatives rejected. */
function parseUiPrefs(v: unknown): Partial<UiPrefs> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<UiPrefs> = {};
  if (typeof o.showBudgetBar === 'boolean') out.showBudgetBar = o.showBudgetBar;
  if (typeof o.showSessionCost === 'boolean') out.showSessionCost = o.showSessionCost;
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined;
  const maxSessions = num(o.maxSessions);
  if (maxSessions !== undefined) out.maxSessions = maxSessions;
  const maxSessionAgeDays = num(o.maxSessionAgeDays);
  if (maxSessionAgeDays !== undefined) out.maxSessionAgeDays = maxSessionAgeDays;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Defensively parse the persisted perfOtlp block (untrusted JSON on disk). */
function parsePerfOtlp(v: unknown): { enabled: boolean; endpoint: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : ''
  };
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/** Default fleet root: `~/fleet`. Portable, and matches existing setups. */
export function defaultFleetRoot(): string {
  return join(app.getPath('home'), 'fleet');
}

let cached: AppConfig | null = null;

async function read(): Promise<AppConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as AppConfig;
    cached = {
      fleetRoot: typeof parsed.fleetRoot === 'string' && parsed.fleetRoot ? parsed.fleetRoot : undefined,
      disableHardwareAcceleration: parsed.disableHardwareAcceleration === true,
      // Persist as-is so an explicit `false` survives a reload; absent ⇒ default
      // on (see getAutoReloadLoadouts).
      autoReloadLoadouts:
        typeof parsed.autoReloadLoadouts === 'boolean' ? parsed.autoReloadLoadouts : undefined,
      usageBudget: parseUsageBudget(parsed.usageBudget),
      uiPrefs: parseUiPrefs(parsed.uiPrefs),
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((x): x is string => typeof x === 'string')
        : undefined,
      perfTelemetry: typeof parsed.perfTelemetry === 'boolean' ? parsed.perfTelemetry : undefined,
      perfOtlp: parsePerfOtlp(parsed.perfOtlp)
    };
  } catch {
    cached = {};
  }
  return cached;
}

async function write(next: AppConfig): Promise<void> {
  cached = next;
  await writeFile(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/**
 * The fleet root. Precedence: `CLAUDE_FLEET_ROOT` env override (used by the
 * e2e suite to keep test runs out of the real `~/fleet`) → the persisted
 * config value → the `~/fleet` default. Always absolute.
 */
export async function getFleetRoot(): Promise<string> {
  const override = process.env.CLAUDE_FLEET_ROOT?.trim();
  if (override) return override;
  const cfg = await read();
  return cfg.fleetRoot ?? defaultFleetRoot();
}

/** Persist a new fleet root. The directory is created if it doesn't exist. */
export async function setFleetRoot(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('Fleet root cannot be empty');
  await mkdir(trimmed, { recursive: true });
  const cfg = await read();
  await write({ ...cfg, fleetRoot: trimmed });
}

/**
 * Whether to disable Chromium hardware acceleration, decided at startup.
 * Precedence: `CLAUDE_FLEET_DISABLE_HWA=1` env override (dev shortcut) → the
 * persisted setting → off. Read **synchronously** because
 * `app.disableHardwareAcceleration()` must be called before the `ready`
 * event, before the async config cache is warmed. `app.getPath('userData')`
 * is available this early.
 */
export function hardwareAccelDisabledAtStartup(): boolean {
  if (process.env.CLAUDE_FLEET_DISABLE_HWA === '1') return true;
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as AppConfig;
    return parsed.disableHardwareAcceleration === true;
  } catch {
    return false;
  }
}

/** The persisted hardware-acceleration setting (ignores the env override). */
export async function getHardwareAccelDisabled(): Promise<boolean> {
  const cfg = await read();
  return cfg.disableHardwareAcceleration === true;
}

/** Persist the hardware-acceleration setting. Takes effect on next launch. */
export async function setHardwareAccelDisabled(disabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, disableHardwareAcceleration: disabled });
}

/** The terminal renderer setting. Unknown/absent values resolve to 'dom' so a
 *  hand-edited config can't leave the app with no working renderer. */
export async function getTerminalRenderer(): Promise<TerminalRenderer> {
  // Env override first, mirroring CLAUDE_FLEET_DISABLE_HWA — lets the e2e
  // suite exercise every renderer without hand-writing a config file.
  const env = process.env.CLAUDE_FLEET_TERMINAL_RENDERER;
  if (env === 'canvas' || env === 'webgl' || env === 'dom') return env;
  const cfg = await read();
  const v = cfg.terminalRenderer;
  return v === 'canvas' || v === 'webgl' ? v : 'dom';
}

/** Effective renderer for one workspace (#268): env override (tests) → the
 *  workspace's own setting → the app-level default → 'dom'. Per-workspace,
 *  because the artifact this works around is reported on local workspaces and
 *  the DOM renderer is otherwise preferable for its font fallback. */
export async function resolveTerminalRenderer(
  workspaceOverride?: TerminalRenderer
): Promise<TerminalRenderer> {
  const env = process.env.CLAUDE_FLEET_TERMINAL_RENDERER;
  if (env === 'canvas' || env === 'webgl' || env === 'dom') return env;
  if (
    workspaceOverride === 'canvas' ||
    workspaceOverride === 'webgl' ||
    workspaceOverride === 'dom'
  ) {
    return workspaceOverride;
  }
  return getTerminalRenderer();
}

/** Persist the terminal renderer. Takes effect on the next pane mount
 *  (workspace switch or restart), not retroactively on live panes. */
export async function setTerminalRenderer(renderer: TerminalRenderer): Promise<void> {
  const cfg = await read();
  const v: TerminalRenderer =
    renderer === 'canvas' || renderer === 'webgl' ? renderer : 'dom';
  await write({ ...cfg, terminalRenderer: v });
}

/** Auto-reload loadouts into a running workspace when Claude is idle. Default on. */
export async function getAutoReloadLoadouts(): Promise<boolean> {
  const cfg = await read();
  return cfg.autoReloadLoadouts !== false; // default true
}

export async function setAutoReloadLoadouts(enabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, autoReloadLoadouts: enabled });
}

/** Perf-telemetry recording setting. Default on. (Env override lives in perfConfig.ts.) */
export async function getPerfTelemetry(): Promise<boolean> {
  const cfg = await read();
  return cfg.perfTelemetry !== false; // default true
}

export async function setPerfTelemetry(enabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, perfTelemetry: enabled });
}

/** OTLP export setting (endpoint kept even while disabled — the Settings UI
 *  shows it greyed out rather than losing it). */
export async function getPerfOtlp(): Promise<{ enabled: boolean; endpoint: string }> {
  const cfg = await read();
  return cfg.perfOtlp ?? { enabled: false, endpoint: '' };
}

export async function setPerfOtlp(enabled: boolean, endpoint: string): Promise<void> {
  const trimmed = endpoint.trim();
  if (enabled) {
    if (!trimmed) throw new Error('OTLP export needs an endpoint URL');
    if (!/^https?:\/\//.test(trimmed)) throw new Error('OTLP endpoint must be an http(s) URL');
  }
  const cfg = await read();
  await write({ ...cfg, perfOtlp: { enabled, endpoint: trimmed } });
}

/**
 * The plan-usage budget for the observability rail, resolved for the renderer:
 * the stored preset/custom amount plus the effective `allowanceTokens`, the
 * rolling window, and the preset table (so Settings can label each option).
 * Defaults to the Pro preset.
 */
export async function getUsageBudget(): Promise<ResolvedUsageBudget> {
  const cfg = await read();
  const stored = cfg.usageBudget ?? {
    preset: DEFAULT_USAGE_PRESET,
    customTokens: DEFAULT_CUSTOM_TOKENS
  };
  const allowanceTokens =
    stored.preset === 'custom' ? stored.customTokens : USAGE_BUDGET_PRESETS[stored.preset];
  return {
    ...stored,
    allowanceTokens,
    windowHours: USAGE_BUDGET_WINDOW_HOURS,
    presets: USAGE_BUDGET_PRESETS
  };
}

/** Persist the usage-budget preset (and the custom token amount it falls back to). */
export async function setUsageBudget(
  preset: UsageBudgetPreset,
  customTokens: number
): Promise<void> {
  const cfg = await read();
  const clean =
    Number.isFinite(customTokens) && customTokens >= 0
      ? Math.round(customTokens)
      : DEFAULT_CUSTOM_TOKENS;
  await write({ ...cfg, usageBudget: { preset, customTokens: clean } });
}

/** Display preferences, resolved for the renderer: absent toggles default to
 *  shown, absent filters to 0 (unlimited) — so existing installs see no change. */
export async function getUiPrefs(): Promise<UiPrefs> {
  const cfg = await read();
  return {
    showBudgetBar: cfg.uiPrefs?.showBudgetBar !== false,
    showSessionCost: cfg.uiPrefs?.showSessionCost !== false,
    maxSessions: cfg.uiPrefs?.maxSessions ?? 0,
    maxSessionAgeDays: cfg.uiPrefs?.maxSessionAgeDays ?? 0
  };
}

/** Shallow-merge a partial update into the stored uiPrefs. Invalid values are
 *  dropped by parseUiPrefs (prior/default value wins), never written. */
export async function setUiPrefs(partial: Partial<UiPrefs>): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, uiPrefs: { ...cfg.uiPrefs, ...parseUiPrefs(partial) } });
}

/** `<fleetRoot>/<id>` — a workspace's private folder, mounted at /workspace. */
export async function fleetPrivateDir(id: string): Promise<string> {
  assertValidWorkspaceId(id);
  return join(await getFleetRoot(), id);
}

/** `<fleetRoot>/shared` — mounted into every container at /shared (rw). */
export async function fleetSharedDir(): Promise<string> {
  return join(await getFleetRoot(), 'shared');
}

/** Return the current global loadout favorites list. */
export async function getFavorites(): Promise<string[]> {
  const cfg = await read();
  return cfg.favorites ?? [];
}

/** Toggle a global loadout favorite and persist it. Returns the new list. */
export async function setFavorite(id: string, on: boolean): Promise<string[]> {
  const cfg = await read();
  const favorites = toggleFavorite(cfg.favorites ?? [], id, on);
  await write({ ...cfg, favorites });
  return favorites;
}

/** The `get_config` MCP payload: effective fleet tunables for one workspace
 *  (app defaults ⊕ the workspace's plain-env overrides), plus the live host
 *  app version + build sha and the manifest's configured runner image
 *  (#219, #298). `app.sha` is the git short sha of the running build (null
 *  when unknown) — the semver alone can't distinguish two builds of the same
 *  release, which is exactly what telemetry comparisons need. Pure — callers
 *  supply the manifest fields and the version/sha — so the shape is
 *  unit-testable without Electron. `runnerImage` is the image *reference*
 *  the workspace was created with (null for local workspaces); it does not
 *  say which build of that tag the live container runs — that needs a docker
 *  inspect and stays a #219 follow-up. `backend` describes the model backend
 *  the workspace was created with (mode + endpoint metadata); never includes
 *  the API token — that stays in the vault. */
export function resolveWorkspaceConfig(
  workspaceId: string,
  env: Record<string, string>,
  appVer: { version: string; sha: string | null },
  image?: string,
  backend?: { mode: 'oauth' | 'apikey' | 'endpoint'; endpoint: { name: string; baseUrl: string; modelId: string } | null }
): {
  workspaceId: string;
  app: { version: string; sha: string | null };
  runnerImage: { name: string } | null;
  summarizer: { model: string; minNewTurns: number; minIntervalS: number; windowChars: number; maxChaptersPerRun: number };
  backfill: { enabled: boolean; maxPerSweep: number; delayS: number };
  backend: { mode: 'oauth' | 'apikey' | 'endpoint'; endpoint: { name: string; baseUrl: string; modelId: string } | null };
} {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    workspaceId,
    app: { version: appVer.version, sha: appVer.sha },
    runnerImage: image ? { name: image } : null,
    summarizer: {
      model: typeof env.CF_SUMMARY_MODEL === 'string' ? env.CF_SUMMARY_MODEL : 'haiku',
      minNewTurns: num(env.CF_SUMMARY_MIN_NEW_TURNS, 20),
      minIntervalS: num(env.CF_SUMMARY_MIN_INTERVAL_S, 120),
      windowChars: num(env.CF_SUMMARY_WINDOW_CHARS, 8000),
      maxChaptersPerRun: num(env.CF_SUMMARY_MAX_CHAPTERS_PER_RUN, 5)
    },
    backfill: {
      enabled: env.CF_BACKFILL !== '0',
      maxPerSweep: num(env.CF_BACKFILL_MAX_PER_SWEEP, 10),
      delayS: num(env.CF_BACKFILL_DELAY_S, 3)
    },
    backend: backend ?? { mode: 'oauth', endpoint: null }
  };
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetConfigCacheForTests(): void {
  cached = null;
}
