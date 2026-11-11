// Remote automations (remote-workspaces (g)): types and constants shared by
// fleet-host, main and the renderer. Pure.

/** A lowercase UUID v4: one per user intent; a retry reuses it (D128). */
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every host action channel's reply. result null and error null on a replay: the first attempt is in flight or was interrupted. */
export interface HostActionReply {
  replayed: boolean;
  result: unknown;
  error: string | null;
}
