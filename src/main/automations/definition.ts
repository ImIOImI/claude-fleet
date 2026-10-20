// Automation definitions (#407 Phase 3): parse YAML/JSON, validate into an
// AutomationDef, and validate run arguments against declared params. Pure.
// Features owned by later phases are rejected with a message naming the phase.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AutomationDef, ParamDef, ParamValue, StepDef, TriggerDef } from '../../preload/inboxTypes.js';
import { normalizeTags } from '../inbox/inboxCore.js';
import { parseCron, isValidTimeZone, CronError } from './cron.js';

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const STEP_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const PARAM_RE = /^[a-z_][a-z0-9_]{0,39}$/;
const PLACEHOLDER_RE = /\{\{\s*([a-z]+)(?:\.([a-z0-9_]+))?((?:\.[a-z0-9_]+)*)\s*\}\}/gi;

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

/** "90s" | "10m" | "2h" → ms, or null. */
export function parseDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\s*(s|m|h)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000);
}

export interface ResolveCtx {
  /** Resolve a workspace id or name to an id (null if unknown). */
  workspace(idOrName: string): string | null;
}

export function parseDefinitionText(text: string): Validation<unknown> {
  try {
    const raw = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
    return { ok: true, value: raw };
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
}

export function definitionToYaml(def: AutomationDef): string {
  return stringifyYaml(def, { lineWidth: 0 });
}

function checkParamValue(p: ParamDef, v: unknown, where: string, errors: string[]): ParamValue | undefined {
  switch (p.type) {
    case 'string':
      if (typeof v === 'string') return v;
      break;
    case 'number':
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      break;
    case 'boolean':
      if (typeof v === 'boolean') return v;
      break;
    case 'enum':
      if (typeof v === 'string' && p.values?.includes(v)) return v;
      errors.push(`${where}: must be one of ${p.values?.join(', ')}`);
      return undefined;
  }
  errors.push(`${where}: must be a ${p.type}`);
  return undefined;
}

function validateParams(raw: unknown, errors: string[]): ParamDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push('params: must be a list'); return []; }
  const out: ParamDef[] = [];
  raw.forEach((p, i) => {
    const w = `params[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${w}: must be an object`); return; }
    const o = p as Record<string, unknown>;
    if (typeof o.name !== 'string' || !PARAM_RE.test(o.name)) { errors.push(`${w}.name: lowercase letters, digits, _ (max 40)`); return; }
    if (out.some((x) => x.name === o.name)) errors.push(`${w}.name: duplicate "${o.name}"`);
    if (!['string', 'number', 'boolean', 'enum'].includes(o.type as string)) { errors.push(`${w}.type: string, number, boolean or enum`); return; }
    const def: ParamDef = { name: o.name, type: o.type as ParamDef['type'] };
    if (o.type === 'enum') {
      if (!Array.isArray(o.values) || !o.values.length || !o.values.every((v) => typeof v === 'string')) { errors.push(`${w}.values: an enum needs a list of strings`); return; }
      def.values = o.values as string[];
    }
    if (o.required === true) def.required = true;
    if (typeof o.description === 'string') def.description = o.description.slice(0, 200);
    if (o.default !== undefined) {
      const v = checkParamValue(def, o.default, `${w}.default`, errors);
      if (v !== undefined) def.default = v;
    }
    out.push(def);
  });
  return out;
}

