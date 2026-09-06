// The workspace-backend contract. Both the Docker backend (`docker.ts`) and
// the mock backend (`mock.ts`) already implement this surface, and the local
// host-process backend (`local.ts`, #16) implements it too. `ipc.ts` dispatches
// each operation to the right backend per-workspace by `kind` (see
// `resolveKind`/`backendFor` there) instead of choosing one backend globally.
//
// Type-only module: it just names the shared shape, importing the concrete
// payload/result types from `docker.ts` (the original home of these types) so
// there's a single source of truth and no duplication.

import type { Workspace } from './workspaces.js';
import type {
  CreateWorkspaceInput,
  ImageInspectResult,
  PullProgress,
  RemoveWorkspaceOpts,
  PtyHandle
} from './docker.js';

export interface Backend {
  /** Backend reachable? (Docker daemon up / `claude` on PATH.) */
  ping(): Promise<boolean>;
  /** Ensure the runtime is present — pull `imageRef` (default: the base
   *  runner), streaming progress; no-op for local. */
  ensureImage(onProgress: (p: PullProgress) => void, imageRef?: string): Promise<void>;
  /** Live workspaces this backend owns, with their current state. */
  listLiveWorkspaces(): Promise<Workspace[]>;
  createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace>;
  inspectImage(ref: string): Promise<ImageInspectResult>;
  /** Bring an existing workspace up; returns its containerId surrogate or null. */
  startWorkspace(id: string): Promise<string | null>;
  /**
   * Resume-time image refresh: pull `imageRef` and report whether a **stopped**
   * container is now running a stale image and should be recreated to pick up
   * the newer one. False for live/paused containers and for backends with no
   * image (local). Streams pull progress. See docker.ts `isResumeImageStale`.
   */
  isResumeImageStale(
    id: string,
    imageRef: string | undefined,
    onProgress: (p: PullProgress) => void
  ): Promise<boolean>;
  pauseWorkspace(containerId: string): Promise<void>;
  stopWorkspace(containerId: string): Promise<void>;
  removeWorkspace(containerId: string, opts?: RemoveWorkspaceOpts): Promise<void>;
  attachPty(
    containerId: string,
    sessionId: string,
    cols: number,
    rows: number,
    resumeOf?: string
  ): Promise<PtyHandle>;
  getBrokerLogs(containerId: string, tailLines?: number): Promise<string>;
  /**
   * Inject a line of input into the workspace's single live session, as if a
   * human typed it (committee `post`, #120). Resolves the live broker session,
   * does a transient ATTACH on a dedicated channel, sends `text` + CR, then
   * DETACHes — so it never holds the one-writer slot beyond the keystroke.
   * Throws on zero (`not attached yet`) or multiple (`single-tab only`) live
   * sessions. Container-only; the local backend throws. Returns the resolved
   * broker session id.
   */
  committeePost(workspaceId: string, text: string): Promise<{ brokerSessionId: string }>;
}
