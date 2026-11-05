// Knowledge capture (#483 §5a): in-process notice that a workspace's capture
// settings changed (form save, MCP set, or an approved proposal). Listeners:
// the change log (form edits) and transcript retention (Task 15).
import type { CaptureSettings } from '../../preload/captureSettings.js';

export interface CaptureSettingsChanged {
  workspaceId: string;
  before: CaptureSettings;
  after: CaptureSettings;
  actor: 'user' | 'workspace';
  source: 'form' | 'mcp' | 'proposal';
}
type Listener = (e: CaptureSettingsChanged) => void;
const listeners = new Set<Listener>();

export function onCaptureSettingsChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitCaptureSettingsChanged(e: CaptureSettingsChanged): void {
  for (const fn of [...listeners]) {
    try { fn(e); } catch { /* a listener must never break a settings write */ }
  }
}