function validateTriggers(raw: unknown, params: ParamDef[], ctx: ResolveCtx, errors: string[]): TriggerDef[] {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push('triggers: at least one trigger (schedule or manual)'); return []; }
  const out: TriggerDef[] = [];
  raw.forEach((t, i) => {
    const w = `triggers[${i}]`;
    if (!t || typeof t !== 'object') { errors.push(`${w}: must be an object`); return; }
    const o = t as Record<string, unknown>;
    if ('event' in o) { errors.push(`${w}: event triggers arrive in a later phase (Phase 4)`); return; }
    if ('schedule' in o) {
      const s = (o.schedule ?? {}) as Record<string, unknown>;
      if (typeof s.cron !== 'string') { errors.push(`${w}.schedule.cron: required, e.g. "*/30 8-18 * * 1-5"`); return; }
      try { parseCron(s.cron); } catch (e) { errors.push(`${w}.schedule.cron: ${(e as CronError).message}`); return; }
      if (s.tz !== undefined && (typeof s.tz !== 'string' || !isValidTimeZone(s.tz))) { errors.push(`${w}.schedule.tz: unknown time zone`); return; }
      const trig: TriggerDef = { schedule: { cron: s.cron.trim(), ...(typeof s.tz === 'string' ? { tz: s.tz } : {}) } };
      if (s.args !== undefined) {
        const r = validateArgs(params, s.args as Record<string, unknown>);
        if (!r.ok) r.errors.forEach((e) => errors.push(`${w}.schedule.args: ${e}`));
        else (trig as { schedule: { args?: Record<string, ParamValue> } }).schedule.args = r.value;
      } else {
        const missing = params.filter((p) => p.required && p.default === undefined).map((p) => p.name);
        if (missing.length) errors.push(`${w}.schedule.args: required param${missing.length > 1 ? 's' : ''} ${missing.join(', ')} need${missing.length > 1 ? '' : 's'} a value`);
      }
      out.push(trig);
      return;
    }
    if ('manual' in o) {
      const m = (o.manual ?? {}) as Record<string, unknown>;
      const allow: string[] = [];
      if (m.allowFrom !== undefined) {
        if (!Array.isArray(m.allowFrom)) errors.push(`${w}.manual.allowFrom: must be a list of workspaces`);
        else for (const a of m.allowFrom) {
          const id = typeof a === 'string' ? ctx.workspace(a) : null;
          if (!id) errors.push(`${w}.manual.allowFrom: unknown workspace "${String(a)}"`);
          else allow.push(id);
        }
      }
      out.push({ manual: allow.length ? { allowFrom: allow } : {} });
      return;
    }
    errors.push(`${w}: must be a schedule or manual trigger`);
  });
  return out;
}

function validateSteps(raw: unknown, params: ParamDef[], ctx: ResolveCtx, errors: string[]): StepDef[] {
  if (!Array.isArray(raw) || raw.length === 0) { errors.push('steps: at least one step'); return []; }
  if (raw.length > 10) errors.push('steps: at most 10 steps');
  const out: StepDef[] = [];
  raw.forEach((s, i) => {
    const w = `steps[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${w}: must be an object`); return; }
    const o = s as Record<string, unknown>;
    if (typeof o.id !== 'string' || !STEP_RE.test(o.id)) { errors.push(`${w}.id: lowercase id like "triage"`); return; }
    if (out.some((x) => x.id === o.id)) errors.push(`${w}.id: duplicate "${o.id}"`);
    if ('script' in o) { errors.push(`${w}: script steps arrive in a later phase (Phase 7)`); return; }
    if (!('prompt' in o)) { errors.push(`${w}: must be a prompt step`); return; }
    const p = (o.prompt ?? {}) as Record<string, unknown>;
    if (p.workspace === '$self') { errors.push(`${w}.prompt.workspace: $self is for automations installed from a loadout (Phase 8)`); return; }
    const ws = typeof p.workspace === 'string' ? ctx.workspace(p.workspace) : null;
    if (!ws) { errors.push(`${w}.prompt.workspace: unknown workspace "${String(p.workspace ?? '')}"`); return; }
    const mode = p.mode ?? 'live';
    if (mode === 'fresh') { errors.push(`${w}.prompt.mode: fresh sessions arrive in a later phase (Phase 4); use live`); return; }
    if (mode !== 'live') { errors.push(`${w}.prompt.mode: live`); return; }
    if (typeof p.message !== 'string' || !p.message.trim()) { errors.push(`${w}.prompt.message: required`); return; }
    if (p.message.length > 8000) errors.push(`${w}.prompt.message: longer than 8000 characters`);
    for (const m of p.message.matchAll(PLACEHOLDER_RE)) {
      const [whole, ns, key] = m;
      if (ns === 'args' && !params.some((x) => x.name === key)) errors.push(`${w}.prompt.message: ${whole} names no declared param`);
      else if (ns === 'trigger' && key !== 'kind') errors.push(`${w}.prompt.message: ${whole}: only {{trigger.kind}} is available`);
      else if (ns === 'run' && key !== 'id') errors.push(`${w}.prompt.message: ${whole}: only {{run.id}} is available`);
      else if (ns === 'steps') errors.push(`${w}.prompt.message: ${whole}: step output arrives with script steps (Phase 7)`);
      else if (!['args', 'trigger', 'run', 'steps'].includes(ns)) errors.push(`${w}.prompt.message: unknown placeholder ${whole}`);
    }
    let timeout: string | undefined;
    if (p.timeout !== undefined) {
      const ms = parseDuration(p.timeout);
      if (ms === null || ms < 10_000 || ms > 2 * 3_600_000) errors.push(`${w}.prompt.timeout: a duration between 10s and 2h, like "10m"`);
      else timeout = String(p.timeout).trim();
    }
    out.push({
      id: o.id,
      prompt: {
        workspace: ws, mode: 'live', message: p.message,
        ...(p.wait === true ? { wait: true } : {}),
        ...(p.ensureRunning === true ? { ensureRunning: true } : {}),
        ...(timeout ? { timeout } : {})
      }
    });
  });
  return out;
}

