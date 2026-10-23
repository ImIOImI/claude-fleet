// Window-level drag-and-drop + clipboard-image ingestion.
//
// Wires the four drop sources (OS files, web URL, text/HTML, clipboard image)
// to the main-process `files:*` handlers, routing every drop to the
// currently-selected workspace. On success the saved container path is copied
// to the clipboard and surfaced via `notify` so the user can paste it into
// their prompt; failures (no workspace selected, over-limit, unreachable URL)
// surface the same way.
//
// Precedence on drop: real OS files first; then a dragged http(s) URL
// (fetched in main); then dragged HTML; then plain text. A browser image
// drag carries a synthetic File whose `getPathForFile` is empty, so it falls
// through to the URL branch — which is what we want (main fetches it).

import { useEffect, useState } from 'react';

export type NotifyKind = 'ok' | 'error';

interface Options {
  workspaceId: string | null;
  notify: (kind: NotifyKind, message: string) => void;
}

function looksLikeHttpUrl(s: string): boolean {
  const t = s.trim().split('\n')[0]?.trim() ?? '';
  return /^https?:\/\/\S+$/i.test(t);
}

// The dataTransfer.types a real ingestible drag carries: OS files, a dragged
// URL, dragged HTML, or plain text. An internal workspace-chip reorder drag
// (#147) sets effectAllowed='move' but NO data items, so its types list is
// empty — that's how we tell the two apart and avoid hijacking the reorder.
const EXTERNAL_DRAG_TYPES = ['Files', 'text/uri-list', 'text/plain', 'text/html'];

/** Whether a drag carries an external payload we should ingest (vs. an internal
 *  app drag like chip reorder, which has no data items). `types` is
 *  DataTransfer.types; readable during dragenter/dragover and at drop. */
export function isExternalDrag(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  return EXTERNAL_DRAG_TYPES.some((t) => types.includes(t));
}

// True for the lifetime of an internal app drag (a workspace-chip reorder),
// set on the chip's dragstart and cleared on dragend. The window-level
// dragover handler consults this instead of sniffing dataTransfer.types,
// which can read empty mid-drag in some Chromium/Electron builds (the reason
// onDragOver is otherwise unconditional). It's a module-scoped flag because
// the chip handlers (WorkspaceTabStrip) and the window handlers (here) live in
// different components but share the same native drag.
let internalDragActive = false;

/** Mark/clear an in-flight internal app drag (chip reorder). Called from the
 *  chip's dragstart (true) and dragend (false). */
export function setInternalDragActive(active: boolean): void {
  internalDragActive = active;
}

/** Read the internal-drag flag (for tests). */
export function isInternalDragActive(): boolean {
  return internalDragActive;
}

// The event surface the reorder handlers need — React.DragEvent satisfies it,
// and tests can pass a plain object.
interface ReorderDragEvent {
  preventDefault(): void;
  dataTransfer: { effectAllowed: string };
}

interface ReorderDragOpts {
  /** This chip's id. */
  id: string;
  /** The id currently being dragged (the strip's drag state), or null. */
  dragId: string | null;
  setDragId: (id: string | null) => void;
  /** Move `draggedId` before `targetId` in the strip's order. */
  onReorder: (draggedId: string, targetId: string) => void;
}

/** Drag-reorder handlers for a chip/tab in a strip (workspace chips, session
 *  tabs). Centralized so every internal reorder drag sets the internal-drag
 *  flag — a strip that wires dragstart by hand and forgets the flag gets its
 *  drop silently cancelled by the window-level ingestion dragover (#177:
 *  forced dropEffect='copy' is incompatible with the drag's
 *  effectAllowed='move', so Chromium resolves the operation to none). */
