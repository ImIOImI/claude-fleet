// Hi-fi modals, overlays, empty states.
//
// Each screen renders the live HiFiApp shell behind a dim scrim so the
// modal reads in context (matches wireframe behaviour). Empty / daemon-down
// states replace the shell entirely.

// ── Modal primitives ─────────────────────────────────────────────────────

function ModalScrim({ children }) {
  return (
    <>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(2px)',
        animation: 'hifiSlideUp 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }} />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid', placeItems: 'center',
        animation: 'hifiSlideUp 280ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>{children}</div>
    </>
  );
}

function ModalShell({ title, subtitle, icon, width = 520, children, footer, onClose }) {
  return (
    <div style={{
      width, maxWidth: '92%',
      background: 'var(--bg-card)',
      border: '1px solid var(--rule)',
      borderRadius: 12,
      boxShadow: 'var(--shadow-lg)',
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      maxHeight: '88%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px',
        borderBottom: '1px solid var(--rule-soft)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {icon && (
            <div style={{
              width: 28, height: 28, borderRadius: 7,
              display: 'grid', placeItems: 'center',
              background: 'var(--bg-2)', border: '1px solid var(--rule-soft)',
              color: 'var(--ink-1)',
            }}>{icon}</div>
          )}
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.01 }}>{title}</div>
            {subtitle && <div className="micro" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
        </div>
        <HF.Btn kind="quiet" size="sm" icon={<Icons.X size={12} />} onClick={onClose} />
      </div>
      <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>{children}</div>
      {footer && (
        <div style={{
          padding: '12px 18px',
          background: 'var(--bg-1)',
          borderTop: '1px solid var(--rule-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
        }}>{footer}</div>
      )}
    </div>
  );
}

// ── Form primitives ──────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div className="micro" style={{ marginBottom: 6 }}>{label}</div>
      {children}
      {hint && (
        <div style={{
          fontSize: 11, color: 'var(--ink-2)', marginTop: 5, lineHeight: 1.5,
        }}>{hint}</div>
      )}
    </label>
  );
}

function Input({ value, placeholder, mono = false, right }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      height: 34, padding: '0 11px',
      background: 'var(--bg-1)',
      border: '1px solid var(--rule)',
      borderRadius: 6,
    }}>
      <span style={{
        flex: 1, minWidth: 0,
        fontFamily: mono ? "'Geist Mono', monospace" : 'inherit',
        fontSize: 12.5,
        color: value ? 'var(--ink)' : 'var(--ink-3)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value || placeholder}</span>
      {right}
    </div>
  );
}

function Select({ value, options }) {
  return (
    <Input value={value} right={<Icons.ChevronD size={12} style={{ color: 'var(--ink-2)' }} />} />
  );
}

