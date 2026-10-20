// Automations shipped in loadouts (#407 Phase 8). Pure (node fs + yaml only).
// Convention: `automations/<name>/automation.yaml` in a loadout folder, plus any
// script files beside it. A script step's `run: ./file.sh` is inlined from that
// folder at install. `$self` (prompt.workspace, script.runIn, event.workspace,
// manual.allowFrom) binds to the workspace the loadout is installed into.
import { readFile, readdir } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AutomationDef } from '../../preload/inboxTypes.js';
import { parseDefinitionText, validateDefinition, MAX_SCRIPT_CHARS, type ResolveCtx } from './definition.js';

export interface LoadoutAutomationSource {
  /** Folder name under automations/. */
  folder: string;
  /** The YAML as shipped. */
  text: string;
  /** Script files beside it, by relative path (for `run: ./x.sh`). */
  files: Record<string, string>;
}

export async function readLoadoutAutomations(srcDir: string): Promise<LoadoutAutomationSource[]> {
  const root = join(srcDir, 'automations');
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: LoadoutAutomationSource[] = [];
  for (const d of dirs.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(root, d.name);
    const text = await readFile(join(dir, 'automation.yaml'), 'utf8').catch(() => null);
    if (text === null) continue;
    const files: Record<string, string> = {};
    for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (f.isFile() && f.name !== 'automation.yaml') files[f.name] = await readFile(join(dir, f.name), 'utf8');
    }
    out.push({ folder: d.name, text, files });
  }
  return out;
}

/** Replace `$self` with the install target and inline `run: ./file` scripts. Mutates a parsed (unvalidated) definition. */
export function bindLoadoutDefinition(raw: unknown, targetId: string, files: Record<string, string>): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return errors;
  const o = raw as Record<string, unknown>;
  const self = (v: unknown) => (v === '$self' ? targetId : v);
  for (const t of Array.isArray(o.triggers) ? o.triggers : []) {
    const tt = t as Record<string, Record<string, unknown>>;
    if (tt?.event && typeof tt.event === 'object') tt.event.workspace = self(tt.event.workspace) as never;
    if (tt?.manual && Array.isArray(tt.manual.allowFrom)) tt.manual.allowFrom = tt.manual.allowFrom.map(self) as never;
  }
  (Array.isArray(o.steps) ? o.steps : []).forEach((s, i) => {
    const st = s as Record<string, Record<string, unknown>>;
    if (st?.prompt && typeof st.prompt === 'object') st.prompt.workspace = self(st.prompt.workspace) as never;
    if (st?.script && typeof st.script === 'object') {
      st.script.runIn = self(st.script.runIn) as never;
      const run = st.script.run;
      if (typeof run === 'string' && /^\.\/[^\s]+$/.test(run.trim())) {
        const rel = normalize(run.trim().slice(2));
        const body = rel.includes('..') || rel.startsWith(sep) ? undefined : files[rel];
        if (body === undefined) errors.push(`steps[${i}].script.run: ${run.trim()} isn't a file in this automation's folder`);
        else if (body.length > MAX_SCRIPT_CHARS) errors.push(`steps[${i}].script.run: ${run.trim()} is longer than ${MAX_SCRIPT_CHARS} characters`);
        else st.script.run = body as never;
      }
    }
  });
  return errors;
}

export interface PreparedAutomation {
  folder: string;
  name: string;
  ok: boolean;
  errors: string[];
  definition: AutomationDef | null;
  hostStep: boolean;
  /** Secrets its scripts declare that aren't set where they'll run. */
  missingSecrets: string[];
}

/**
 * Parse, bind and validate a loadout's automations for one install target.
 * `secretKeys(ws)` lists the vault keys of a workspace; `automationsWs` is
 * where default script steps (and host steps' secrets) live.
 */
export function prepareLoadoutAutomations(
  sources: LoadoutAutomationSource[], targetId: string, ctx: ResolveCtx,
  secretKeys: (ws: string) => string[], automationsWs: string | null
): PreparedAutomation[] {
  return sources.map((src) => {
    const parsed = parseDefinitionText(src.text);
    if (!parsed.ok) return { folder: src.folder, name: src.folder, ok: false, errors: parsed.errors, definition: null, hostStep: false, missingSecrets: [] };
    const bindErrors = bindLoadoutDefinition(parsed.value, targetId, src.files);
    const v = validateDefinition(parsed.value, ctx);
    const name = typeof (parsed.value as { name?: unknown })?.name === 'string' ? (parsed.value as { name: string }).name : src.folder;
    if (!v.ok || bindErrors.length) {
      return { folder: src.folder, name, ok: false, errors: [...bindErrors, ...(v.ok ? [] : v.errors)], definition: null, hostStep: false, missingSecrets: [] };
    }
    const def = v.value;
    const missing: string[] = [];
    let hostStep = false;
    for (const s of def.steps) {
      if (!('script' in s)) continue;
      if (s.script.runIn === 'host') hostStep = true;
      const where = s.script.runIn && s.script.runIn !== 'host' ? s.script.runIn : automationsWs;
      const have = new Set(where ? secretKeys(where) : []);
      for (const k of s.script.secrets ?? []) if (!have.has(k) && !missing.includes(k)) missing.push(k);
    }
    return { folder: src.folder, name: def.name, ok: true, errors: [], definition: def, hostStep, missingSecrets: missing };
  });
}

export interface LoadoutOrigin {
  loadoutId: string;
  version: string | null;
  workspaceId: string;
  /** The folder under automations/ it came from. */
  folder: string;
  /** The automation's version right after install/update; a higher version means you edited it. */
  installedVersion: number;
}

/** A name for a second copy (another install target) of a loadout automation. */
export function copyName(name: string, workspaceName: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const base = `${name}-${workspaceName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 56);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error(`no free name for ${name}`);
}

/** The `version` from a loadout's loadout.md frontmatter, if any. */
export async function readLoadoutVersion(srcDir: string): Promise<string | null> {
  const md = await readFile(join(srcDir, 'loadout.md'), 'utf8').catch(() => '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  try {
    const v = (parseYaml(m[1]) as { version?: unknown } | null)?.version;
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}
