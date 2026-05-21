import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

interface Props {
  containerId: string;
}

export function TerminalPane({ containerId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#101216' },
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // URL detection + click-to-open. The default handler calls window.open,
    // which the main process's setWindowOpenHandler routes to shell.openExternal,
    // so URLs land in the host browser instead of trying to open inside the container.
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    let sessionId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;
    let disposed = false;

    // Ctrl+Shift+C copies the current selection; Ctrl+Shift+V pastes from
    // the system clipboard. Both consume the keystroke so xterm doesn't
    // also interpret it (e.g., Ctrl+C as SIGINT).
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => undefined);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text && sessionId) window.api.pty.input(sessionId, text);
          })
          .catch(() => undefined);
        return false;
      }
      return true;
    });

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
      unsubData?.();
      unsubEnd?.();
      if (sessionId) window.api.pty.detach(sessionId);
      term.dispose();
    };
  }, [containerId]);

  return <div className="terminal-host" ref={hostRef} />;
}