// ── Toggle (settings) ────────────────────────────────────────────────────
// A pill-style switch. Goes accent color when on. Disabled state dims and
// shows a lock cue elsewhere in the surrounding markup.
function Toggle({ value, onChange, disabled, accent = 'c2' }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onChange && onChange(!value)}
      style={{
        position: 'relative',
        width: 36, height: 20,
        borderRadius: 999,
        background: value ? `var(--${accent})` : 'var(--bg-2)',
        border: `1px solid ${value ? `var(--${accent})` : 'var(--rule)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 160ms ease, border-color 160ms ease',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 1,
        left: value ? 17 : 1,
        width: 16, height: 16, borderRadius: '50%',
        background: value ? '#fff' : 'var(--bg-card)',
        boxShadow: 'var(--shadow-sm)',
        transition: 'left 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      }} />
    </button>
  );
}

// ── Terminal settings modal ──────────────────────────────────────────────
//
// Surfaced from the hamburger button in the terminal tab strip. Shows the
// settings for the currently-active terminal. Today there's one: the
// transcript mirror toggle, which is per-session and locked once the PTY
// has attached. The modal communicates that lock state clearly and offers
// a CTA to open a fresh terminal with the new setting.
function TerminalSettingsModal({ container, terminal, onClose }) {
  // Local interactive state: the user can flip the toggle in the mockup,
  // but the lock note still applies for the active session. The intent is
  // documented above the toggle so the lock isn't surprising.
  const [mirrored, setMirrored] = React.useState(!!terminal.mirrored);
  const sessionId = terminal.id.replace(container.id + '-', 's-');
  const mirrorPath = `/workspace/_history/${sessionId}.jsonl`;

  return (
    <ModalShell
      title="Terminal settings"
      subtitle={`${container.name} · ${terminal.name}`}
      icon={<Icons.Terminal size={15} />}
      width={560}
      onClose={onClose}
      footer={<>
        <HF.Btn kind="ghost" size="md" onClick={onClose}>Done</HF.Btn>
        <HF.Btn kind="primary" size="md" icon={<Icons.Plus size={13} />}>
          New terminal with these
        </HF.Btn>
      </>}
    >
      {/* The session-lock notice — explains why some controls below are
          locked even though the toggle remains visually interactive. */}
      <LockNotice terminal={terminal} mirrored={mirrored} />

      <SettingCard>
        <SettingHead>
          <SettingTitle
            icon={<Icons.History size={14} />}
            title="Save transcript history"
            badge={mirrored ? 'on for this session' : 'off for this session'}
            badgeTone={mirrored ? 'ok' : 'muted'}
          />
          <Toggle
            value={mirrored}
            onChange={setMirrored}
            accent={container.accent}
          />
        </SettingHead>
        <SettingBody>
          Mirror every event Claude emits to an append-only file. Pre-compaction
          turns stay readable for you and the agent even after <Mono>claude</Mono>
          compacts its working transcript.
        </SettingBody>
        <SettingMeta>
          <Icons.Folder size={11} />
          <Mono>{mirrorPath}</Mono>
        </SettingMeta>
      </SettingCard>

      <Hint>
        Per-session setting. Choice is locked once the PTY attaches so early
        turns aren't silently missed.
      </Hint>
    </ModalShell>
  );
}

// ── Close-terminal confirmation modal ────────────────────────────────────
//
// Shown when the user clicks the × on a terminal tab. Confirms the close
// and — if the terminal has been recording a durable transcript mirror —
// offers to delete the mirror file alongside (default: yes, with size and
// event count called out). If the terminal wasn't mirroring, the modal
// degrades to a plain confirm.
function CloseTerminalModal({ container, terminal, onClose, onConfirm }) {
  const [deleteMirror, setDeleteMirror] = React.useState(true);
  const isMirrored = !!terminal.mirrored;
  const sessionId = terminal.id.replace(container.id + '-', 's-');
  const mirrorPath = `/workspace/_history/${sessionId}.jsonl`;

  const primaryLabel = isMirrored && deleteMirror
    ? 'Close & delete history'
    : 'Close terminal';

  return (
    <ModalShell
      title="Close terminal"
      subtitle={`${container.name} · ${terminal.name}`}
      icon={<Icons.X size={14} />}
      width={520}
      onClose={onClose}
      footer={<>
        <HF.Btn kind="ghost" size="md" onClick={onClose}>Cancel</HF.Btn>
        <HF.Btn kind={isMirrored && deleteMirror ? 'danger' : 'primary'} size="md" onClick={onConfirm}>
          {primaryLabel}
        </HF.Btn>
      </>}
    >
      <div style={{ fontSize: 13, color: 'var(--ink-1)', lineHeight: 1.55, marginBottom: 14, textWrap: 'pretty' }}>
        Detach the PTY and stop <Mono>claude</Mono> in this terminal. The container
        keeps running — open a new terminal anytime.
      </div>

      {isMirrored ? (
        <MirrorDeleteCard
          terminal={terminal}
          mirrorPath={mirrorPath}
          checked={deleteMirror}
          onChange={setDeleteMirror}
          accent={container.accent}
        />
      ) : (
        <Hint>
          No durable history was recorded for this terminal — nothing on disk
          to clean up.
        </Hint>
      )}
    </ModalShell>
  );
}

function MirrorDeleteCard({ terminal, mirrorPath, checked, onChange, accent }) {
  return (
    <SettingCard>
      <SettingHead>
        <SettingTitle
          icon={<Icons.History size={14} />}
          title="Also delete saved transcript history"
          badge={`${HF.fmtBytes(terminal.mirrorSize)} · ${terminal.mirrorEvents.toLocaleString()} events`}
          badgeTone="muted"
        />
        <Toggle value={checked} onChange={onChange} accent="c2" />
      </SettingHead>
      <SettingBody>
        Removes the durable mirror file from <Mono>_history/</Mono>. Pre-compaction
        turns will no longer be recoverable. Keep the file if you might want to
        resume or audit this session later.
      </SettingBody>
      <SettingMeta>
        <Icons.Folder size={11} />
        <Mono>{mirrorPath}</Mono>
      </SettingMeta>
    </SettingCard>
  );
}

function SettingCard({ children }) {
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--rule-soft)',
      borderRadius: 8,
      padding: 14,
      marginBottom: 14,
    }}>{children}</div>
  );
}

function SettingHead({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 14, marginBottom: 8,
    }}>{children}</div>
  );
}

function SettingTitle({ icon, title, badge, badgeTone }) {
  const tone = badgeTone === 'ok'    ? 'var(--ok)'
             : badgeTone === 'warn'  ? 'var(--warn)'
             : badgeTone === 'danger'? 'var(--danger)'
             :                         'var(--ink-2)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--ink-1)' }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.01 }}>{title}</span>
      </div>
      {badge && (
        <span className="mono" style={{
          fontSize: 10, color: tone, letterSpacing: 0.02,
          textTransform: 'none',
        }}>● {badge}</span>
      )}
    </div>
  );
}

function SettingBody({ children }) {
  return (
    <div style={{
      fontSize: 12, color: 'var(--ink-1)', lineHeight: 1.55,
      marginTop: 2, marginBottom: 10, textWrap: 'pretty',
    }}>{children}</div>
  );
}

function SettingMeta({ children }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 10px', borderRadius: 5,
      background: 'var(--bg-2)', border: '1px solid var(--rule-soft)',
      color: 'var(--ink-2)',
      fontSize: 11,
    }}>{children}</div>
  );
}

function Mono({ children }) {
  return (
    <span style={{
      fontFamily: "'Geist Mono', monospace",
      fontSize: 11, color: 'var(--ink-1)',
    }}>{children}</span>
  );
}

function Hint({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '10px 12px', borderRadius: 6,
      background: 'transparent',
      border: '1px dashed var(--rule)',
      color: 'var(--ink-2)', fontSize: 11.5, lineHeight: 1.5,
    }}>
      <Icons.Info size={13} style={{ marginTop: 2, flexShrink: 0 }} />
      <span>{children}</span>
    </div>
  );
}

function LockNotice({ terminal, mirrored }) {
  // If the live setting matches what the user is changing, no warning.
  // If they're flipping the toggle, surface the lock context.
  const drifted = mirrored !== !!terminal.mirrored;
  if (!drifted) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '10px 12px', borderRadius: 6,
      marginBottom: 14,
      background: 'color-mix(in oklch, var(--warn) 14%, transparent)',
      border: '1px solid color-mix(in oklch, var(--warn) 45%, transparent)',
      color: 'var(--warn)',
      fontSize: 11.5, lineHeight: 1.5,
    }}>
      <Icons.Lock size={13} style={{ marginTop: 2, flexShrink: 0 }} />
      <span style={{ color: 'var(--ink)' }}>
        Active terminal · this change applies to a new terminal you open in <b>{terminal.name === 'main' ? 'this container' : terminal.name}</b>.
        The running session keeps its existing setting.
      </span>
    </div>
  );
}

// ── A · Create container modal ───────────────────────────────────────────

function CreateContainerScreen({ mode }) {
  return (
    <HiFiAppWithOverlay mode={mode}>
      <ModalShell
        title="New container"
        subtitle="Spin up a runner pointing at a workspace"
        icon={<Icons.Container size={15} />}
        width={580}
        footer={<>
          <HF.Btn kind="ghost" size="md">Cancel</HF.Btn>
          <HF.Btn kind="primary" size="md" icon={<Icons.Plus size={13} />}>Create &amp; start</HF.Btn>
        </>}
      >
        <Field label="Name">
          <Input value="docs-refactor" />
        </Field>

        <Field label="Workspace root" hint="Bind-mounted at /workspace inside the container.">
          <Input
            mono
            value="/Users/sam/code/sumer-monorepo"
            right={<HF.Btn kind="secondary" size="sm" icon={<Icons.Folder size={12} />}>Browse</HF.Btn>}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="Subdir" hint="claude runs from /workspace/<subdir>">
            <Input mono value="apps/docs" />
          </Field>
          <Field label="Profile" hint="API key from OS keychain">
            <Select value="work" />
          </Field>
        </div>

        <details style={{ marginTop: 4 }}>
          <summary style={{
            display: 'flex', alignItems: 'center', gap: 6,
            cursor: 'pointer', listStyle: 'none',
            padding: '8px 0',
            fontSize: 11.5, color: 'var(--ink-1)', fontWeight: 500,
          }}>
            <Icons.ChevronR size={11} />
            <span>Resource caps (optional)</span>
          </summary>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
            padding: '8px 0 4px',
          }}>
            <Field label="CPUs"><Input mono value="2.0" /></Field>
            <Field label="Memory"><Input mono value="4096 MB" /></Field>
          </div>
        </details>
      </ModalShell>
    </HiFiAppWithOverlay>
  );
}

// ── B · Profiles dialog ──────────────────────────────────────────────────

function ProfilesScreen({ mode }) {
  return (
    <HiFiAppWithOverlay mode={mode}>
      <ModalShell
        title="Profiles"
        subtitle="API keys stored in the OS keychain"
        icon={<Icons.Key size={15} />}
        width={620}
        footer={<>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icons.Info size={12} style={{ color: 'var(--ink-2)' }} />
            <span style={{ fontSize: 11, color: 'var(--ink-2)' }}>
              Keys never touch the renderer process or disk in plaintext.
            </span>
          </div>
          <HF.Btn kind="ghost" size="md">Done</HF.Btn>
        </>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {HF.profiles.map((p) => (
            <div key={p.name} style={{
              display: 'grid', gridTemplateColumns: 'auto 1fr auto',
              gap: 14, alignItems: 'center',
              padding: '12px 14px',
              background: 'var(--bg-1)',
              border: '1px solid var(--rule-soft)',
              borderRadius: 8,
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'var(--bg-2)', border: '1px solid var(--rule)',
                display: 'grid', placeItems: 'center', color: 'var(--ink-1)',
              }}>
                <Icons.Key size={14} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.01 }}>{p.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-2)', marginTop: 2, textTransform: 'none', letterSpacing: 0 }}>
                  {p.hint} {p.used.length > 0 && <>· used by {p.used.join(', ')}</>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <HF.Btn kind="ghost" size="sm">Edit</HF.Btn>
                <HF.Btn kind="quiet" size="sm" icon={<Icons.Trash size={12} />} style={{ color: 'var(--danger)' }} />
              </div>
            </div>
          ))}
        </div>

        <div style={{
          padding: 14, borderRadius: 8,
          border: '1px dashed var(--rule)',
          background: 'transparent',
        }}>
          <div className="micro" style={{ marginBottom: 10 }}>Add profile</div>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 10, alignItems: 'flex-end' }}>
            <Field label="Name"><Input placeholder="staging" /></Field>
            <Field label="API key"><Input placeholder="sk-ant-…" mono /></Field>
            <div style={{ marginBottom: 16 }}>
              <HF.Btn kind="primary" size="md">Save</HF.Btn>
            </div>
          </div>
        </div>
      </ModalShell>
    </HiFiAppWithOverlay>
  );
}

// ── C · Drop overlay + toast ─────────────────────────────────────────────

function DropScreen({ mode }) {
  return (
    <div className="hifi-root" data-theme={mode} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <HiFiApp mode={mode} />

      {/* drag-over overlay */}
      <div style={{
        position: 'absolute', inset: 14,
        borderRadius: 12,
        border: '2px dashed var(--c2)',
        background: 'color-mix(in oklch, var(--c2) 18%, transparent)',
        display: 'grid', placeItems: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--c2)',
          borderRadius: 12,
          padding: '20px 26px',
          textAlign: 'center',
          boxShadow: 'var(--shadow-lg)',
          minWidth: 280,
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 40, borderRadius: 12,
            background: 'var(--c2-soft)', color: 'var(--c2)',
            margin: '0 auto 10px',
          }}>
            <Icons.Upload size={18} />
          </div>
          <div className="micro" style={{ color: 'var(--c2)', marginBottom: 4 }}>Drop to add to</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.02 }}>api-tests / _dropped</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 6, textTransform: 'none', letterSpacing: 0 }}>
            3 files · 2.4 MB
          </div>
        </div>
      </div>

      {/* post-drop toast stack */}
      <ToastStack>
        <Toast
          tone="ok"
          icon={<Icons.Check size={13} />}
          title="3 files saved to _dropped"
          body="Path copied to clipboard. Paste it into your next prompt."
          actions={<>
            <HF.Btn kind="ghost" size="sm">Show</HF.Btn>
            <HF.Btn kind="quiet" size="sm">Undo</HF.Btn>
          </>}
        />
      </ToastStack>
    </div>
  );
}

function ToastStack({ children }) {
  return (
    <div style={{
      position: 'absolute', bottom: 44, right: 312,
      display: 'flex', flexDirection: 'column', gap: 8,
      maxWidth: 380, width: 380,
    }}>{children}</div>
  );
}

function Toast({ tone = 'info', icon, title, body, actions }) {
  const accent = {
    ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)',
    info: 'var(--info)', container: 'var(--c2)',
  }[tone] || 'var(--ink)';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12,
      padding: '12px 14px',
      background: 'var(--bg-card)',
      border: '1px solid var(--rule)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
      boxShadow: 'var(--shadow)',
      animation: 'hifiSlideUp 220ms cubic-bezier(0.16, 1, 0.3, 1)',
    }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 6,
        background: `color-mix(in oklch, ${accent} 18%, transparent)`,
        color: accent,
        marginTop: 1,
      }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: -0.005 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-1)', marginTop: 3, lineHeight: 1.4 }}>{body}</div>
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>{actions}</div>}
    </div>
  );
}

// ── D · Resume (container gone) ──────────────────────────────────────────

function ResumeScreen({ mode }) {
  return (
    <HiFiAppWithOverlay mode={mode}>
      <ModalShell
        title="Resume session"
        subtitle="The container that ran this session is gone"
        icon={<Icons.Refresh size={15} />}
        width={580}
        footer={<>
          <HF.Btn kind="ghost" size="md">Cancel</HF.Btn>
          <HF.Btn kind="secondary" size="md">Resume in existing…</HF.Btn>
          <HF.Btn kind="primary" size="md" icon={<Icons.Play size={12} />}>Recreate &amp; resume</HF.Btn>
        </>}
      >
        <div style={{
          padding: 14, borderRadius: 8,
          background: 'var(--bg-1)',
          border: '1px solid var(--rule-soft)',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <HF.ContainerBadge id="c1" size={14} />
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
              Refactor MDX loader to use streaming
            </div>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr',
            gap: '6px 12px', alignItems: 'baseline',
          }}>
            <span className="micro" style={{ fontSize: 9 }}>Session</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink)', textTransform: 'none', letterSpacing: 0 }}>s-b · 14m ago · $0.42 · 8 tools</span>
            <span className="micro" style={{ fontSize: 9 }}>Container</span>
            <span style={{ fontSize: 11, color: 'var(--ink)' }}>
              <span style={{ color: 'var(--ink-1)' }}>docs-refactor</span>{' '}
              <span style={{ color: 'var(--ink-3)' }}>(deleted 2h ago)</span>
            </span>
            <span className="micro" style={{ fontSize: 9 }}>Workspace</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>/workspace/apps/docs</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ok)' }}>
                <HF.StatusDot status="running" size={5} animated={false} />
                <span style={{ fontSize: 10 }}>exists</span>
              </span>
            </span>
            <span className="micro" style={{ fontSize: 9 }}>Profile</span>
            <span style={{ fontSize: 11, color: 'var(--ink)' }}>work</span>
          </div>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--ink-1)', lineHeight: 1.55, marginBottom: 14 }}>
          claude-fleet can recreate the container from the saved profile and workspace,
          then resume with{' '}
          <span className="mono" style={{
            background: 'var(--bg-2)', border: '1px solid var(--rule-soft)',
            padding: '1px 6px', borderRadius: 3,
            fontSize: 11, textTransform: 'none', letterSpacing: 0,
            color: 'var(--ink)',
          }}>claude --resume s-b</span>.
        </div>

        <div style={{
          padding: '10px 12px',
          border: '1px dashed var(--rule)',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
        }}>
          <div className="micro">New container name</div>
          <span className="mono" style={{
            fontSize: 12, color: 'var(--ink)',
            textTransform: 'none', letterSpacing: 0,
          }}>docs-refactor</span>
        </div>
      </ModalShell>
    </HiFiAppWithOverlay>
  );
}

// ── E · Empty states (daemon down + first run) ───────────────────────────

function EmptyScreen({ mode, kind = 'daemon' }) {
  return (
    <div className="hifi-root" data-theme={mode} style={{
      width: '100%', height: '100%',
      background: 'var(--bg)',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
    }}>
      <EmptyHalf
        title="Docker daemon unreachable"
        body="Start Docker Desktop (with WSL2 integration on Windows). claude-fleet will reconnect automatically once it's back."
        icon={<Icons.Alert size={22} />}
        tone="danger"
        cta="Retry connection"
        meta="Last seen 14s ago"
      />
      <EmptyHalf
        title="No containers yet"
        body="Each container runs claude in an isolated Docker workspace. Spin up your first to get started."
        icon={<Icons.Container size={22} />}
        tone="info"
        cta="+ New container"
        meta="You'll need a workspace folder and an API key"
      />
    </div>
  );
}

function EmptyHalf({ title, body, icon, tone, cta, meta }) {
  const accent = tone === 'danger' ? 'var(--danger)' : 'var(--ink-1)';
  return (
    <div style={{
      borderRight: '1px solid var(--rule-soft)',
      display: 'grid', placeItems: 'center', padding: 60,
      position: 'relative',
    }}>
      {/* subtle decorative grid */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `linear-gradient(to right, var(--rule-soft) 1px, transparent 1px),
                          linear-gradient(to bottom, var(--rule-soft) 1px, transparent 1px)`,
        backgroundSize: '40px 40px',
        maskImage: 'radial-gradient(closest-side, black 40%, transparent 90%)',
        opacity: 0.5,
      }} />

      <div style={{ position: 'relative', textAlign: 'center', maxWidth: 380 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: 14,
          background: tone === 'danger' ? 'color-mix(in oklch, var(--danger) 12%, transparent)' : 'var(--bg-2)',
          color: accent,
          marginBottom: 16,
          border: '1px solid var(--rule)',
        }}>{icon}</div>
        <div className="micro" style={{
          color: tone === 'danger' ? 'var(--danger)' : 'var(--ink-2)',
          marginBottom: 8,
        }}>{tone === 'danger' ? '● Disconnected' : 'First run'}</div>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.02, marginBottom: 10, textWrap: 'pretty' }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-1)', lineHeight: 1.55, marginBottom: 22, textWrap: 'pretty' }}>
          {body}
        </div>
        <HF.Btn kind="primary" size="lg">{cta}</HF.Btn>
        {meta && (
          <div className="mono" style={{
            fontSize: 10.5, color: 'var(--ink-3)', marginTop: 14,
            textTransform: 'none', letterSpacing: 0.02,
          }}>{meta}</div>
        )}
      </div>
    </div>
  );
}

// ── Helper: App + overlay scrim ──────────────────────────────────────────

function HiFiAppWithOverlay({ mode, children }) {
  return (
    <div className="hifi-root" data-theme={mode} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <HiFiApp mode={mode} />
      <ModalScrim>{children}</ModalScrim>
    </div>
  );
}

Object.assign(window, {
  CreateContainerScreen, ProfilesScreen, DropScreen, ResumeScreen, EmptyScreen,
  HiFiAppWithOverlay,
  // primitives + reusable modals
  ModalScrim, ModalShell, Toggle, TerminalSettingsModal, CloseTerminalModal,
});
