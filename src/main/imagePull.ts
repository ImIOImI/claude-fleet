// Pure helpers for image pulling — deliberately free of electron, dockerode,
// network and filesystem side effects so they unit-test in isolation (see
// imagePull.test.ts). The dockerode-wired orchestration (ensureImage, resume
// refresh) lives in docker.ts and calls into these.

/**
 * Interpret one line of a `docker pull` progress stream.
 *
 * The daemon reports a pull failure (auth denial, `manifest unknown`, a
 * rate-limit mid-layer) as an ordinary JSON progress line carrying an `error`
 * / `errorDetail` field, then ends the stream *cleanly*. `docker-modem`'s
 * `followProgress` only rejects on a socket-level `error` event, so without
 * this check a failed pull looks identical to a successful one — the promise
 * resolves and the caller silently keeps (or recreates against) a stale image.
 *
 * Returns the human-readable error message if this event represents a pull
 * failure, else null.
 */
export function pullErrorFromEvent(event: Record<string, unknown>): string | null {
  if (typeof event.error === 'string') return event.error;
  const detail = event.errorDetail;
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return null;
}

/**
 * Decide whether a resumed container is running a stale image and must be
 * recreated. Compares the image id baked into the existing container against
 * the id the ref currently resolves to locally (after a fresh pull).
 *
 * Fail safe: if either id is unknown we return false (plain start) rather than
 * destroy a container on incomplete information.
 */
export function needsRecreateForImage(
  containerImageId: string | undefined,
  localImageId: string | undefined
): boolean {
  if (!containerImageId || !localImageId) return false;
  return containerImageId !== localImageId;
}

/**
 * Policy gate for the resume-time image refresh: which workspaces may be
 * auto-pulled and recreated when their image has moved on.
 *
 * Scoped to **stopped** container workspaces only. Running containers aren't
 * force-recreated under a live session, and paused ones hold suspended expert
 * sessions that a recreate would destroy — those refresh only via the explicit
 * edit → restart-to-apply banner. Local workspaces have no image.
 */
export function shouldCheckResumeImage(kind: string, state: string | undefined): boolean {
  if (kind !== 'container') return false;
  return state === 'exited' || state === 'created';
}
