import { describe, it, expect, beforeEach } from 'vitest';
import {
  IDLE_OVERLAY,
  dragLeftWindow,
  isExternalDrag,
  isInternalDragActive,
  overlayEntered,
  overlayLeft,
  reorderDragHandlers,
  setInternalDragActive,
  shouldClaimDragOver
} from './dropIngestion';

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

describe('drop-overlay depth state machine', () => {
  // The "Drop to add to this workspace" overlay is driven by a dragenter/
  // dragleave depth counter. The stuck-overlay bug: a drag that ENTERS the
  // window (depth>0, overlay shown) and then ends OFF-window — dropped on
  // another app — doesn't deliver a balancing drop to us, and the lone
  // boundary dragleave only decremented depth by one. With depth left >0 the
  // overlay never hid. The window-exit leave (relatedTarget === null in
  // Chromium/Electron) must hard-reset depth, not just decrement.

  it('shows the overlay once an external drag enters', () => {
    const s = overlayEntered(IDLE_OVERLAY);
    expect(s).toEqual({ depth: 1, dragging: true });
  });

  it('keeps the overlay up across nested child enter/leave (no flicker)', () => {
    // enter window, enter child, leave old element — depth must stay > 0.
    let s = overlayEntered(IDLE_OVERLAY); // depth 1
    s = overlayEntered(s); // crossed into a child: depth 2
    s = overlayLeft(s, false); // left the parent element: depth 1
    expect(s.dragging).toBe(true);
    expect(s.depth).toBe(1);
  });

  it('hides the overlay when a balanced intra-window leave returns depth to 0', () => {
    let s = overlayEntered(IDLE_OVERLAY);
    s = overlayLeft(s, false);
    expect(s).toEqual({ depth: 0, dragging: false });
  });

  it('clamps depth at 0 so an unmatched leave never goes negative', () => {
    const s = overlayLeft(IDLE_OVERLAY, false);
    expect(s).toEqual({ depth: 0, dragging: false });
  });

  it('hard-resets when the drag leaves the window, even with depth > 1 (the stuck bug)', () => {
    // Two unbalanced enters (nested traversal) leave depth at 2 when the drag
    // reaches the window edge. The single exit leave must clear it fully.
    let s = overlayEntered(IDLE_OVERLAY);
    s = overlayEntered(s);
    expect(s.depth).toBe(2);
    s = overlayLeft(s, true); // relatedTarget === null: left the window
    expect(s).toEqual(IDLE_OVERLAY);
  });

  it('treats a null relatedTarget as leaving the window', () => {
    expect(dragLeftWindow(null)).toBe(true);
    expect(dragLeftWindow({} as EventTarget)).toBe(false);
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

describe('reorderDragHandlers', () => {
  // Session-tab reorder regression: TerminalPane wired its own drag handlers
  // without setInternalDragActive, so the window-level dragover still forced
  // dropEffect='copy' over the tab's 'move' and the drop never fired (the same
  // mechanism as #177, which was only fixed for workspace chips). The shared
  // factory exists so every internal reorder drag gets the flag wiring; these
  // tests pin that contract.
  interface FakeEvent {
    preventDefault(): void;
    dataTransfer: { effectAllowed: string };
    defaultPrevented: boolean;
  }
  function fakeEvent(): FakeEvent {
    const e = {
      defaultPrevented: false,
      preventDefault(): void {
        e.defaultPrevented = true;
      },
      dataTransfer: { effectAllowed: 'uninitialized' }
    };
    return e;
  }

  let dragId: string | null = null;
  let reorders: Array<[string, string]> = [];
  const opts = (id: string): Parameters<typeof reorderDragHandlers>[0] => ({
    id,
    dragId,
    setDragId: (v) => {
      dragId = v;
    },
    onReorder: (draggedId, targetId) => {
      reorders.push([draggedId, targetId]);
    }
  });

  beforeEach(() => {
    dragId = null;
    reorders = [];
    setInternalDragActive(false);
  });

  it('dragstart marks the drag internal so window dragover stays out (#177)', () => {
    const e = fakeEvent();
    reorderDragHandlers(opts('a')).onDragStart(e);
    expect(isInternalDragActive()).toBe(true);
    expect(shouldClaimDragOver(isInternalDragActive())).toBe(false);
    expect(e.dataTransfer.effectAllowed).toBe('move');
    expect(dragId).toBe('a');
  });

  it('dragover accepts the drop only over a different chip', () => {
    dragId = 'a';
    const over = fakeEvent();
    reorderDragHandlers(opts('b')).onDragOver(over);
    expect(over.defaultPrevented).toBe(true);

    const self = fakeEvent();
    reorderDragHandlers(opts('a')).onDragOver(self);
    expect(self.defaultPrevented).toBe(false);
  });

  it('drop reorders dragged-before-target and clears the drag state', () => {
    dragId = 'a';
    setInternalDragActive(true);
    reorderDragHandlers(opts('b')).onDrop(fakeEvent());
    expect(reorders).toEqual([['a', 'b']]);
    expect(dragId).toBeNull();
    expect(isInternalDragActive()).toBe(false);
  });

  it('drop on the dragged chip itself is a no-op reorder but still clears state', () => {
    dragId = 'a';
    setInternalDragActive(true);
    reorderDragHandlers(opts('a')).onDrop(fakeEvent());
    expect(reorders).toEqual([]);
    expect(dragId).toBeNull();
    expect(isInternalDragActive()).toBe(false);
  });

  it('dragend clears the flag even for a cancelled drag (no drop)', () => {
    dragId = 'a';
    setInternalDragActive(true);
    reorderDragHandlers(opts('a')).onDragEnd();
    expect(dragId).toBeNull();
    expect(isInternalDragActive()).toBe(false);
  });
});