export function reorderDragHandlers({ id, dragId, setDragId, onReorder }: ReorderDragOpts): {
  onDragStart: (e: ReorderDragEvent) => void;
  onDragOver: (e: ReorderDragEvent) => void;
  onDrop: (e: ReorderDragEvent) => void;
  onDragEnd: () => void;
} {
  return {
    onDragStart(e) {
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      setInternalDragActive(true);
    },
    onDragOver(e) {
      if (dragId && dragId !== id) e.preventDefault(); // allow drop
    },
    onDrop(e) {
      e.preventDefault();
      if (dragId && dragId !== id) onReorder(dragId, id);
      setDragId(null);
      setInternalDragActive(false);
    },
    onDragEnd() {
      setDragId(null);
      // dragend always fires (drop or cancel), so this is the guaranteed
      // clear; the onDrop clear above just frees it a beat earlier.
      setInternalDragActive(false);
    }
  };
}

/** Whether the window-level ingestion should claim a `dragover` —
 *  `preventDefault()` + `dropEffect='copy'`. It must NOT claim an internal
 *  chip drag (#177): that drag carries `effectAllowed='move'`, and forcing
 *  `dropEffect='copy'` is incompatible with `'move'`, so Chromium resolves the
 *  drag operation to `none` and never fires the chip's `drop` event — the
 *  reorder silently no-ops (no overlay, but no reorder either). Leaving it
 *  unclaimed lets the chip's `'move'` stand. External drags (flag false) are
 *  claimed exactly as before, preserving the protected-mode fix above. */
export function shouldClaimDragOver(internalActive: boolean): boolean {
  return !internalActive;
}

// --- Drop-overlay depth state machine -------------------------------------
// The "Drop to add to this workspace" overlay is shown while `dragging`. A
// plain boolean flickers off when the cursor crosses between child elements
// (dragenter on the child fires before dragleave on the parent), so we count
// depth and only hide at 0. Extracted as pure functions so the stuck-overlay
// behaviour is unit-testable without a live DragEvent.

export interface OverlayState {
  depth: number;
  dragging: boolean;
}

export const IDLE_OVERLAY: OverlayState = { depth: 0, dragging: false };

/** An external drag entered an element: deepen and show the overlay. */
export function overlayEntered(s: OverlayState): OverlayState {
  return { depth: s.depth + 1, dragging: true };
}

/** A dragleave fired. `leftWindow` is true when the pointer crossed out of the
 *  window entirely (see {@link dragLeftWindow}) — then we HARD-reset rather
 *  than decrement. This fixes the stuck overlay: a drag that enters the window
 *  and ends off-window (dropped on another app) never delivers a balancing
 *  `drop`, and if depth was > 1 at the edge the lone exit leave would leave it
 *  pinned on. An intra-window leave (crossing between child elements) just
 *  decrements, clamped at 0. */
export function overlayLeft(s: OverlayState, leftWindow: boolean): OverlayState {
  if (leftWindow) return IDLE_OVERLAY;
  const depth = Math.max(0, s.depth - 1);
  return { depth, dragging: depth > 0 };
}

/** Whether a dragleave's relatedTarget means the drag left the window. In
 *  Chromium/Electron, relatedTarget is the element the pointer entered — null
 *  when it exits the window to another app. */
export function dragLeftWindow(relatedTarget: EventTarget | null): boolean {
  return relatedTarget === null;
}

