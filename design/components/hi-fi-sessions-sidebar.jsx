// Hi-fi sessions sidebar.
//
// A scrollable history of past Claude Code sessions. Filter by container
// (chips at the top), search, single-line rows with hover-revealed
// actions. Selected row pins its actions and gets a colored left rule.

function SessionsPanel({ selectedSessionId, onSelectSession }) {
  const [filter, setFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const filtered = HF.sessions.filter((s) => {
    if (filter !== 'all' && s.container !== filter) return false;
    if (query && !s.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <aside style={{
      display: 'grid',
      gridTemplateRows: 'auto auto 1fr auto',
      minHeight: 0,
      borderRight: '1px solid var(--rule)',
      background: 'var(--bg)',
    }}>
      <Header total={HF.sessions.length} shown={filtered.length} />
      <FilterRow filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} />

      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {filtered.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            selected={s.id === selectedSessionId}
            onClick={() => onSelectSession(s.id)}
          />
        ))}
      </div>

      <FooterRow />
    </aside>
  );
}

function Header({ total, shown }) {
  return (
    <div style={{
      padding: '12px 14px 8px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.01 }}>Sessions</div>
        <div className="micro" style={{ marginTop: 2 }}>{shown === total ? total : `${shown} of ${total}`}</div>
      </div>
      <HF.Btn kind="quiet" size="sm" icon={<Icons.More size={14} />} />
    </div>
  );
}

function FilterRow({ filter, setFilter, query, setQuery }) {
  return (
    <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        height: 30, padding: '0 10px',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 6,
      }}>
        <Icons.Search size={13} style={{ color: 'var(--ink-2)' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sessions"
          style={{
            flex: 1, minWidth: 0,
            background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--ink)', fontSize: 12, fontFamily: 'inherit',
          }}
        />
        <HF.Kbd>⌘F</HF.Kbd>
      </div>

      {/* filter chips */}
      <div style={{ display: 'flex', gap: 4 }}>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterChip>
        {HF.containers.map((c) => (
          <FilterChip
            key={c.id}
            active={filter === c.id}
            onClick={() => setFilter(c.id)}
            accent={c.accent}
            withBadge={c.id}
          >{c.name}</FilterChip>
        ))}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, accent, withBadge, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 8px', borderRadius: 4,
      background: active
        ? (accent ? `var(--${accent}-soft)` : 'var(--ink)')
        : 'transparent',
      color: active
        ? (accent ? 'var(--ink)' : 'var(--bg)')
        : 'var(--ink-1)',
      border: active
        ? `1px solid ${accent ? `var(--${accent})` : 'var(--ink)'}`
        : '1px solid var(--rule)',
      fontSize: 10, fontFamily: "'Geist Mono', monospace",
      letterSpacing: 0.02,
      cursor: 'pointer',
      maxWidth: 110,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>
      {withBadge && <HF.ContainerBadge id={withBadge} size={8} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </button>
  );
}

// ── Session row ──────────────────────────────────────────────────────────

function SessionRow({ session: s, selected, onClick }) {
  const [hover, setHover] = React.useState(false);
  const accent = `var(--${s.container})`;
  const showActions = hover || selected;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '3px 14px 1fr',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 14px 10px 11px',
        cursor: 'pointer',
        background: selected ? 'var(--bg-1)' : (hover ? 'var(--bg-hover)' : 'transparent'),
        borderBottom: '1px solid var(--rule-soft)',
      }}
    >
      <span style={{
        alignSelf: 'stretch', borderRadius: 2,
        background: selected ? accent : 'transparent',
        marginLeft: -11,
      }} />
      <HF.ContainerBadge id={s.container} size={11} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.35,
          letterSpacing: -0.005,
          display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>{s.title}</div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 6, gap: 8, minHeight: 18,
        }}>
          <div className="mono" style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 10, color: 'var(--ink-2)',
            textTransform: 'none', letterSpacing: 0.01,
          }}>
            <span>{s.when}</span>
            <span style={{ color: 'var(--ink-3)' }}>·</span>
            <span>${s.cost.toFixed(2)}</span>
            <span style={{ color: 'var(--ink-3)' }}>·</span>
            <span>{s.tools} tools</span>
          </div>
          {showActions && (
            <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
              <HF.Btn kind="secondary" size="sm" icon={<Icons.Play size={11} />}>Resume</HF.Btn>
              <HF.Btn kind="quiet"     size="sm" icon={<Icons.Trash size={12} />} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────

function FooterRow() {
  return (
    <div style={{
      padding: '10px 12px',
      borderTop: '1px solid var(--rule)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 8,
    }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)' }}>
        {HF.sessions.length} sessions · ${HF.sessions.reduce((a, b) => a + b.cost, 0).toFixed(2)} total
      </div>
      <HF.Kbd>⌘K</HF.Kbd>
    </div>
  );
}

Object.assign(window, { SessionsPanel });
