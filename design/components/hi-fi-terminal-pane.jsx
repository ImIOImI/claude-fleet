// Hi-fi terminal pane.
//
// Sits in the center column. Top is a tab strip listing the claude
// sessions ("terminals") attached to the currently-selected container —
// each tab is a separate `docker exec claude` PTY in that container.
// Below is a dark terminal surface showing the active terminal's
// transcript.
//
// The tab strip is anchored by a left-side context block (container badge
// + name + "Terminals") so it's unmistakable that these tabs belong to
// the selected container. Switching containers swaps both the tab list
// and the body.

function TerminalPane({ container, activeTerminalId, onSelectTerminal, onCloseTerminal, onOpenSettings }) {
  const active = container.terminals.find((t) => t.id === activeTerminalId)
    || container.terminals[0];
  const lines = HF.transcripts[active.transcript] || HF.transcripts.idle;

  return (
    <section style={{
      display: 'grid',
      gridTemplateRows: 'auto auto 1fr',
      minWidth: 0, minHeight: 0,
      background: 'var(--bg)',
    }}>
      <TabStrip
        container={container}
        activeId={active.id}
        terminal={active}
        onSelect={onSelectTerminal}
        onClose={onCloseTerminal}
        onOpenSettings={onOpenSettings}
      />
      <ContextBar terminal={active} accent={container.accent} />
      <TerminalBody container={container} terminal={active} lines={lines} />
    </section>
  );
}

// ── Tab strip ────────────────────────────────────────────────────────────

function TabStrip({ container, activeId, terminal, onSelect, onClose, onOpenSettings }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      borderBottom: '1px solid var(--rule)',
      background: 'var(--bg)',
      minHeight: 42,
      paddingLeft: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'stretch', minWidth: 0, overflow: 'hidden' }}>
        {container.terminals.map((t) => (
          <Tab key={t.id} terminal={t} accent={container.accent}
               active={t.id === activeId}
               onSelect={onSelect} onClose={onClose} />
        ))}
        <button onClick={() => {}} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 32,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ink-2)',
        }} title="New terminal in this container">
          <Icons.Plus size={14} />
        </button>
      </div>

      <div style={{ flex: 1 }} />

      <button
        onClick={onOpenSettings}
        title="Terminal settings"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 38,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ink-2)',
          borderLeft: '1px solid var(--rule-soft)',
        }}>
        <Icons.Menu size={15} />
      </button>
    </div>
  );
}

function Tab({ terminal: t, accent, active, onSelect, onClose }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={() => onSelect(t.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '0 14px',
        height: '100%',
        background: active ? 'var(--bg)' : 'transparent',
        border: 'none',
        borderRight: '1px solid var(--rule-soft)',
        borderBottom: active ? `2px solid var(--${accent})` : '2px solid transparent',
        marginBottom: -1,
        cursor: 'pointer',
        color: active ? 'var(--ink)' : 'var(--ink-2)',
        fontFamily: "'Geist Mono', monospace",
        fontSize: 11.5, letterSpacing: 0,
        minWidth: 0,
      }}
      title={`${t.name} · ${t.desc}`}
    >
      <HF.StatusDot status={t.status} size={7} animated={active || t.status === 'needs-input'} />
      <span style={{
        fontWeight: active ? 600 : 500,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{t.name}</span>
      {!active && (
        <span style={{
          fontSize: 9, color: 'var(--ink-3)',
          textTransform: 'none', letterSpacing: 0.02,
        }}>· {t.desc}</span>
      )}
      <span
        onClick={(e) => { e.stopPropagation(); onClose && onClose(t.id); }}
        title="Close terminal"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: 3,
          opacity: (active || hover) ? 0.85 : 0,
          color: 'var(--ink-2)',
          transition: 'opacity 100ms, background 100ms',
        }}>
        <Icons.X size={10} />
      </span>
    </button>
  );
}

// ── Context-window indicator ─────────────────────────────────────────────
//
// A thin band riding the top edge of the terminal body in container
// accent. Fill width = current context usage. The bar is purely identity
// + fill state — it never changes color, so the visual link to the
// container is preserved. Numeric percentage and warning state live in
// the observability rail.

function ContextBar({ terminal, accent }) {
  const ctx = terminal.context || { used: 0, max: 200000 };
  const pct = ctx.used / ctx.max;
  return (
    // Wrapper provides breathing room between the tab strip's active
    // underline and the bar itself.
    <div style={{
      padding: '8px 0 0',
      background: 'var(--bg)',
    }}>
      <div
        title={`Context · ${fmtK(ctx.used)} of ${fmtK(ctx.max)} (${Math.round(pct * 100)}%)`}
        style={{
          position: 'relative',
          height: 3,
          background: 'var(--rule-soft)',
        }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct * 100}%`,
          background: `var(--${accent})`,
          transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        }} />
        {/* compaction threshold tick at 80% */}
        <div style={{
          position: 'absolute', left: '80%', top: -2, bottom: -2,
          width: 1, background: 'var(--ink-3)', opacity: 0.35,
        }} />
      </div>
    </div>
  );
}

function fmtK(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

// ── Terminal body — the actual transcript surface ────────────────────────

function TerminalBody({ container, terminal, lines }) {
  return (
    <div style={{
      position: 'relative',
      background: 'var(--bg-term)',
      color: 'var(--term-ink)',
      padding: '16px 22px 80px',
      overflow: 'auto',
      fontFamily: "'Geist Mono', monospace",
      fontSize: 12.5,
      lineHeight: 1.65,
    }}>
      {lines.map((l, i) => <TerminalLine key={i} line={l} accent={container.accent} />)}

      <DropHint />
    </div>
  );
}

function DropHint() {
  return (
    <div style={{
      position: 'absolute', right: 14, bottom: 14,
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 9px', borderRadius: 6,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.06)',
      color: 'var(--term-ink-3)',
      fontFamily: "'Geist Mono', monospace", fontSize: 10,
    }}>
      <Icons.Upload size={11} />
      <span>Drop files anywhere to add to /workspace/_dropped</span>
    </div>
  );
}

function TerminalLine({ line, accent }) {
  if (line.kind === 'blank') return <div style={{ height: 8 }} />;

  if (line.kind === 'sys') {
    return <div style={{ color: 'var(--term-ink-3)' }}>{line.text}</div>;
  }
  if (line.kind === 'user') {
    return <div style={{ color: 'var(--term-ink)', fontWeight: 500 }}>{line.text}</div>;
  }
  if (line.kind === 'agent') {
    return <div style={{ color: 'var(--term-ink-2)' }}>{line.text}</div>;
  }
  if (line.kind === 'tool') {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '1px 7px', borderRadius: 3,
          background: `color-mix(in oklch, var(--${accent}) 22%, transparent)`,
          color: `var(--${accent})`,
          fontSize: 10, letterSpacing: 0.04, textTransform: 'uppercase',
        }}>
          {line.tool}
        </span>
        <span style={{ color: 'var(--term-ink-2)' }}>{line.text}</span>
        {line.meta && <span style={{ color: 'var(--term-ink-3)', marginLeft: 4 }}>· {line.meta}</span>}
      </div>
    );
  }
  if (line.kind === 'prompt') {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--term-ink)' }}>
        <span style={{ color: `var(--${accent})` }}>&gt;</span>
        <span style={{
          display: 'inline-block', width: 8, height: 14,
          background: 'var(--term-ink)', verticalAlign: 'middle',
          animation: 'hifiBlink 1.05s steps(1, end) infinite',
        }} />
      </div>
    );
  }
  return null;
}

Object.assign(window, { TerminalPane });
