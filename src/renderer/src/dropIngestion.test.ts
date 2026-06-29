import { describe, it, expect } from 'vitest';
import { isExternalDrag, shouldClaimDragOver } from './dropIngestion';

describe('isExternalDrag', () => {
  // #147: an internal workspace-chip reorder drag carries effectAllowed='move'
  // and NO data items, so its dataTransfer.types is empty. Ingestion must ignore
  // it — otherwise the file-drop overlay flashes and the window drop handler
  // competes with (and swallows) the chip reorder.
  it('treats an internal chip drag (no payload types) as NOT external', () => {
    expect(isExternalDrag([])).toBe(false);
    expect(isExternalDrag(undefined)).toBe(false);
  });

  it('recognizes OS file drags', () => {
    expect(isExternalDrag(['Files'])).toBe(true);
  });

  it('recognizes dragged URLs, HTML, and plain text', () => {
    expect(isExternalDrag(['text/uri-list'])).toBe(true);
    expect(isExternalDrag(['text/html'])).toBe(true);
    expect(isExternalDrag(['text/plain'])).toBe(true);
  });

  it('recognizes a payload even when mixed with other types', () => {
    expect(isExternalDrag(['Files', 'text/plain'])).toBe(true);
  });

  it('ignores unrelated-only type lists', () => {
    expect(isExternalDrag(['application/x-internal-thing'])).toBe(false);
  });
});

describe('shouldClaimDragOver', () => {
  // #177: #147 stopped the overlay/drop from hijacking a chip reorder, but the
  // window-level onDragOver still preventDefault'd and set dropEffect='copy'
  // UNCONDITIONALLY — even for an internal chip drag. The chip drag carries
  // effectAllowed='move', and 'copy' is incompatible with 'move', so Chromium
  // computes the drag operation as none and never fires the chip's drop event:
  // no overlay (good) but also no reorder. The window must NOT claim dragover
  // while an internal drag is in flight, leaving the chip's 'move' to stand.
  it('does NOT claim dragover while an internal chip drag is active', () => {
    expect(shouldClaimDragOver(true)).toBe(false);
  });

  it('claims dragover for ordinary (external) drags so the copy cursor shows', () => {
    expect(shouldClaimDragOver(false)).toBe(true);
  });
});
