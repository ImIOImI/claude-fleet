// Knowledge claims (#483): shared types for the claims store/service.
export const CLAIM_KINDS = ['decision', 'fact', 'gotcha', 'root-cause', 'rejected'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type ClaimVisibility = 'fleet' | 'private';
export type ClaimStatus = 'current' | 'superseded' | 'retracted';
export const CLAIM_TEXT_MAX = 600;
export const TOPIC_RE = /^[a-z0-9-]{2,40}$/;
export const DEDUPE_COSINE = 0.92;

export interface ClaimInput {
  text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; supersedes: string | null; captureRun: string | null;
}
export interface ClaimRecord {
  id: string; text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; status: ClaimStatus; supersededBy: string | null; retractReason: string | null;
  workspaceId: string; confirmations: number; createdAt: number; updatedAt: number;
}
export interface ClaimSourceInput {
  workspaceId: string; sessionId: string | null; via: 'agent' | 'capture'; captureRun: string | null;
}
