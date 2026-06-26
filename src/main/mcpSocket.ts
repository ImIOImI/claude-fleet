// Host paths of the read-only MCP server's Unix sockets (#12, #117). Pure (no
// electron / native deps) so both the server (`mcpServer.ts`) and the container
// bind in `docker.ts` can import it without dragging better-sqlite3 into
// docker.ts's vitest-loadable module graph.

import { join } from 'node:path';

/** `<userData>/mcp/` — the parent directory holding every workspace's socket
 *  dir (and the local-workspace bridge script). **Never bind-mounted into a
 *  container** — only a workspace's own per-id leaf dir is (see
 *  `mcpWorkspaceSocketDir`). Binding this parent would expose every sibling's
 *  socket and destroy the per-workspace caller identity the whole committee
 *  feature rests on (#116/#117). */
export function mcpSocketDir(userDataDir: string): string {
  return join(userDataDir, 'mcp');
}

/** `<userData>/mcp/<id>/` — the per-workspace socket directory. We bind-mount
 *  this **leaf** dir (not the parent, not the socket file) into **only that
 *  container** at `/fleet/mcp`, mirroring the per-workspace broker dir. Two
 *  guarantees ride on this being the leaf:
 *   - **Caller identity:** the MCP server runs one listener per workspace at
 *     `<id>/mcp.sock`, so the host derives an unspoofable caller id from *which
 *     listener accepted the connection* — nothing on the wire to forge (#117).
 *   - **Isolation:** a container's mount namespace contains only its own
 *     `<id>/mcp.sock`; it cannot see a sibling's socket. Binding the parent
 *     `<userData>/mcp/` would break both at once.
 *  Binding the *directory* (not the socket file) also lets a socket the server
 *  recreates with a new inode on app restart stay visible at the same container
 *  path, so a paused container's MCP survives an app restart (#18). */
export function mcpWorkspaceSocketDir(userDataDir: string, id: string): string {
  return join(mcpSocketDir(userDataDir), id);
}

/** `<userData>/mcp/<id>/mcp.sock` — the socket the per-workspace MCP listener
 *  binds, reachable inside that one container at `/fleet/mcp/mcp.sock`. */
export function mcpWorkspaceSocketPath(userDataDir: string, id: string): string {
  return join(mcpWorkspaceSocketDir(userDataDir, id), 'mcp.sock');
}

/** `<userData>/mcp/<id>/token` — the per-workspace MCP auth token (Windows
 *  only). A Windows host can't `listen()` on a unix socket, so the MCP server
 *  there runs one loopback-TCP listener for all workspaces; caller identity can
 *  no longer come from *which* per-workspace socket accepted (#117). Instead
 *  each workspace gets a random token, written here and bind-mounted leaf-only
 *  into that one container (so a container only ever sees its own). The
 *  in-container bridge sends it as the first line; the host maps token→id. This
 *  file lives in the SAME per-id leaf dir the socket used, so the existing
 *  bind-mount isolation carries the secrecy. */
export function mcpWorkspaceTokenPath(userDataDir: string, id: string): string {
  return join(mcpWorkspaceSocketDir(userDataDir, id), 'token');
}

/** The Docker bind string for a workspace's MCP socket dir: the per-id **leaf**
 *  dir → `/fleet/mcp` (`:rw` because connecting to a Unix socket needs write
 *  access; the read-only guarantee is the DB connection, not the mount). This
 *  is the single chokepoint that must always name the leaf and never the parent
 *  — `mcpSocket.test.ts` pins that invariant as the load-bearing isolation gate
 *  (#117). */
export function mcpWorkspaceBind(userDataDir: string, id: string): string {
  return `${mcpWorkspaceSocketDir(userDataDir, id)}:${CONTAINER_MCP_DIR}:rw`;
}

/** In-container mount point for a workspace's own socket dir. */
export const CONTAINER_MCP_DIR = '/fleet/mcp';

/** In-container path of the socket (inside the bound directory). Identical
 *  across workspaces — only the *host* side of the bind differs per workspace,
 *  so the in-container socat bridge command never changes. */
export const CONTAINER_MCP_SOCKET = '/fleet/mcp/mcp.sock';

/** In-container path of the per-workspace MCP token (Windows transport). Lives
 *  in the same bound `/fleet/mcp` dir as the socket would; the bridge reads it
 *  and sends it as the first line to authenticate over loopback TCP. */
export const CONTAINER_MCP_TOKEN = '/fleet/mcp/token';

/** Fixed loopback-TCP port the Windows MCP server listens on (127.0.0.1) and
 *  the in-container bridge dials via host.docker.internal. Fixed (not
 *  ephemeral) because the bridge command is baked into ~/.claude.json at
 *  create-time and a paused container must keep reconnecting to the same port
 *  across host/app restarts. Override with CLAUDE_FLEET_MCP_TCP_PORT. */
export const MCP_TCP_PORT = Number(process.env.CLAUDE_FLEET_MCP_TCP_PORT) || 7071;
