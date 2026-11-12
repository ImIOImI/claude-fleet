// Remote proposals are config drafts (D126): sessions propose, nothing applies
// them; a draft counts as applied once the host config holds it.
import type { AutomationRecord, AutomationStore } from '../main/automations/automationStore.js';
import { definitionToYaml, parseDefinitionText } from '../main/automations/definition.js';
import { statusOf } from '../main/automations/proposalService.js';
import type { ProposalStore } from '../main/automations/proposalStore.js';
import { substituteSelf } from './hostDefinition.js';

export const MAX_PENDING_HOST_PROPOSALS = 20;
export const CONFIG_APPLIED_NOTE = 'applied from the host config';

/** YAML text or an object, with `$self` bound to the hosted workspace; an unparseable text is returned for the validator to report. */
export function selfDefinition(raw: unknown, hostedId: string): unknown {
  if (typeof raw === 'string') {
    const p = parseDefinitionText(raw);
    return p.ok ? substituteSelf(p.value, hostedId) : raw;
  }
  return substituteSelf(raw, hostedId);
}

export async function assertPendingRoom(proposals: ProposalStore): Promise<void> {
  if ((await proposals.pending()).length >= MAX_PENDING_HOST_PROPOSALS) {
    throw new Error(`this host already holds ${MAX_PENDING_HOST_PROPOSALS} pending automation drafts; ask its operators to review them`);
  }
}

/** Pending items whose definition the config now holds become accepted. Returns how many proposals changed. */
export async function markConfigApplied(o: {
  proposals: ProposalStore; automations: AutomationStore; now(): number; isConfig(a: AutomationRecord): boolean;
}): Promise<number> {
  let changed = 0;
  for (const p of await o.proposals.pending()) {
    if (p.kind === 'capture-settings') continue;
    let touched = false;
    for (const it of p.items) {
      if (it.decision !== 'pending') continue;
      const rec = await o.automations.byName(it.after.name);
      if (!rec || !o.isConfig(rec) || definitionToYaml(rec.definition) !== definitionToYaml(it.after)) continue;
      it.decision = 'accepted';
      it.automationId = rec.id;
      touched = true;
    }
    if (!touched) continue;
    p.status = statusOf(p.items);
    if (p.status !== 'pending') {
      p.decidedAt = o.now();
      p.note = CONFIG_APPLIED_NOTE;
    }
    await o.proposals.save(p);
    changed++;
  }
  return changed;
}
