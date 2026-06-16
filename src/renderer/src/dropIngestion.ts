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

export function useDropIngestion({ workspaceId, notify }: Options): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // Depth counter so nested dragenter/leave (crossing child elements)
    // doesn't flicker the overlay off mid-drag.
    let depth = 0;

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
      // preventDefault on dragover is what lets the drop event fire at all.
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };

    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      if (!dt) return;
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

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // Capture phase so we see the paste before xterm's textarea consumes it.
    window.addEventListener('paste', onPaste, true);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste, true);
    };
  }, [workspaceId, notify]);

  return { dragging };
}
