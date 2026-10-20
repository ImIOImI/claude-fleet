// Proposals (#407 Phase 5): workspaces propose new automations or changes;
// the user approves. Trusted workspaces auto-apply only low-risk items (see
// classify.ts); every auto-applied item stays visible with Revert. Pure.
import type { AutomationDef, Proposal, ProposalItem, ProposalStatus, TodoSource } from '../../preload/inboxTypes.js';
import type { NotifyInput } from '../inbox/notifyService.js';
import type { AutomationStore } from './automationStore.js';
import type { ProposalStore } from './proposalStore.js';
import { classifyChange, riskFlags } from './classify.js';
import { definitionToYaml, parseDefinitionText, validateDefinition } from './definition.js';

export interface ProposalDeps {
  proposals: ProposalStore;
  automations: AutomationStore;
  now(): number;
  resolveWorkspace(idOrName: string): string | null;
  workspaceName(id: string): string;
  /** Trusted for low-risk edits: manifest inbox.trusted, container workspaces only. */
  trusted(workspaceId: string): Promise<boolean>;
  notify?: (n: NotifyInput) => unknown;
  changed(): void;
}

const MAX_BATCH = 20;

function statusOf(items: ProposalItem[]): ProposalStatus {
  if (items.some((i) => i.decision === 'pending')) return 'pending';
  if (items.every((i) => i.decision === 'declined')) return 'rejected';
  if (items.every((i) => i.decision === 'auto-applied' || i.decision === 'reverted')) return 'auto-approved';
  if (items.every((i) => i.decision === 'accepted' || i.decision === 'auto-applied' || i.decision === 'reverted')) return 'approved';
  return 'partial';
}