export function useDropIngestion({ workspaceId, notify }: Options): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // Depth-counted overlay state (see the state-machine functions above) so
    // nested dragenter/leave doesn't flicker the overlay, and a drag that ends
    // off-window hard-resets instead of sticking on.
    let overlay = IDLE_OVERLAY;
    const apply = (next: OverlayState): void => {
      overlay = next;
      setDragging(next.dragging);
    };

    const announce = (paths: string[]): void => {
      const joined = paths.join('\n');
      void window.api.clipboard.write(joined);
      notify(
        'ok',
        paths.length === 1
          ? `Saved ${paths[0]} (path copied)`
          : `Saved ${paths.length} files to /workspace/_dropped/ (paths copied)`
      );
    };
    const fail = (err: unknown): void => {
      notify('error', err instanceof Error ? err.message : String(err));
    };
    const requireWorkspace = (): string | null => {
      if (!workspaceId) {
        notify('error', 'Select a workspace first, then drop.');
        return null;
      }
      return workspaceId;
    };

    const onDragOver = (e: DragEvent): void => {
      // Don't touch an internal chip-reorder drag (#177): forcing
      // dropEffect='copy' over its effectAllowed='move' makes Chromium cancel
      // the drop, so the reorder never fires. The chip's own dragover handles
      // its drop target; we stay out of the way.
      if (!shouldClaimDragOver(internalDragActive)) return;
      // preventDefault on dragover is what marks the window as a valid drop
      // target — without it the OS shows the "not-allowed" cursor. Call it
      // UNCONDITIONALLY and first: during a drag the dataTransfer is in
      // "protected mode" and can read as null/empty in some Chromium/Electron
      // builds, and guarding preventDefault behind it silently rejects the
      // drop. dropEffect is best-effort on top.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (e: DragEvent): void => {
      // Ignore internal app drags (chip reorder) — no external payload means no
      // overlay (#147). Genuine file/URL/text drags raise it as before.
      if (!isExternalDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      apply(overlayEntered(overlay));
    };
    const onDragLeave = (e: DragEvent): void => {
      apply(overlayLeft(overlay, dragLeftWindow(e.relatedTarget)));
    };

    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer;
      // Internal app drag (e.g. chip reorder): let the originating handler own
      // the drop — don't preventDefault or run ingestion, which would swallow
      // the reorder (#147). At drop time dataTransfer.types is fully readable.
      if (!dt || !isExternalDrag(dt.types)) return;
      e.preventDefault();
      apply(IDLE_OVERLAY);
      const ws = requireWorkspace();
      if (!ws) return;

      // 1. OS files (Explorer/Finder/Nautilus) — getPathForFile yields a real
      //    host path; synthetic files (browser drags) yield ''.
      const osPaths = Array.from(dt.files)
        .map((f) => window.api.files.getPathForFile(f))
        .filter((p) => p.length > 0);
      if (osPaths.length > 0) {
        window.api.files.dropOsFiles(ws, osPaths).then(announce).catch(fail);
        return;
      }

      // 2. Dragged http(s) URL — main fetches it.
      const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri && looksLikeHttpUrl(uri)) {
        const url = uri.trim().split('\n')[0]!.trim();
        window.api.files
          .dropUrl(ws, url)
          .then((p) => announce([p]))
          .catch(fail);
        return;
      }

      // 3. Dragged HTML, else plain text.
      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      if (html) {
        window.api.files
          .dropText(ws, { mime: 'text/html', text: html })
          .then((p) => announce([p]))
          .catch(fail);
      } else if (text) {
        window.api.files
          .dropText(ws, { mime: 'text/plain', text })
          .then((p) => announce([p]))
          .catch(fail);
      }
      // Nothing recognizable → silently ignore (e.g. an empty drag).
    };

    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // Only act on an image on the clipboard. Text paste falls through to
      // xterm's own Ctrl+V handler (which reads clipboard text).
      const imageItem = Array.from(items).find(
        (it) => it.kind === 'file' && it.type.startsWith('image/')
      );
      if (!imageItem) return;
      // We're handling this paste — keep it from also reaching the terminal.
      e.preventDefault();
      e.stopPropagation();
      const ws = requireWorkspace();
      if (!ws) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      file
        .arrayBuffer()
        .then((buf) =>
          window.api.files.dropBytes(ws, { mime: file.type, bytes: new Uint8Array(buf) })
        )
        .then((p) => announce([p]))
        .catch(fail);
    };

    // Image paste routed from the terminal's Ctrl+V handler (xterm
    // suppresses the native `paste` event while focused — see TerminalSession).
    const onDropImage = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { bytes: Uint8Array; mime: string } | undefined;
      if (!detail) return;
      const ws = requireWorkspace();
      if (!ws) return;
      window.api.files
        .dropBytes(ws, { mime: detail.mime, bytes: detail.bytes })
        .then((p) => announce([p]))
        .catch(fail);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // Capture phase so we see the paste before xterm's textarea consumes it
    // (covers the case where focus is OUTSIDE the terminal; the in-terminal
    // case comes through 'cf:drop-image' above).
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('cf:drop-image', onDropImage);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('cf:drop-image', onDropImage);
    };
  }, [workspaceId, notify]);

  return { dragging };
}
