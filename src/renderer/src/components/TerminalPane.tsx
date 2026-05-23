import { useEffect, useRef, useState } from 'react';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Default WebLinksAddon matches URLs per visual row, so long URLs that soft-wrap
// across multiple rows only register the first row as clickable — and "open link"
// hits a truncated URL. This provider walks back to the first non-wrapped row,
// forward through isWrapped continuations, concatenates the rows with no padding,
// matches URLs across the joined text, and emits a link range that spans rows.
const URL_REGEX = /https?:\/\/[^\s'"`<>()\[\]{}]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function multilineLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      const cols = term.cols;

      let firstRow = bufferLineNumber;
      while (firstRow > 1 && buf.getLine(firstRow - 1)?.isWrapped) firstRow--;

      let lastRow = firstRow;
      while (lastRow < buf.length && buf.getLine(lastRow)?.isWrapped) lastRow++;

      let logical = '';
      for (let r = firstRow; r <= lastRow; r++) {
        logical += buf.getLine(r - 1)?.translateToString(false) ?? '';
      }

      const links: ILink[] = [];
      URL_REGEX.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_REGEX.exec(logical)) !== null) {
        const url = m[0].replace(TRAILING_PUNCTUATION, '');
        if (!url) continue;

        const startIdx = m.index;
        const endIdx = startIdx + url.length - 1;
        const startRow = firstRow + Math.floor(startIdx / cols);
        const startCol = (startIdx % cols) + 1;
        const endRow = firstRow + Math.floor(endIdx / cols);
        const endCol = (endIdx % cols) + 1;

        if (startRow > bufferLineNumber || endRow < bufferLineNumber) continue;

        links.push({
          range: { start: { x: startCol, y: startRow }, end: { x: endCol, y: endRow } },
          text: url,
          activate: () => {
            window.open(url, '_blank');
          }
        });
      }
      callback(links.length ? links : undefined);
    }
  };
}

interface Props {
  containerId: string;
}

export function TerminalPane({ containerId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Bumped when the user clicks "Start new session" after a session ends.
  // The effect deps on containerId+sessionEpoch, so a new attach happens
  // with a fresh xterm instance (no stale state from the dead session).
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    setSessionEnded(false);

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#101216' },
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
      // Word-select (double-click) treats only whitespace, brackets, quotes,
      // and angle brackets as separators — keeps URL chars (`/?&=:.`) inside
      // the word so double-clicking a URL selects it whole.
      wordSeparator: ' \t()[]{}\'"<>`'
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Multi-line URL detection. Activate calls window.open, which the main
    // process's setWindowOpenHandler routes through shell.openExternal so links
    // open in the host browser, not inside the container.
    const linkProviderDisposable = term.registerLinkProvider(multilineLinkProvider(term));

    let sessionId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;
    let disposed = false;

    const doCopy = (): void => {
      const sel = term.getSelection();
      if (sel) {
        void window.api.clipboard.write(sel);
        term.clearSelection();
      }
    };

    const doPaste = (): void => {
      void window.api.clipboard.read().then((text) => {
        if (text && sessionId) window.api.pty.input(sessionId, text);
      });
    };

    // Key bindings:
    //   Ctrl+C  -> copy when there's a selection; falls through as SIGINT when not
    //   Ctrl+V  -> paste
    //   Ctrl+Shift+C / V -> explicit copy / paste (terminal-convention alternates)
    // Returning false consumes the keystroke so xterm doesn't also process it.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

      if (plainCtrl && e.code === 'KeyC') {
        if (term.hasSelection()) {
          doCopy();
          return false;
        }
        return true; // no selection — pass through as SIGINT
      }
      if (plainCtrl && e.code === 'KeyV') {
        doPaste();
        return false;
      }
      if (ctrlShift && e.code === 'KeyC') {
        doCopy();
        return false;
      }
      if (ctrlShift && e.code === 'KeyV') {
        doPaste();
        return false;
      }
      return true;
    });

    const onContextMenu = async (e: MouseEvent): Promise<void> => {
      e.preventDefault();
      const hasSelection = term.hasSelection();
      const choice = await window.api.menu.showTerminalContextMenu({ hasSelection });
      if (choice === 'copy') doCopy();
      else if (choice === 'paste') doPaste();
      else if (choice === 'selectAll') term.selectAll();
    };
    host.addEventListener('contextmenu', onContextMenu);

    (async () => {
      const sid = await window.api.pty.attach(containerId, term.cols, term.rows);
      if (disposed) {
        window.api.pty.detach(sid);
        return;
      }
      sessionId = sid;
      unsubData = window.api.pty.onData(sid, (chunk) => {
        term.write(chunk);
      });
      unsubEnd = window.api.pty.onEnd(sid, () => {
        term.writeln('\r\n[session ended]');
        if (!disposed) setSessionEnded(true);
      });
      term.onData((data) => window.api.pty.input(sid, data));
    })();

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (sessionId) window.api.pty.resize(sessionId, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      unsubData?.();
      unsubEnd?.();
      linkProviderDisposable.dispose();
      if (sessionId) window.api.pty.detach(sessionId);
      term.dispose();
    };
  }, [containerId, sessionEpoch]);

  return (
    <div className="terminal-host" ref={hostRef}>
      {sessionEnded && (
        <div className="session-ended-overlay" role="alertdialog" aria-label="Session ended">
          <div className="session-ended-card">
            <div className="session-ended-title">claude session ended</div>
            <div className="session-ended-help">
              The workspace is still running. Start a new <code>claude</code> session in this
              workspace to keep going.
            </div>
            <button
              className="btn primary"
              onClick={() => setSessionEpoch((e) => e + 1)}
            >
              Start new session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
