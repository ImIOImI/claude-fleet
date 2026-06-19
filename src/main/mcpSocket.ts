// The host path of the read-only MCP server's Unix socket (#12). Pure (no
// electron / native deps) so both the server (`mcpServer.ts`) and the
// container bind in `docker.ts` can import it without dragging better-sqlite3
// into docker.ts's vitest-loadable module graph.

import { join } from 'node:path';

/** `<userData>/mcp.sock` — the socket the MCP server listens on and that each
 *  container binds at `/fleet/mcp.sock`. */
export function mcpSocketPath(userDataDir: string): string {
  return join(userDataDir, 'mcp.sock');
}

/** In-container mount point for the socket above. */
export const CONTAINER_MCP_SOCKET = '/fleet/mcp.sock';
