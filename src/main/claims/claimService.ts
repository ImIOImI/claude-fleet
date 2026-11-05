// Knowledge claims (#483): record / search / retract. Provenance is
// host-stamped: workspace from the MCP caller, session only via a validated
// capture_run token (spec §2, §3, §7).
import { newId } from '../inbox/inboxDb.js';
import type { EmbedFn } from '../transcriptIndex.js';
import { decodeVector, dot, encodeVector, EMBED_MODEL_ID } from '../vectors.js';
import type { CaptureRunStore } from './captureRunStore.js';
import type { ClaimStore } from './claimStore.js';
import { ftsQuery, rrf, suggestTopics } from './claimRank.js';
import { findSecret, validateClaimInput } from './claimValidate.js';
import { CLAIM_KINDS, DEDUPE_COSINE, type ClaimRecord, type ClaimSourceInput } from './types.js';

export interface ClaimServiceDeps {
  claims: ClaimStore; runs: CaptureRunStore; embed: EmbedFn | null;
  workspaceName: (id: string) => Promise<string | null>; now?: () => number;
}
export interface ClaimSearchResult extends ClaimRecord {
  workspaceName: string | null;
  sources: Array<{ workspaceId: string; sessionId: string | null; via: string; ts: number }>;
}

export class ClaimService {
  private readonly now: () => number;
  constructor(private readonly d: ClaimServiceDeps) { this.now = d.now ?? Date.now; }

  private async embedOne(text: string): Promise<Float32Array | null> {
    if (!this.d.embed) return null;
    try { return (await this.d.embed([text]))[0] ?? null; } catch { return null; }
  }

  async record(callerId: string, args: Record<string, unknown>): Promise<{ id: string; deduped: boolean; suggestedTopics: string[] }> {
    const input = validateClaimInput(args);
    const secret = findSecret([input.text, ...input.refs].join('\n'));
    if (secret) throw new Error(`claim rejected: it looks like it contains a secret (${secret}); remove it and retry`);
    let source: ClaimSourceInput = { workspaceId: callerId, sessionId: null, via: 'agent', captureRun: null };
    if (input.captureRun) {
      const run = await this.d.runs.runningFor(input.captureRun, callerId);
      if (!run) throw new Error('capture_run is not an active capture run for this workspace');
      source = { workspaceId: callerId, sessionId: run.session_id, via: 'capture', captureRun: run.id };
      // The fork is only *asked* to use private visibility; enforce it here
      // from the workspace's effective captureVisibility stored at admit.
      if (run.visibility === 'private') input.visibility = 'private';
    }
    const vec = await this.embedOne(input.text);
    const visible = await this.d.claims.visible(callerId, EMBED_MODEL_ID, false);
    if (input.supersedes) {
      const target = visible.find((v) => v.claim.id === input.supersedes)?.claim;
      if (!target) throw new Error('supersedes must name a current claim you can see');
      // A supersede hides the target from search, so a private replacement
      // would hide a fleet claim from every other workspace.
      if (target.visibility === 'fleet' && input.visibility !== 'fleet') {
        throw new Error('a fleet claim can only be superseded by a fleet claim (visibility "fleet")');
      }
    }
    const scored = vec
      ? visible.filter((v) => v.vec).map((v) => ({ v, score: dot(vec, decodeVector(v.vec as Buffer)) })).sort((a, b) => b.score - a.score)
      : [];
    const suggested = suggestTopics(scored.slice(0, 5).map((s) => s.v.claim), input.topics);
    const now = this.now();
    // Merge only within the same visibility: a private record must never add a
    // source to (or confirm) a fleet claim, nor a fleet record vanish into a
    // private one.
    const dup = input.supersedes ? undefined : scored.find((s) =>
      s.score >= DEDUPE_COSINE && s.v.claim.kind === input.kind && s.v.claim.visibility === input.visibility);
    if (dup) {
      await this.d.claims.confirm(dup.v.claim.id, source, now);
      if (source.captureRun) await this.d.runs.incrementClaims(source.captureRun);
      return { id: dup.v.claim.id, deduped: true, suggestedTopics: suggested };
    }
    const id = newId(now);
    await this.d.claims.insert(
      { id, text: input.text, kind: input.kind, topics: input.topics, refs: input.refs, visibility: input.visibility, workspaceId: callerId, now },
      vec ? encodeVector(vec) : null, EMBED_MODEL_ID, source, { supersedes: input.supersedes }
    );
    if (source.captureRun) await this.d.runs.incrementClaims(source.captureRun);
    return { id, deduped: false, suggestedTopics: suggested };
  }

  async search(callerId: string, args: Record<string, unknown>): Promise<{ results: ClaimSearchResult[] }> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
    const includeInactive = args.include_superseded === true;
    const kind = typeof args.kind === 'string' && (CLAIM_KINDS as readonly string[]).includes(args.kind) ? args.kind : null;
    const topics = Array.isArray(args.topics) ? args.topics.map((t) => String(t).toLowerCase()) : [];
    const pool = (await this.d.claims.visible(callerId, EMBED_MODEL_ID, includeInactive))
      .filter((v) => (!kind || v.claim.kind === kind) && (topics.length === 0 || v.claim.topics.some((t) => topics.includes(t))));
    const allowed = new Set(pool.map((v) => v.claim.id));
    const qvec = await this.embedOne(query);
    const vecIds = qvec
      ? pool.filter((v) => v.vec).map((v) => ({ id: v.claim.id, s: dot(qvec, decodeVector(v.vec as Buffer)) }))
          .sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.id)
      : [];
    const match = ftsQuery(query);
    const ftsIds = match ? (await this.d.claims.ftsIds(callerId, match, 50, includeInactive)).filter((id) => allowed.has(id)) : [];
    const ids = rrf([vecIds, ftsIds]).slice(0, limit);
    const byId = new Map(pool.map((v) => [v.claim.id, v.claim]));
    const srcs = await this.d.claims.sources(ids);
    const names = new Map<string, string | null>();
    const results: ClaimSearchResult[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (!names.has(c.workspaceId)) names.set(c.workspaceId, await this.d.workspaceName(c.workspaceId));
      results.push({
        ...c, workspaceName: names.get(c.workspaceId) ?? null,
        sources: (srcs.get(id) ?? []).map((s) => ({ workspaceId: s.workspace_id, sessionId: s.session_id, via: s.via, ts: s.ts }))
      });
    }
    return { results };
  }

  async retract(callerId: string, args: Record<string, unknown>): Promise<{ id: string; status: 'retracted' }> {
    const id = typeof args.id === 'string' ? args.id : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
    if (!id || !reason) throw new Error('id and reason are required');
    const c = await this.d.claims.get(id);
    if (!c || c.workspaceId !== callerId) throw new Error('only the authoring workspace can retract a claim');
    await this.d.claims.retract(id, reason, this.now());
    return { id, status: 'retracted' };
  }

  /** Fill vectors for claims recorded while the embedder was unavailable. */
  async backfillVectors(): Promise<number> {
    if (!this.d.embed) return 0;
    let n = 0;
    for (const m of await this.d.claims.missingVectors(EMBED_MODEL_ID, 200)) {
      const v = await this.embedOne(m.text);
      if (!v) break;
      await this.d.claims.setVector(m.id, EMBED_MODEL_ID, encodeVector(v)); n++;
    }
    return n;
  }
}