export function validateDefinition(raw: unknown, ctx: ResolveCtx): Validation<AutomationDef> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the definition must be a YAML mapping'] };
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) errors.push('name: lowercase letters, digits and dashes, e.g. "webex-triage"');
  if (o.secrets !== undefined && !(Array.isArray(o.secrets) && o.secrets.length === 0)) errors.push('secrets: used by script steps, which arrive in a later phase (Phase 7)');
  if (o.concurrency !== undefined && o.concurrency !== 'skip' && o.concurrency !== 'queue') errors.push('concurrency: skip or queue');
  if (o.timeout !== undefined) {
    const ms = parseDuration(o.timeout);
    if (ms === null || ms < 60_000 || ms > 6 * 3_600_000) errors.push('timeout: a duration between 1m and 6h, like "30m"');
  }
  const params = validateParams(o.params, errors);
  const triggers = validateTriggers(o.triggers, params, ctx, errors);
  const steps = validateSteps(o.steps, params, ctx, errors);
  if (errors.length) return { ok: false, errors };
  const def: AutomationDef = {
    name: o.name as string,
    ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim().slice(0, 300) } : {}),
    ...(Array.isArray(o.tags) ? { tags: normalizeTags(o.tags) } : {}),
    triggers,
    concurrency: o.concurrency === 'queue' ? 'queue' : 'skip',
    ...(typeof o.timeout === 'string' ? { timeout: o.timeout.trim() } : {}),
    ...(params.length ? { params } : {}),
    steps
  };
  return { ok: true, value: def };
}

/** Validate run arguments: types, enums, required, unknown names; fills defaults.
 *  `coerce` turns form strings into numbers/booleans (the Run-now modal). */
export function validateArgs(params: ParamDef[] | undefined, raw: Record<string, unknown> | undefined, coerce = false): Validation<Record<string, ParamValue>> {
  const errors: string[] = [];
  const out: Record<string, ParamValue> = {};
  const ps = params ?? [];
  const given = raw && typeof raw === 'object' ? raw : {};
  for (const k of Object.keys(given)) if (!ps.some((p) => p.name === k)) errors.push(`${k}: no such param`);
  for (const p of ps) {
    let v = given[p.name];
    if (v === undefined || v === '') {
      if (p.default !== undefined) out[p.name] = p.default;
      else if (p.required) errors.push(`${p.name}: required`);
      continue;
    }
    if (coerce && typeof v === 'string') {
      if (p.type === 'number' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (p.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
    }
    const ok = checkParamValue(p, v, p.name, errors);
    if (ok !== undefined) out[p.name] = ok;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export const STARTER_YAML = `name: morning-error-check
description: Ask a workspace to check overnight errors and post todos for anything that needs me.
tags: [ops]
triggers:
  - schedule: { cron: "0 8 * * 1-5" }
  - manual: {}
params:
  - { name: since, type: string, default: "12h", description: How far back to look }
steps:
  - id: check
    prompt:
      workspace: REPLACE-WITH-WORKSPACE-NAME
      mode: live
      message: |
        Check the service logs from the last {{args.since}} for new errors.
        Post a todo (with a dedupe key per error) for anything that needs me.
`;
