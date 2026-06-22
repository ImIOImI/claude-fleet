// The load-bearing isolation gate for cross-workspace committee control
// (#117). Per-workspace MCP caller identity rests on one fact: each container
// is bound ONLY its own per-id socket leaf dir — never the shared parent
// `<userData>/mcp/`. If that ever regresses to binding the parent, every
// container can see every sibling's socket, the host can no longer derive an
// unspoofable caller id, and the entire permission model (#118+) is hollow.
//
// We can't spin two real containers in a unit test, so we pin the property at
// its single chokepoint: the pure path/bind helpers in mcpSocket.ts that
// docker.ts uses to construct the mount. These are pure (no electron / native
// deps), so the test needs no mocking.

import { describe, expect, it } from 'vitest';
import {
  mcpSocketDir,
  mcpWorkspaceSocketDir,
  mcpWorkspaceSocketPath,
  mcpWorkspaceBind,
  CONTAINER_MCP_DIR,
  CONTAINER_MCP_SOCKET
} from './mcpSocket.js';

const USER_DATA = '/home/u/.config/claude-fleet';
const A = '01WORKSPACEAAAAAAAAAAAAAAA';
const B = '01WORKSPACEBBBBBBBBBBBBBBB';

describe('per-workspace MCP socket paths (#117)', () => {
  it('puts each workspace socket under its own id-named leaf dir', () => {
    expect(mcpWorkspaceSocketDir(USER_DATA, A)).toBe(`${USER_DATA}/mcp/${A}`);
    expect(mcpWorkspaceSocketPath(USER_DATA, A)).toBe(`${USER_DATA}/mcp/${A}/mcp.sock`);
    // The leaf is the id — that's the host's identity discriminator.
    expect(mcpWorkspaceSocketDir(USER_DATA, A).endsWith(`/${A}`)).toBe(true);
  });

  it('binds the per-id LEAF dir, never the shared parent', () => {
    const parent = mcpSocketDir(USER_DATA); // <userData>/mcp
    const bind = mcpWorkspaceBind(USER_DATA, A);
    const [host, container, mode] = bind.split(':');

    // Container path is identical for every workspace — only the host side
    // differs — so the in-container socat command never has to change.
    expect(container).toBe(CONTAINER_MCP_DIR);
    expect(CONTAINER_MCP_SOCKET).toBe(`${CONTAINER_MCP_DIR}/mcp.sock`);
    expect(mode).toBe('rw');

    // The load-bearing assertion: the bound host dir is the per-id leaf, and is
    // strictly BELOW the shared parent — it must never equal it.
    expect(host).toBe(mcpWorkspaceSocketDir(USER_DATA, A));
    expect(host).not.toBe(parent);
    expect(host.startsWith(`${parent}/`)).toBe(true);
  });

  it('gives two workspaces disjoint, non-nested socket dirs (no sibling visibility)', () => {
    const da = mcpWorkspaceSocketDir(USER_DATA, A);
    const db = mcpWorkspaceSocketDir(USER_DATA, B);
    expect(da).not.toBe(db);
    // Neither dir is an ancestor of the other, so binding one never drags the
    // other into the container's mount namespace.
    expect(da.startsWith(`${db}/`)).toBe(false);
    expect(db.startsWith(`${da}/`)).toBe(false);
    // And neither is the shared parent that would expose both.
    expect(da).not.toBe(mcpSocketDir(USER_DATA));
    expect(db).not.toBe(mcpSocketDir(USER_DATA));
  });
});
