// Hi-fi top bar — app mark, container picker (the row of chips), and
// global actions (daemon status, profiles, settings).
//
// The chips are the centerpiece. Each carries: color identity, status
// indicator, name, short status line, current cost. Selected chip uses a
// raised card surface; needs-input chip gets a pulsing red dot + danger
// tone on its status line (no extra "Reply" badge — the dot already says
// enough at the size).

function TopBar({ selectedId, activeTerminalByContainer = {}, onSelect, onCreate, onOpenProfiles, daemonStatus = 'ok' }) {
  return (
    <header style={{
      display: 'grid',
      gridTemplateColumns: '180px 1fr auto',
      alignItems: 'center',
      gap: 14,
      padding: '10px 14px',
      borderBottom: '1px solid var(--rule)',
      background: 'var(--bg)',
      minHeight: 72,
    }}>
      <Brand />

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        minWidth: 0, overflow: 'hidden',
      }}>
        {HF.containers.map((c) => (
          <ContainerChip
            key={c.id}
            container={{ ...c, activeTerminalId: activeTerminalByContainer[c.id] }}
            selected={c.id === selectedId}
            onClick={() => onSelect(c.id)}
          />
        ))}
        <HF.Btn kind="ghost" size="md" icon={<Icons.Plus size={14} />} onClick={onCreate}>
          New container
        </HF.Btn>
      </div>

      <TopBarActions daemonStatus={daemonStatus} onOpenProfiles={onOpenProfiles} />
    </header>
  );
}

// ── Brand mark ───────────────────────────────────────────────────────────
function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 7,
        background: 'var(--ink)', color: 'var(--bg)',
        display: 'grid', placeItems: 'center',
        fontFamily: "'Geist Mono', monospace",
        fontWeight: 600, fontSize: 13, letterSpacing: -0.02,
      }}>cf</div>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.01 }}>claude-fleet</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-2)' }}>3 containers</span>
      </div>
    </div>
  );
}

// ── Global actions (right side of top bar) ──────────────────────────────
function TopBarActions({ daemonStatus, onOpenProfiles }) {
  const ok = daemonStatus === 'ok';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div className="mono" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderRadius: 6,
        background: 'var(--bg-1)', border: '1px solid var(--rule-soft)',
        fontSize: 10, color: 'var(--ink-1)',
      }}>
        <HF.StatusDot status={ok ? 'running' : 'errored'} size={7} animated={false} />
        <span>{ok ? 'Docker' : 'No daemon'}</span>
      </div>
      <HF.Btn kind="ghost" size="md" icon={<Icons.Key size={14} />} onClick={onOpenProfiles}>
        Profiles
      </HF.Btn>
      <HF.Btn kind="ghost" size="md" icon={<Icons.Settings size={14} />} />
    </div>
  );
}

// ── Container chip ───────────────────────────────────────────────────────

function ContainerChip({ container, selected, onClick }) {
  const c = container;
  const isAttention = c.status === 'needs-input';
  const accent = `var(--${c.accent})`;
  return (
    <button
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px 8px 10px',
        minWidth: 220, maxWidth: 280,
        height: 48,
        borderRadius: 10,
        textAlign: 'left',
        cursor: 'pointer',
        background: selected ? 'var(--bg-card)' : 'transparent',
        border: selected ? `1px solid ${accent}` : '1px solid var(--rule)',
        boxShadow: selected ? 'var(--shadow-sm)' : 'none',
        transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease',
        fontFamily: 'inherit',
        color: 'var(--ink)',
      }}
    >
      {/* color identity bar */}
      <span style={{
        width: 3, height: 28, borderRadius: 2,
        background: accent,
        opacity: selected ? 1 : 0.85,
      }} />

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <span style={{
          fontSize: 13, fontWeight: 600, letterSpacing: -0.01,
          color: 'var(--ink)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{c.name}</span>
        <span className="mono" style={{
          fontSize: 10, color: isAttention ? 'var(--danger)' : 'var(--ink-2)',
          marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          textTransform: 'none', letterSpacing: 0.01,
        }}>
          {c.terminals.length}× <span style={{ color: 'var(--ink-3)' }}>·</span> {c.statusText}
        </span>
      </div>

      <HF.TerminalPips terminals={c.terminals} activeId={c.activeTerminalId} size={7} />
    </button>
  );
}

Object.assign(window, { TopBar, ContainerChip });