export function createProposalService(deps: ProposalDeps) {
  const ctx = { workspace: (v: string) => deps.resolveWorkspace(v) };

  function parseDef(raw: unknown, where: string): AutomationDef {
    const parsed = typeof raw === 'string' ? parseDefinitionText(raw) : { ok: true as const, value: raw };
    if (!parsed.ok) throw new Error(`${where}: ${parsed.errors.join('; ')}`);
    const v = validateDefinition(parsed.value, ctx);
    if (!v.ok) throw new Error(`${where}: ${v.errors.join('; ')}`);
    return v.value;
  }

  function item(before: { id: string; version: number; definition: AutomationDef } | null, after: AutomationDef): ProposalItem {
    const c = classifyChange(before?.definition ?? null, after, deps.workspaceName);
    return {
      automationId: before?.id ?? null, name: after.name, baseVersion: before?.version ?? null,
      before: before?.definition ?? null, after, lowRisk: c.lowRisk, reasons: c.reasons,
      flags: riskFlags(after, deps.workspaceName), decision: 'pending'
    };
  }

  function apply(it: ProposalItem, by: TodoSource): void {
    const now = deps.now();
    if (!it.automationId) {
      const a = deps.automations.create(it.after, by, now);
      it.automationId = a.id;
      return;
    }
    const cur = deps.automations.get(it.automationId);
    if (!cur) throw new Error(`${it.name} no longer exists`);
    if (cur.version !== it.baseVersion) throw new Error(`${it.name} changed since this was proposed (now v${cur.version}); ask for a fresh proposal`);
    deps.automations.update(cur.id, it.after, by, now);
  }

  /** Mark older pending proposals from the same workspace for the same automations as superseded. */
  function supersede(proposer: string, names: Set<string>): void {
    for (const p of deps.proposals.pending()) {
      if (p.proposer.id !== proposer) continue;
      if (!p.items.some((i) => names.has(i.name) || (i.automationId && names.has(i.automationId)))) continue;
      p.status = 'superseded';
      p.decidedAt = deps.now();
      deps.proposals.save(p);
    }
  }

  async function record(callerId: string, kind: Proposal['kind'], items: ProposalItem[], rationale: unknown): Promise<Proposal> {
    const by: TodoSource = { kind: 'workspace', id: callerId };
    supersede(callerId, new Set(items.flatMap((i) => [i.name, ...(i.automationId ? [i.automationId] : [])])));
    const trusted = await deps.trusted(callerId);
    const auto: string[] = [];
    if (trusted) {
      for (const it of items) {
        if (!it.lowRisk || !it.automationId) continue;
        try {
          apply(it, by);
          it.decision = 'auto-applied';
          auto.push(it.name);
        } catch {
          // leave it pending for the user
        }
      }
    }
    const p = deps.proposals.create({
      kind, proposer: by, rationale: typeof rationale === 'string' && rationale.trim() ? rationale.trim().slice(0, 2000) : null,
      status: statusOf(items), items, createdAt: deps.now()
    }, deps.now());
    const who = deps.workspaceName(callerId);
    const waiting = items.filter((i) => i.decision === 'pending');
    if (waiting.length) {
      deps.notify?.({
        kind: 'proposal', title: kind === 'new' ? `${who} proposes a new automation: ${items[0].name}` : `${who} proposes ${waiting.length === 1 ? `a change to ${waiting[0].name}` : `${waiting.length} automation changes`}`,
        body: waiting.flatMap((i) => i.reasons).slice(0, 3).join(' · ') || null, priority: 'normal',
        source: by, workspaceId: callerId, dedupeKey: `proposal:${p.id}`
      });
    } else if (auto.length) {
      deps.notify?.({ kind: 'proposal', title: `Auto-applied from ${who}: ${auto.join(', ')}`, body: 'Low-risk edits from a trusted workspace. Revert from Activity.', priority: 'low', source: by, workspaceId: callerId });
    }
    deps.changed();
    return p;
  }

  function summary(p: Proposal) {
    return {
      id: p.id, status: p.status, note: p.note,
      items: p.items.map((i) => ({ name: i.name, automationId: i.automationId, decision: i.decision, lowRisk: i.lowRisk, reasons: i.reasons }))
    };
  }

  return {
    mcp: {
      async propose(callerId: string, args: Record<string, unknown>) {
        const def = parseDef(args.definition, 'definition');
        if (deps.automations.byName(def.name)) throw new Error(`an automation named "${def.name}" already exists; propose a change to it instead`);
        return summary(await record(callerId, 'new', [item(null, def)], args.rationale));
      },
      async proposeChange(callerId: string, args: Record<string, unknown>) {
        const raw = Array.isArray(args.batch) ? (args.batch as Array<Record<string, unknown>>) : [{ id: args.id, definition: args.definition }];
        if (raw.length === 0 || raw.length > MAX_BATCH) throw new Error(`a change proposal needs 1–${MAX_BATCH} items`);
        const items = raw.map((r, i) => {
          const where = raw.length > 1 ? `batch[${i}]` : 'definition';
          const key = typeof r.id === 'string' ? r.id : '';
          const cur = deps.automations.get(key) ?? deps.automations.byName(key);
          if (!cur) throw new Error(`${where}: automation ${key || '(missing id)'} not found`);
          return item({ id: cur.id, version: cur.version, definition: cur.definition }, parseDef(r.definition, where));
        });
        return summary(await record(callerId, raw.length > 1 ? 'batch' : 'change', items, args.rationale));
      },
      async get(callerId: string, args: Record<string, unknown>) {
        const p = typeof args.id === 'string' ? deps.proposals.get(args.id) : null;
        if (!p || p.proposer.id !== callerId) throw new Error('proposal not found');
        return summary(p);
      }
    },

    list(): Proposal[] {
      return deps.proposals.list();
    },
    pendingCount(): number {
      return deps.proposals.pending().reduce((n, p) => n + p.items.filter((i) => i.decision === 'pending').length, 0);
    },
    yamlOf(id: string, index: number): string | null {
      const it = deps.proposals.get(id)?.items[index];
      return it ? definitionToYaml(it.after) : null;
    },

    /** Approve pending items (all, or the listed indexes; the rest are declined). editedYaml replaces a single item's definition first. */
    approve(id: string, opts: { accept?: number[]; editedYaml?: string; editedIndex?: number } = {}): Proposal {
      const p = deps.proposals.get(id);
      if (!p) throw new Error('proposal not found');
      if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
      if (opts.editedYaml !== undefined) {
        const idx = opts.editedIndex ?? 0;
        const it = p.items[idx];
        if (!it) throw new Error('no such item');
        it.after = parseDef(opts.editedYaml, 'edited definition');
        it.name = it.after.name;
        it.flags = riskFlags(it.after, deps.workspaceName);
      }
      const accept = new Set(opts.accept ?? p.items.map((_, i) => i));
      const by = p.proposer;
      const errors: string[] = [];
      p.items.forEach((it, i) => {
        if (it.decision !== 'pending') return;
        if (!accept.has(i)) { it.decision = 'declined'; return; }
        try {
          apply(it, by);
          it.decision = 'accepted';
        } catch (e) {
          errors.push((e as Error).message);
        }
      });
      if (errors.length) {
        deps.proposals.save(p);
        deps.changed();
        throw new Error(errors.join('\n'));
      }
      p.status = statusOf(p.items);
      p.decidedAt = deps.now();
      deps.proposals.save(p);
      deps.changed();
      return p;
    },

    reject(id: string, note: string | null): Proposal {
      const p = deps.proposals.get(id);
      if (!p) throw new Error('proposal not found');
      if (p.status !== 'pending') throw new Error(`this proposal is already ${p.status}`);
      for (const it of p.items) if (it.decision === 'pending') it.decision = 'declined';
      p.status = statusOf(p.items);
      p.note = note?.trim() ? note.trim().slice(0, 2000) : null;
      p.decidedAt = deps.now();
      deps.proposals.save(p);
      deps.changed();
      return p;
    },

    /** Restore the definition an applied change replaced (as a new version, by the user). */
    revert(id: string, index: number): Proposal {
      const p = deps.proposals.get(id);
      const it = p?.items[index];
      if (!p || !it) throw new Error('no such item');
      if ((it.decision !== 'auto-applied' && it.decision !== 'accepted') || !it.before || !it.automationId) throw new Error('only an applied change can be reverted');
      const cur = deps.automations.get(it.automationId);
      if (!cur) throw new Error(`${it.name} no longer exists`);
      deps.automations.update(cur.id, it.before, { kind: 'user', id: null }, deps.now());
      it.decision = 'reverted';
      deps.proposals.save(p);
      deps.changed();
      return p;
    }
  };
}

export type ProposalService = ReturnType<typeof createProposalService>;
