// The container MCP bridge as an image file: same source as the desktop's per-workspace copy.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_BRIDGE_FILENAME, ensureContainerBridgeScript } from '../main/mcpContainerBridge.js';

export function writeMcpBridge(path: string): void {
  const tmp = mkdtempSync(join(tmpdir(), 'bridge-'));
  try {
    ensureContainerBridgeScript(tmp);
    copyFileSync(join(tmp, CONTAINER_BRIDGE_FILENAME), path);
    chmodSync(path, 0o644);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
