import { describe, expect, it } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings.js';
import { emitCaptureSettingsChanged, onCaptureSettingsChanged, type CaptureSettingsChanged } from './captureSettingsEvents.js';

describe('capture settings change events', () => {
  it('delivers to every listener, survives a throwing one, and unsubscribes', () => {
    const d = defaultCaptureSettings();
    const seen: CaptureSettingsChanged[] = [];
    const offBad = onCaptureSettingsChanged(() => { throw new Error('boom'); });
    const off = onCaptureSettingsChanged((e) => seen.push(e));
    const e: CaptureSettingsChanged = { workspaceId: 'w', before: d, after: { ...d, enabled: false }, actor: 'user', source: 'form' };
    emitCaptureSettingsChanged(e);
    off(); offBad();
    emitCaptureSettingsChanged(e);
    expect(seen).toEqual([e]);
  });
});
