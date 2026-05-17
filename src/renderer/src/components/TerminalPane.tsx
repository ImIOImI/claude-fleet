import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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
    term.open(host);
    fit.fit();

    let sessionId: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubEnd: (() => void) | null = null;
    let disposed = false;

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
