import { describe, it, expect } from 'vitest';
import { wslMcpServerEntry, localMcpServerEntry, type McpTransport } from './mcpLocalBridge.js';

const UNIX: McpTransport = { kind: 'unix', socketPath: 'C:\\ud\\mcp\\ws1\\mcp.sock' };
const TCP: McpTransport = {
  kind: 'tcp',
  host: '127.0.0.1',
  port: 7071,
  tokenPath: 'C:\\ud\\mcp\\ws1\\token'
};

describe('wslMcpServerEntry', () => {
  it('translates the exe to /mnt/c and keeps Windows paths in args/env', () => {
    const e = wslMcpServerEntry(
      'C:\\Users\\troy\\AppData\\Local\\Programs\\claude-fleet\\claude-fleet.exe',
      'C:\\ud\\mcp\\local-bridge.cjs',
      UNIX
    );
    expect(e).toEqual({
      type: 'stdio',
      command: '/mnt/c/Users/troy/AppData/Local/Programs/claude-fleet/claude-fleet.exe',
      args: ['C:\\ud\\mcp\\local-bridge.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: 'C:\\ud\\mcp\\ws1\\mcp.sock' }
    });
  });
  it('returns null for a non-drive exe path', () => {
    expect(wslMcpServerEntry('\\\\server\\share\\x.exe', 'C:\\b.cjs', UNIX)).toBeNull();
  });
  // #295: the bridge runs as a WINDOWS process via interop, so the token file
  // stays a Windows path — translating it to /mnt/c would point the bridge at a
  // path that doesn't exist on its side of the boundary.
  it('emits TCP + an untranslated Windows token path for the tcp transport', () => {
    const e = wslMcpServerEntry('C:\\Programs\\claude-fleet\\claude-fleet.exe', 'C:\\b.cjs', TCP);
    expect(e).toEqual({
      type: 'stdio',
      command: '/mnt/c/Programs/claude-fleet/claude-fleet.exe',
      args: ['C:\\b.cjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_FLEET_MCP_TCP: '127.0.0.1:7071',
        CLAUDE_FLEET_MCP_TOKEN_FILE: 'C:\\ud\\mcp\\ws1\\token'
      }
    });
  });
});

describe('localMcpServerEntry', () => {
  it('is unchanged for the unix transport', () => {
    const e = localMcpServerEntry('/e', '/b.cjs', { kind: 'unix', socketPath: '/s.sock' });
    expect(e).toEqual({
      type: 'stdio',
      command: '/e',
      args: ['/b.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: '/s.sock' }
    });
  });
  it('emits TCP + token env for the tcp transport (#295)', () => {
    const e = localMcpServerEntry('C:\\cf.exe', 'C:\\b.cjs', TCP);
    expect(e.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_FLEET_MCP_TCP: '127.0.0.1:7071',
      CLAUDE_FLEET_MCP_TOKEN_FILE: 'C:\\ud\\mcp\\ws1\\token'
    });
    // No stale unix var — the bridge picks TCP by CLAUDE_FLEET_MCP_TCP being
    // set, and a leftover socket path would be a confusing dead reference.
    expect(e.env.CLAUDE_FLEET_MCP_SOCKET).toBeUndefined();
  });
});
