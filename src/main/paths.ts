import { app } from 'electron';
import { join } from 'node:path';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export function assertValidWorkspaceName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}": must match [a-zA-Z0-9_-]+ (used as a host path component)`
    );
  }
}

export function stateRoot(): string {
  return join(app.getPath('userData'), 'state');
}

export function workspaceStateDir(name: string): string {
  assertValidWorkspaceName(name);
  return join(stateRoot(), name);
}

export function workspaceClaudeDir(name: string): string {
  return join(workspaceStateDir(name), '.claude');
}

export function workspaceManifestPath(name: string): string {
  return join(workspaceStateDir(name), 'workspace.json');
}

// Bind-mounted into the container at /run/broker (see docker/Dockerfile).
// The in-container broker creates its Unix socket here as broker.sock.
// One dir per workspace so brokers from different workspaces never
// share a socket namespace.
export function workspaceBrokerDir(name: string): string {
  return join(workspaceStateDir(name), 'broker');
}

export function workspaceBrokerSocket(name: string): string {
  return join(workspaceBrokerDir(name), 'broker.sock');
}
