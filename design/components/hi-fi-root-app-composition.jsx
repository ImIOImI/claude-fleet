// Hi-fi root app composition.
//
// Owns the top-level state (selected container, selected session, rail
// collapsed/scope, theme mode) and lays out the grid:
//
//   ┌────────────────────────────────────────────────────────┐
//   │ TopBar (brand · container chips · global actions)      │
//   ├──────────┬──────────────────────────────────┬──────────┤
//   │ Sessions │ Terminal (tabs + body)           │ Obs rail │
//   ├──────────┴──────────────────────────────────┴──────────┤
//   │ StatusBar (daemon · hints · shortcuts)                 │
//   └────────────────────────────────────────────────────────┘

function HiFiApp({ mode, initialCollapsed = false, initialScope = 'container', initialContainer = 'c2', initialModal = null }) {
  const [selectedId, setSelectedId] = React.useState(initialContainer);
  const [selectedSessionId, setSelectedSessionId] = React.useState('s-a');
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const [scope, setScope] = React.useState(initialScope);
  const [modal, setModal] = React.useState(initialModal);
  // When closing, the user clicks × on a tab that may not be the active one.
  // Remember which terminal they targeted so the confirm modal can show its
  // mirror state, not the active terminal's.
  const [closingTerminalId, setClosingTerminalId] = React.useState(null);

  // One active terminal per container. Defaults to the first terminal in
  // each container — and persists across switches so flipping c1 → c2 → c1
  // returns to whatever terminal the user was last looking at.
  const [activeTerminalByContainer, setActiveTerminalByContainer] = React.useState(() =>
    Object.fromEntries(HF.containers.map((c) => [c.id, c.terminals[0].id]))
  );
  const activeTerminalId = activeTerminalByContainer[selectedId];
  const setActiveTerminal = (terminalId) =>
    setActiveTerminalByContainer((m) => ({ ...m, [selectedId]: terminalId }));

  // Keep state in sync when artboards remount the app with different
  // initial props (so canvas variants render the right state).
  React.useEffect(() => setCollapsed(initialCollapsed), [initialCollapsed]);
  React.useEffect(() => setScope(initialScope), [initialScope]);
  React.useEffect(() => setSelectedId(initialContainer), [initialContainer]);
  React.useEffect(() => {
    setModal(initialModal);
    // The "close-terminal" artboard wants to demonstrate the modal against
    // a terminal that has an active mirror to delete. Default to c2-review.
    if (initialModal === 'close-terminal') setClosingTerminalId('c2-review');
  }, [initialModal]);

  // The container we hand down to chips/chips/etc gets the active-terminal
  // id stamped on so the chip can highlight which pip is "current."
  const container = { ...HF.containerById(selectedId), activeTerminalId };
  const activeTerminal = container.terminals.find((t) => t.id === activeTerminalId) || container.terminals[0];

  return (
    <HF.ThemeCtx.Provider value={{ mode }}>
      <div
        className="hifi-root"
        data-theme={mode}
        style={{
          width: '100%', height: '100%',
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto',
          background: 'var(--bg)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <TopBar
          selectedId={selectedId}
          activeTerminalByContainer={activeTerminalByContainer}
          onSelect={setSelectedId}
        />

        <main style={{
          display: 'grid',
          gridTemplateColumns: `260px 1fr ${collapsed ? 60 : 296}px`,
          minHeight: 0,
          transition: 'grid-template-columns 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
          <SessionsPanel
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
          />
          <TerminalPane
            container={container}
            activeTerminalId={activeTerminalId}
            onSelectTerminal={setActiveTerminal}
            onCloseTerminal={(tid) => { setClosingTerminalId(tid); setModal('close-terminal'); }}
            onOpenSettings={() => setModal('terminal-settings')}
          />
          <ObsRail
            collapsed={collapsed}
            scope={scope}
            container={container}
            onToggleCollapsed={() => setCollapsed((v) => !v)}
            onScope={setScope}
          />
        </main>

        <StatusBar container={container} scope={scope} />

        {modal === 'terminal-settings' && (
          <ModalScrim>
            <TerminalSettingsModal
              container={container}
              terminal={activeTerminal}
              onClose={() => setModal(null)}
            />
          </ModalScrim>
        )}

        {modal === 'close-terminal' && (() => {
          const closing = container.terminals.find((t) => t.id === closingTerminalId) || activeTerminal;
          return (
            <ModalScrim>
              <CloseTerminalModal
                container={container}
                terminal={closing}
                onClose={() => { setModal(null); setClosingTerminalId(null); }}
                onConfirm={() => { setModal(null); setClosingTerminalId(null); }}
              />
            </ModalScrim>
          );
        })()}
      </div>
    </HF.ThemeCtx.Provider>
  );
}

function StatusBar({ container, scope }) {
  return (
    <footer style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto 1fr',
      alignItems: 'center',
      gap: 12,
      padding: '0 14px',
      height: 28,
      borderTop: '1px solid var(--rule)',
      background: 'var(--bg)',
      fontFamily: "'Geist Mono', monospace",
      fontSize: 10,
      letterSpacing: 0.01,
      color: 'var(--ink-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <HF.StatusDot status="running" size={6} animated={false} />
          <span>Docker ok</span>
        </span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span>{container.workspace}</span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span>{HF.containers.filter((c) => c.status === 'needs-input').length} need input</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-2)' }}>
        <Icons.Upload size={11} />
        <span>Drop files anywhere</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <HF.Kbd>⌘K</HF.Kbd> command
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <HF.Kbd>⌘1</HF.Kbd><HF.Kbd>⌘2</HF.Kbd><HF.Kbd>⌘3</HF.Kbd> switch
        </span>
      </div>
    </footer>
  );
}

Object.assign(window, { HiFiApp });
