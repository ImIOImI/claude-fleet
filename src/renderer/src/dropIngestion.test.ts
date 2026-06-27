import { describe, it, expect } from 'vitest';
import { isExternalDrag } from './dropIngestion';

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
