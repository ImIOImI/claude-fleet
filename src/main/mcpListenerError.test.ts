// The MCP listener-error formatter is the durable-observability fix for #159:
// a bind failure on the host MCP listener (win32 TCP :7071, or a per-workspace
// unix socket) used to go only to console.warn and vanish on a double-click
// launch. These tests pin the EADDRINUSE detection + the actionable message so
// the failure leaves a useful, greppable trace in error.log. The formatter is
// pure (no electron / native deps) so it lives apart from mcpServer.ts and is
// unit-testable without mocking — mirroring mcpReadonlySql.ts / mcpSocket.ts.

import { describe, expect, it } from 'vitest';
import { describeListenerError } from './mcpListenerError.js';

// A Node net listener error carries a `.code` (e.g. 'EADDRINUSE'). Build one the
// way `srv.on('error', …)` actually receives it.
function netError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('describeListenerError', () => {
  it('stamps the scope and a stable type so the log line is greppable', () => {
    const out = describeListenerError({ scope: 'tcp', port: 7071 }, netError('EACCES', 'permission denied'));
    expect(out.type).toBe('mcpListenerError');
    expect(out.extra.scope).toBe('tcp');
    expect(out.extra.port).toBe(7071);
    expect(out.extra.code).toBe('EACCES');
  });

  it('preserves the original error message and stack', () => {
    const err = netError('EACCES', 'permission denied');
    const out = describeListenerError({ scope: 'tcp', port: 7071 }, err);
    expect(out.message).toContain('permission denied');
    expect(out.stack).toBe(err.stack);
  });

  it('EADDRINUSE on the shared TCP listener names the port and the likely cause', () => {
    const out = describeListenerError({ scope: 'tcp', port: 7071 }, netError('EADDRINUSE', 'address already in use'));
    // Actionable: the message must say which port and point at the real culprit
    // (another claude-fleet instance already holding it) so the user isn't left
    // guessing why MCP shows "Failed to connect".
    expect(out.message).toContain('7071');
    expect(out.message.toLowerCase()).toContain('already in use');
    expect(out.message.toLowerCase()).toContain('claude-fleet');
    expect(out.extra.code).toBe('EADDRINUSE');
  });

  it('EADDRINUSE on a per-workspace unix listener names the workspace', () => {
    const out = describeListenerError(
      { scope: 'unix', workspaceId: '01WORKSPACEAAAAAAAAAAAAAAA' },
      netError('EADDRINUSE', 'address already in use')
    );
    expect(out.message).toContain('01WORKSPACEAAAAAAAAAAAAAAA');
    expect(out.extra.workspaceId).toBe('01WORKSPACEAAAAAAAAAAAAAAA');
    expect(out.extra.code).toBe('EADDRINUSE');
  });

  it('tolerates a non-Error / codeless value without throwing', () => {
    const out = describeListenerError({ scope: 'tcp', port: 7071 }, 'boom');
    expect(out.message).toContain('boom');
    expect(out.extra.code).toBeUndefined();
    expect(out.stack).toBeUndefined();
  });
});
