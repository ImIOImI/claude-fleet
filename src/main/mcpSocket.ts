// The host path of the read-only MCP server's Unix socket (#12). Pure (no
// electron / native deps) so both the server (`mcpServer.ts`) and the
// container bind in `docker.ts` can import it without dragging better-sqlite3
// into docker.ts's vitest-loadable module graph.

import { join } from 'node:path';

/** `<userData>/mcp/` — the directory the socket lives in. We bind-mount the
 *  **directory** (not the socket file) into each container, mirroring the
 *  broker. A single-file bind pins the socket's inode at container-create
 *  time; but the server `unlink`s + recreates the socket (new inode) on every
 *  app restart, so a surviving (paused) container would be stuck pointing at
 *  the dead inode. Mounting the dir lets the container resolve the socket path
 *  fresh and see whatever socket currently lives there. (#18) */
export function mcpSocketDir(userDataDir: string): string {
  return join(userDataDir, 'mcp');
}

/** `<userData>/mcp/mcp.sock` — the socket the MCP server listens on and that
 *  each container reaches at `/fleet/mcp/mcp.sock`. */
export function mcpSocketPath(userDataDir: string): string {
  return join(mcpSocketDir(userDataDir), 'mcp.sock');
}

/** In-container mount point for the directory above. */
export const CONTAINER_MCP_DIR = '/fleet/mcp';

/** In-container path of the socket (inside the bound directory). */
export const CONTAINER_MCP_SOCKET = '/fleet/mcp/mcp.sock';
