// Drafting for a remote workspace runs locally (D127): the local automations
// workspace drafts the host's config entry and submits it with the usual
// proposal tools. A definition that names a remote workspace the user asked to
// draft for becomes a draft held in memory (nothing remote is persisted, D62),
// shown as YAML for a platform-ops PR. Nothing is sent to the host.
import type { AutomationDef } from '../../preload/inboxTypes.js';
import type { RemoteDraft } from '../../preload/remoteAutomations.js';
import { remoteHostRefusals, substituteSelf } from '../../host/hostDefinition.js';
import { oneLine } from '../remoteUrl.js';
import type { FederatedReader } from '../federation/federatedReader.js';
import { parseAutomationDetail, parseAutomationRows } from '../federation/remoteAutomationRows.js';
import { remoteDraftPrompt } from './authoring.js';
import { definitionToYaml, parseDefinitionText, validateDefinition } from './definition.js';

export const REMOTE_DRAFT_REQUEST_MS = 3_600_000;
export const MAX_REMOTE_DRAFTS = 20;

export interface RemoteDraftsDeps {
  now(): number;
  /** Remote bookmarks: a draft for one that is gone is dropped. */
  sources(): Array<{ id: string; name: string }>;
  newId(): string;
  changed(): void;
}

/** Every workspace a definition names, before validation. */
function workspaceRefs(raw: unknown): string[] {
  const o = raw as { steps?: unknown; triggers?: unknown } | null;
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string') out.push(v); };
  for (const s of Array.isArray(o?.steps) ? o.steps : []) {
    const x = s as { prompt?: { workspace?: unknown }; script?: { runIn?: unknown } } | null;
    add(x?.prompt?.workspace);
    add(x?.script?.runIn);
  }
  for (const t of Array.isArray(o?.triggers) ? o.triggers : []) {
    const x = t as { event?: { workspace?: unknown }; manual?: { allowFrom?: unknown } } | null;
    add(x?.event?.workspace);
    if (Array.isArray(x?.manual?.allowFrom)) x.manual.allowFrom.forEach(add);
  }
  return out;
}

export function createRemoteDrafts(d: RemoteDraftsDeps) {
  const requested = new Map<string, number>();
  let drafts: RemoteDraft[] = [];

  const live = () => {
    const now = d.now();
    for (const [o, until] of requested) if (until <= now) requested.delete(o);
    return d.sources().filter((s) => requested.has(s.id));
  };

  return {
    /** The user asked to draft for this remote workspace; its definitions are drafts for the next hour. */
    request(origin: string): void {
      requested.set(origin, d.now() + REMOTE_DRAFT_REQUEST_MS);
    },

    /**
     * null: the definition names no requested remote workspace, so the local
     * proposal path applies. Throws when it does but isn't valid for that host.
     */
    take(rawDefinition: unknown, rationale: unknown, kind: RemoteDraft['kind']): RemoteDraft | null {
      const targets = live();
      if (!targets.length) return null;
      const parsed = typeof rawDefinition === 'string' ? parseDefinitionText(rawDefinition) : { ok: true as const, value: rawDefinition };
      if (!parsed.ok) return null;
      const refs = workspaceRefs(parsed.value);
      const named = targets.filter((s) => refs.some((r) => r === s.id || r === s.name));
      if (named.length > 1) throw new Error('a draft for a remote host may name only that host\'s workspace');
      const target = named[0] ?? (targets.length === 1 && refs.includes('$self') ? targets[0] : null);
      if (!target) return null;
      const v = validateDefinition(substituteSelf(parsed.value, target.id), {
        workspace: (x) => (x === target.id || x === target.name ? target.id : null),
        check: remoteHostRefusals
      });
      if (!v.ok) throw new Error(`definition (for ${target.name}'s host config): ${v.errors.join('; ')}`);
      const draft: RemoteDraft = {
        id: d.newId(), origin: target.id, workspaceName: target.name, kind, name: v.value.name,
        rationale: typeof rationale === 'string' && rationale.trim() ? oneLine(rationale, 500) : null,
        definition: v.value as AutomationDef, createdAt: d.now()
      };
      drafts = [draft, ...drafts.filter((x) => !(x.origin === draft.origin && x.name === draft.name))].slice(0, MAX_REMOTE_DRAFTS);
      d.changed();
      return draft;
    },

    list(): RemoteDraft[] {
      const bookmarked = new Set(d.sources().map((s) => s.id));
      drafts = drafts.filter((x) => bookmarked.has(x.origin));
      return drafts.map((x) => structuredClone(x));
    },

    dismiss(id: string): void {
      const n = drafts.length;
      drafts = drafts.filter((x) => x.id !== id);
      if (drafts.length !== n) d.changed();
    }
  };
}

export type RemoteDrafts = ReturnType<typeof createRemoteDrafts>;

/** Only the local automations workspace drafts for a remote host, one definition at a time; null: the local proposal path applies. */
export function remoteDraftFor(drafts: Pick<RemoteDrafts, 'take'>, callerId: string, roleWs: string | null, args: Record<string, unknown>, kind: RemoteDraft['kind']) {
  if (!roleWs || callerId !== roleWs || args.batch !== undefined) return null;
  const r = drafts.take(args.definition, args.rationale, kind);
  return r ? remoteDraftReply(r) : null;
}

/** What the drafting session reads back from propose_automation. */
export const remoteDraftReply = (r: RemoteDraft) => ({
  id: r.id,
  status: 'draft',
  note: `Shown to the user as an entry for ${r.workspaceName}'s host config; it lands through a platform-ops PR. Nothing was created and nothing was sent to the host.`
});

export interface RemoteDraftRequestDeps {
  /** Read-tier host reads only. */
  reader: Pick<FederatedReader, 'one' | 'sources'>;
  drafts: Pick<RemoteDrafts, 'request'>;
  /** Posts the prompt to the local automations workspace; resolves to its id. */
  post(prompt: string): Promise<string>;
}

/** Starts a local drafting session for a remote workspace, with the host's list and (for a change) the definition as context. */
export async function requestRemoteDraft(d: RemoteDraftRequestDeps, origin: string, text: string, automationId: string | null): Promise<string> {
  const src = d.reader.sources().find((s) => s.id === origin);
  if (!src) throw new Error('that remote workspace is no longer bookmarked');
  const list = await d.reader.one(origin, 'automations:list', [], (v, s) => parseAutomationRows(v, s.id).map((a) => a.name));
  let current: { name: string; yaml: string } | undefined;
  if (automationId) {
    const r = await d.reader.one(origin, 'automations:get', [automationId], (v, s) => parseAutomationDetail(v, s.id));
    if (!r?.ok || !r.value) throw new Error(`couldn't read that automation from ${src.name}; try again when it's reachable`);
    current = { name: r.value.automation.name, yaml: definitionToYaml(r.value.automation.definition) };
  }
  d.drafts.request(origin);
  return d.post(remoteDraftPrompt({ workspace: { id: src.id, name: src.name }, request: text, hostAutomations: list?.ok ? list.value : null, current }));
}
