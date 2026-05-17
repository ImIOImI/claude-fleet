import { app } from 'electron';
import { join } from 'node:path';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export function assertValidContainerName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid container name "${name}": must match [a-zA-Z0-9_-]+ (used as a host path component)`
    );
  }
}

export function stateRoot(): string {
  return join(app.getPath('userData'), 'state');
}

export function containerStateDir(name: string): string {
  assertValidContainerName(name);
  return join(stateRoot(), name);
}

export function containerClaudeDir(name: string): string {
  return join(containerStateDir(name), '.claude');
}
