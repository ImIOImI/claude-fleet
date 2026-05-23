// Hi-fi observability rail.
//
// Collapsible + scope-aware:
//   - expanded · container → per-container detail (cost, tools, workspace)
//   - expanded · fleet     → aggregate cost + per-container + fleet feed
//   - collapsed (either)   → icon strip with the headline stats
//
// State is passed in by the parent (HiFiApp) so the rail's collapsed/scope
// values are observable from the rest of the UI (e.g. the status bar can
// reflect what the user is observing).

function ObsRail({ collapsed, scope, container, onToggleCollapsed, onScope }) {
  if (collapsed) return <ObsRailCollapsed scope={scope} container={container} onExpand={onToggleCollapsed} />;
  return (
    <aside style={{
      borderLeft: '1px solid var(--rule)',
      background: 'var(--bg)',
      display: 'grid',
      gridTemplateRows: 'auto auto 1fr',
      minHeight: 0, minWidth: 0,
    }}>
      <ObsHeader onToggleCollapsed={onToggleCollapsed} scope={scope} />
      <ScopeToggle scope={scope} onScope={onScope} container={container} />
      <div style={{ overflow: 'auto', minHeight: 0, padding: '8px 14px 18px' }}>
        {scope === 'fleet' ? <RailFleet /> : <RailContainer container={container} />}
      </div>
    </aside>
  );
}

function ObsHeader({ onToggleCollapsed, scope }) {
  const accent = scope === 'fleet' ? 'var(--ok)' : 'var(--c2)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 10px 12px 14px',
      borderBottom: '1px solid var(--rule-soft)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icons.Zap size={13} style={{ color: 'var(--ink-2)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: -0.01 }}>Observability</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontFamily: "'Geist Mono', monospace", fontSize: 10,
          letterSpacing: 0.04, textTransform: 'uppercase',
          color: accent,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: accent,
            animation: 'hifiBlink 1.6s ease-in-out infinite',
          }} />
          live
        </span>
        <HF.Btn kind="quiet" size="sm" icon={<Icons.ChevronR size={13} />} onClick={onToggleCollapsed} />
      </div>
    </div>
  );
}

function ScopeToggle({ scope, onScope, container }) {
  return (
    <div style={{ padding: '8px 12px 4px' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 6, padding: 2, gap: 2,
      }}>
        <ToggleBtn active={scope === 'container'} onClick={() => onScope('container')}>
          <HF.ContainerBadge id={container.id} size={9} />
          <span>This container</span>
        </ToggleBtn>
        <ToggleBtn active={scope === 'fleet'} onClick={() => onScope('fleet')}>
          <Icons.Layers size={11} />
          <span>Fleet · 3</span>
        </ToggleBtn>
      </div>
    </div>
  );
}

function ToggleBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      padding: '6px 8px', borderRadius: 4,
      background: active ? 'var(--bg-card)' : 'transparent',
      color: active ? 'var(--ink)' : 'var(--ink-2)',
      border: active ? '1px solid var(--rule)' : '1px solid transparent',
      boxShadow: active ? 'var(--shadow-sm)' : 'none',
      fontSize: 11, fontWeight: 500,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}>{children}</button>
  );
}

// ── Expanded · per-container ─────────────────────────────────────────────

function RailContainer({ container }) {
  const c = container;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <CostBlock cost={c.cost} tokens={c.tokens} elapsed={c.elapsed} accent={c.accent} terminals={c.terminals} activeTerminalId={c.activeTerminalId} />
      <ToolsBlock accent={c.accent} />
      <WorkspaceBlock container={c} />
    </div>
  );
}

function SectionLabel({ children, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 8,
    }}>
      <span className="micro">{children}</span>
      {action}
    </div>
  );
}

function CostBlock({ cost, tokens, elapsed, accent, terminals, activeTerminalId }) {
  return (
    <div>
      <SectionLabel>Cost · {elapsed} elapsed</SectionLabel>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.02, lineHeight: 1 }}>
          ${cost.toFixed(2)}
        </span>
      </div>

      {/* mini sparkline */}
      <Sparkline accent={accent} />

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12,
      }}>
        <TokenStat label="Input"    value={tokens.in.toLocaleString()} />
        <TokenStat label="Output"   value={tokens.out.toLocaleString()} />
        <TokenStat label="Cache rd" value={tokens.cacheRd.toLocaleString()} subtle />
        <TokenStat label="Cache wr" value="1,902" subtle />
      </div>

      {terminals && terminals.length > 0 && (
        <ContextRows terminals={terminals} activeTerminalId={activeTerminalId} accent={accent} />
      )}
    </div>
  );
}

// One bar per terminal in the container, with name + fill + percent +
// optional warning. Bars stay in the container accent always; the warning
// state is communicated via the percent's color + an alert glyph.
function ContextRows({ terminals, activeTerminalId, accent }) {
  return (
    <div style={{ marginTop: 16 }}>
      <SectionLabel>Context · {terminals.length} terminal{terminals.length === 1 ? '' : 's'}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {terminals.map((t) => (
          <ContextRow
            key={t.id}
            terminal={t}
            accent={accent}
            active={t.id === activeTerminalId}
          />
        ))}
      </div>
    </div>
  );
}

function ContextRow({ terminal, accent, active }) {
  const ctx = terminal.context || { used: 0, max: 200000 };
  const pct = ctx.used / ctx.max;
  const isHot  = pct >= 0.75;
  const isCrit = pct >= 0.90;
  const pctTone = isCrit ? 'var(--danger)' : isHot ? 'var(--warn)' : 'var(--ink-1)';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '52px 1fr 36px',
      gap: 8,
      alignItems: 'center',
    }}>
      <div className="mono" style={{
        fontSize: 11, fontWeight: active ? 600 : 500,
        color: active ? 'var(--ink)' : 'var(--ink-1)',
        textTransform: 'none', letterSpacing: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {active && <span style={{
          width: 4, height: 4, borderRadius: '50%',
          background: `var(--${accent})`,
        }} />}
        <span>{terminal.name}</span>
      </div>
      <div style={{
        position: 'relative',
        height: 5, borderRadius: 3, overflow: 'hidden',
        background: 'var(--bg-2)',
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${Math.max(2, pct * 100)}%`,
          background: `var(--${accent})`,
          transition: 'width 240ms ease',
        }} />
        {/* compaction threshold tick */}
        <div style={{
          position: 'absolute', left: '80%', top: -1, bottom: -1,
          width: 1, background: 'var(--ink-3)', opacity: 0.4,
        }} />
      </div>
      <span className="mono" style={{
        fontSize: 11, fontWeight: 500,
        color: pctTone, textAlign: 'right',
        textTransform: 'none', letterSpacing: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3,
      }}>
        {isHot && <Icons.Alert size={10} />}
        <span>{Math.round(pct * 100)}%</span>
      </span>
    </div>
  );
}

function TokenStat({ label, value, subtle }) {
  return (
    <div>
      <div className="micro">{label}</div>
      <div className="mono" style={{
        fontSize: 13, fontWeight: 500, color: subtle ? 'var(--ink-1)' : 'var(--ink)',
        textTransform: 'none', letterSpacing: -0.01, marginTop: 2,
      }}>{value}</div>
    </div>
  );
}

function Sparkline({ accent }) {
  const bars = [3, 5, 4, 7, 8, 6, 9, 12, 11, 14, 16, 15, 19, 22, 20, 24, 27, 30, 28, 33];
  const max = Math.max(...bars);
  return (
    <div style={{
      height: 36, marginTop: 10,
      display: 'flex', alignItems: 'flex-end', gap: 2,
    }}>
      {bars.map((h, i) => (
        <span key={i} style={{
          flex: 1,
          height: `${(h / max) * 100}%`,
          background: `var(--${accent})`,
          opacity: 0.35 + (i / bars.length) * 0.55,
          borderRadius: 1,
        }} />
      ))}
    </div>
  );
}

function ToolsBlock({ accent }) {
  const tools = [
    { tool: 'Bash',  arg: 'rspec test/payments_spec.rb', meta: '2.4s · ok' },
    { tool: 'Edit',  arg: 'test/payments_spec.rb',       meta: '+4 −2'    },
    { tool: 'Read',  arg: 'lib/payments/retry_budget.rb',meta: '8ms'      },
    { tool: 'Read',  arg: 'test/payments_spec.rb',       meta: '12ms'     },
    { tool: 'Glob',  arg: '**/payments_spec.rb',         meta: '3ms · 1'  },
  ];
  return (
    <div>
      <SectionLabel action={
        <HF.Btn kind="quiet" size="sm" icon={<Icons.ChevronR size={11} />}>All</HF.Btn>
      }>Recent tools</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tools.map((t, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto',
            gap: 8, alignItems: 'baseline',
            padding: '5px 6px',
            borderRadius: 4,
          }}>
            <span style={{
              display: 'inline-block',
              padding: '1px 6px', borderRadius: 3,
              background: `color-mix(in oklch, var(--${accent}) 18%, transparent)`,
              color: `var(--${accent})`,
              fontFamily: "'Geist Mono', monospace", fontSize: 9,
              letterSpacing: 0.04, textTransform: 'uppercase',
            }}>{t.tool}</span>
            <span className="mono" style={{
              fontSize: 11, color: 'var(--ink-1)',
              textTransform: 'none', letterSpacing: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{t.arg}</span>
            <span className="mono" style={{
              fontSize: 10, color: 'var(--ink-2)',
              textTransform: 'none', letterSpacing: 0,
            }}>{t.meta}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspaceBlock({ container }) {
  const c = container;
  const fullPath = `${c.workspace}/${c.subdir}`;
  return (
    <div>
      <SectionLabel>Workspace</SectionLabel>
      <div style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--rule-soft)',
        borderRadius: 6,
        overflow: 'hidden',
      }}>
        <ActionRow
          label="Path"
          value={`/${c.subdir}`}
          mono
          icon={<Icons.Folder size={13} />}
          title={`Open ${fullPath} in Finder`}
        />
        <ActionRow
          label="Profile"
          value={c.profile}
          mono
          icon={<Icons.Key size={13} />}
          title="Manage profile keys"
        />
        <MetaRow label="Image"  value={c.image} mono />
        <MetaRow label="Limits" value={`${c.cpus} cpu · ${c.mem}`} mono />
      </div>
    </div>
  );
}

// A meta row that's clickable: hover surfaces the action icon and a
// background tint. Used for entries that map to a real OS / app action
// (open in Finder, open Profiles dialog, etc.).
function ActionRow({ label, value, icon, mono, title }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 10, alignItems: 'center',
        width: '100%', textAlign: 'left',
        padding: '8px 10px',
        background: hover ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--rule-soft)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'inherit',
        transition: 'background 120ms ease',
      }}
    >
      <span className="micro" style={{ fontSize: 9, minWidth: 44 }}>{label}</span>
      <span style={{
        fontFamily: mono ? "'Geist Mono', monospace" : 'inherit',
        fontSize: 11, color: hover ? 'var(--ink)' : 'var(--ink-1)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textAlign: 'left',
        textDecoration: hover ? 'underline' : 'none',
        textUnderlineOffset: 3,
        textDecorationColor: 'var(--ink-3)',
      }}>{value}</span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 4,
        color: hover ? 'var(--ink)' : 'var(--ink-3)',
        transition: 'color 120ms ease, opacity 120ms ease',
        opacity: hover ? 1 : 0.55,
      }}>{icon}</span>
    </button>
  );
}

// Static meta row — same layout as ActionRow but without the action.
function MetaRow({ label, value, mono }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      gap: 10, alignItems: 'center',
      padding: '8px 10px',
      borderBottom: '1px solid var(--rule-soft)',
    }}>
      <span className="micro" style={{ fontSize: 9, minWidth: 44 }}>{label}</span>
      <span style={{
        fontFamily: mono ? "'Geist Mono', monospace" : 'inherit',
        fontSize: 11, color: 'var(--ink-1)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      <span style={{ width: 22 }} />
    </div>
  );
}

// ── Expanded · fleet aggregate ───────────────────────────────────────────

function RailFleet() {
  const total = HF.containers.reduce((a, b) => a + b.cost, 0);
  const fleetEvents = [
    { cid: 'c2', t: 'now',    tool: 'Bash', arg: 'rspec test/…',        meta: '2.4s'  },
    { cid: 'c1', t: '08s',    tool: 'Edit', arg: 'mdx-loader.tsx',      meta: '+12 −8'},
    { cid: 'c2', t: '24s',    tool: 'Edit', arg: 'payments_spec.rb',    meta: '+4 −2' },
    { cid: 'c3', t: '01m',    tool: 'Read', arg: 'tokens.css',          meta: '6ms'   },
    { cid: 'c1', t: '01m',    tool: 'Read', arg: 'mdx-loader.tsx',      meta: '8ms'   },
    { cid: 'c2', t: '02m',    tool: 'Grep', arg: 'retry_budget',        meta: '12ms · 4' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* total cost + stacked bar */}
      <div>
        <SectionLabel>Fleet · cost across 3 containers</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.02, lineHeight: 1 }}>
            ${total.toFixed(2)}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-2)' }}>last 24m</span>
        </div>
        <StackedShareBar />
      </div>

      {/* per-container */}
      <div>
        <SectionLabel>Containers</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {HF.containers.map((c) => <FleetContainerRow key={c.id} container={c} />)}
        </div>
      </div>

      {/* fleet activity */}
      <div>
        <SectionLabel action={
          <HF.Btn kind="quiet" size="sm" icon={<Icons.ChevronR size={11} />}>All</HF.Btn>
        }>Fleet activity</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {fleetEvents.map((e, i) => <FleetEventRow key={i} event={e} />)}
        </div>
      </div>
    </div>
  );
}

function StackedShareBar() {
  const total = HF.containers.reduce((a, b) => a + b.cost, 0);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        height: 8, borderRadius: 4, overflow: 'hidden',
        display: 'flex', background: 'var(--bg-2)',
      }}>
        {HF.containers.map((c) => (
          <span key={c.id} style={{
            flex: c.cost,
            background: `var(--${c.accent})`,
            opacity: 0.92,
          }} title={`${c.name} · $${c.cost.toFixed(2)}`} />
        ))}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginTop: 6,
        fontFamily: "'Geist Mono', monospace", fontSize: 10, color: 'var(--ink-2)',
      }}>
        {HF.containers.map((c) => (
          <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <HF.ContainerBadge id={c.id} size={8} />
            <span>{Math.round((c.cost / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function FleetContainerRow({ container }) {
  const c = container;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '14px 1fr auto 8px',
      gap: 10, alignItems: 'center',
      padding: '8px 6px',
      borderRadius: 4,
      cursor: 'pointer',
    }}>
      <HF.ContainerBadge id={c.id} size={11} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 500,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{c.name}</div>
        <div className="mono" style={{
          fontSize: 10, color: c.status === 'needs-input' ? 'var(--danger)' : 'var(--ink-2)',
          textTransform: 'none', letterSpacing: 0.01, marginTop: 1,
        }}>{c.statusText}</div>
      </div>
      <span className="mono" style={{
        fontSize: 11, color: 'var(--ink)',
        textTransform: 'none', letterSpacing: 0,
      }}>${c.cost.toFixed(2)}</span>
      <HF.StatusDot status={c.status} size={7} />
    </div>
  );
}

function FleetEventRow({ event }) {
  const e = event;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '10px 36px auto 1fr auto',
      gap: 6, alignItems: 'baseline',
      padding: '4px 6px',
      borderRadius: 3,
      fontFamily: "'Geist Mono', monospace", fontSize: 10,
      letterSpacing: 0.01,
    }}>
      <HF.ContainerBadge id={e.cid} size={8} />
      <span style={{ color: 'var(--ink-3)' }}>{e.t}</span>
      <span style={{
        padding: '1px 5px', borderRadius: 3,
        background: `color-mix(in oklch, var(--${e.cid}) 18%, transparent)`,
        color: `var(--${e.cid})`,
        fontSize: 9, textTransform: 'uppercase',
      }}>{e.tool}</span>
      <span style={{
        color: 'var(--ink-1)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{e.arg}</span>
      <span style={{ color: 'var(--ink-2)' }}>{e.meta}</span>
    </div>
  );
}

// ── Collapsed strip ──────────────────────────────────────────────────────

function ObsRailCollapsed({ scope, container, onExpand }) {
  const isFleet = scope === 'fleet';
  const accent = isFleet ? 'ok' : container.accent;
  const total = HF.containers.reduce((a, b) => a + b.cost, 0);

  return (
    <aside style={{
      borderLeft: '1px solid var(--rule)',
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '12px 0 16px',
      gap: 12,
    }}>
      <HF.Btn kind="secondary" size="sm" icon={<Icons.ChevronL size={13} />} onClick={onExpand} style={{ width: 32, padding: 0 }} />

      <div className="micro" style={{
        color: isFleet ? 'var(--ok)' : `var(--${accent})`,
        fontSize: 9,
      }}>{isFleet ? 'Fleet' : 'This'}</div>

      <div style={{ textAlign: 'center' }}>
        <div className="mono" style={{
          fontSize: 14, fontWeight: 600, color: 'var(--ink)',
          textTransform: 'none', letterSpacing: -0.01,
        }}>${(isFleet ? total : container.cost).toFixed(2)}</div>
        <div className="micro" style={{ fontSize: 9, marginTop: 1 }}>cost</div>
      </div>

      <Sparkline accent={accent} />

      {isFleet ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          {HF.containers.map((c) => (
            <HF.ContainerBadge key={c.id} id={c.id} size={11} />
          ))}
        </div>
      ) : (
        <>
          <Stat label="in"  value="12k" />
          <Stat label="out" value="4k"  />
        </>
      )}

      <div style={{ height: 1, background: 'var(--rule-soft)', width: 32 }} />

      <Stat label="rd" value={isFleet ? '24' : '12'} />
      <Stat label="ed" value={isFleet ? '7'  : '4'} />
      <Stat label="rn" value={isFleet ? '3'  : '2'} />

      <div style={{ flex: 1 }} />
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: isFleet ? 'var(--ok)' : `var(--${accent})`,
        animation: 'hifiBlink 1.6s ease-in-out infinite',
      }} />
    </aside>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 32 }}>
      <div className="mono" style={{
        fontSize: 13, fontWeight: 600, color: 'var(--ink)',
        textTransform: 'none', letterSpacing: -0.01,
      }}>{value}</div>
      <div className="micro" style={{ fontSize: 9, marginTop: 1 }}>{label}</div>
    </div>
  );
}

Object.assign(window, { ObsRail });
