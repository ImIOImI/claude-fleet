// One vault key: collapsed summary row plus its per-workspace lines.
// Presentational — every mutation is a callback, so the workspace form can
// stage edits instead of calling vault:* directly.
import { useEffect, useRef, useState } from 'react';
import { FLEET_KEYS } from '../../../preload/fleetKeys';
import type { VaultEntry, VaultLine } from '../../../preload/vaultTypes';
import { pendingLabel, publishableWorkspaces } from '../vaultView';
import { IconEye, IconEyeOff, RevealRing } from './RevealIcons';
import { createSecretRevealer, REVEAL_SECONDS, type RevealState } from './secretReveal';
import { VaultKeyForm, type VaultKeySubmit } from './VaultKeyForm';

type LineEdit = { mode: 'inherit' } | { mode: 'override'; value: string };

export interface VaultKeyRowProps {
  entry: VaultEntry;
  names: Record<string, string>;
  kinds: Record<string, 'container' | 'local' | 'remote'>;
  workspaces: { id: string; name: string; kind: string }[];
  /** Shows only this workspace's line and hides the publish picker. */
  scopeWorkspaceId?: string;
  readOnly?: boolean;
  defaultOpen?: boolean;
  /** Tag autocomplete for the edit form. */
  tagOptions?: string[];
  reveal: (key: string, workspaceId: string | null) => Promise<string | null>;
  onEditKey?: (a: VaultKeySubmit) => Promise<void>;
  onDeleteKey?: () => Promise<void>;
  onSetLine: (workspaceId: string, line: LineEdit) => Promise<void>;
  onRemoveLine: (workspaceId: string) => Promise<void>;
}

const ROOT_SLOT = '';
const MASK = '••••••••';

function useReveals(entry: VaultEntry, reveal: VaultKeyRowProps['reveal']) {
  const [reveals, setReveals] = useState<Record<string, RevealState>>({});
  const fetchRef = useRef(reveal);
  fetchRef.current = reveal;
  const keyRef = useRef(entry.key);
  keyRef.current = entry.key;
  const [revealer] = useState(() =>
    createSecretRevealer({
      fetch: (slot) => fetchRef.current(keyRef.current, slot === ROOT_SLOT ? null : slot),
      onChange: (slot, state) =>
        setReveals((prev) => {
          const next = { ...prev };
          if (state) next[slot] = state;
          else delete next[slot];
          return next;
        })
    })
  );
  useEffect(() => () => revealer.hideAll(), [revealer]);
  // A revealed value goes stale once the entry changes underneath it.
  const signature = JSON.stringify(entry);
  useEffect(() => revealer.hideAll(), [revealer, signature]);
  const toggle = (slot: string): void => (revealer.isActive(slot) ? revealer.hide(slot) : revealer.reveal(slot));
  return { reveals, toggle };
}

function ValueCell({ secret, value, state, onToggle, label }: {
  secret: boolean;
  value?: string;
  state?: RevealState;
  onToggle: () => void;
  label: string;
}) {
  if (!secret) return <span className="vault-value plain" title={value}>{value ?? ''}</span>;
  const shown = state?.status === 'shown' ? state.value : null;
  return (
    <span className="vault-value">
      <span className={shown !== null ? 'vault-mask revealed' : 'vault-mask'}>{shown ?? MASK}</span>
      <button
        type="button"
        className={shown !== null ? 'env-reveal on' : 'env-reveal'}
        aria-label={`${shown !== null ? 'Hide' : 'Show'} ${label}`}
        aria-pressed={shown !== null}
        title={shown !== null ? 'Hide value' : `Show the saved value for ${REVEAL_SECONDS}s`}
        onClick={onToggle}
        disabled={state?.status === 'loading'}
      >
        {shown !== null ? <IconEyeOff /> : <IconEye />}
      </button>
      {state?.status === 'shown' && (
        <span className="vault-note warn" role="status">
          <RevealRing remainingS={state.remainingS} />
          {state.remainingS}s
        </span>
      )}
      {state?.status === 'loading' && <span className="vault-note" role="status">Loading…</span>}
      {state?.status === 'missing' && <span className="vault-note err" role="status">Not set</span>}
      {state?.status === 'error' && <span className="vault-note err" role="status">{state.message}</span>}
    </span>
  );
}

function IconLock({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.2" />
      <path d={open ? 'M5.5 7V4.5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7'} />
    </svg>
  );
}

export function VaultKeyRow(p: VaultKeyRowProps) {
  const { entry, readOnly, scopeWorkspaceId } = p;
  const [open, setOpen] = useState(!!p.defaultOpen);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [overriding, setOverriding] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState('');
  const [busy, setBusy] = useState(false);
  const { reveals, toggle } = useReveals(entry, p.reveal);

  const fleetKey = entry.fleet ? FLEET_KEYS.find((k) => k.key === entry.key) : undefined;
  const lines = scopeWorkspaceId ? entry.lines.filter((l) => l.workspaceId === scopeWorkspaceId) : entry.lines;
  const publishable = scopeWorkspaceId || readOnly ? [] : publishableWorkspaces(entry, p.workspaces);
  const locked = readOnly || busy;

  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startOverride = (ws: string): void => {
    setOverriding(ws);
    setOverrideValue('');
  };
  const saveOverride = async (ws: string): Promise<void> => {
    if (await run(() => p.onSetLine(ws, { mode: 'override', value: overrideValue }))) setOverriding(null);
  };

  const rootCell = entry.root.set ? (
    <ValueCell
      secret={entry.secret}
      value={entry.root.value}
      state={reveals[ROOT_SLOT]}
      onToggle={() => toggle(ROOT_SLOT)}
      label={`root value of ${entry.key}`}
    />
  ) : (
    <span className="vault-value muted">{entry.lines.length ? '— workspace-only —' : '— not set —'}</span>
  );

  const renderLine = (line: VaultLine) => {
    const ws = line.workspaceId;
    const pending = line.pending ? pendingLabel(p.kinds[ws]) : null;
    return (
      <div className="vault-line" key={ws}>
        <span className="vault-line-ws" title={ws}>{p.names[ws] ?? ws}</span>
        {line.mode === 'inherit' ? (
          <>
            <span className="vault-line-mode">inherited from root</span>
            {!entry.root.set && <span className="vault-note warn">No root value — resolves empty</span>}
            <span className="vault-spacer" />
            <button type="button" className="btn-mini" onClick={() => startOverride(ws)} disabled={locked}>
              Override
            </button>
          </>
        ) : (
          <>
            <span className="vault-line-mode override">override</span>
            <ValueCell
              secret={entry.secret}
              value={line.value}
              state={reveals[ws]}
              onToggle={() => toggle(ws)}
              label={`${entry.key} for ${p.names[ws] ?? ws}`}
            />
            <span className="vault-spacer" />
            <button type="button" className="btn-mini" onClick={() => startOverride(ws)} disabled={locked} title="Replace override value">
              ✎
            </button>
            <button
              type="button"
              className="btn-mini"
              onClick={() => void run(() => p.onSetLine(ws, { mode: 'inherit' }))}
              disabled={locked || !entry.root.set}
              title={entry.root.set ? 'Drop the override and inherit the root value' : 'No root value'}
            >
              Reset to root
            </button>
          </>
        )}
        {pending && <span className="vault-pending">{pending}</span>}
        <button
          type="button"
          className="vault-icon-btn"
          aria-label={`Unpublish ${entry.key} from ${p.names[ws] ?? ws}`}
          title="Unpublish from this workspace"
          onClick={() => void run(() => p.onRemoveLine(ws))}
          disabled={locked}
        >
          ✕
        </button>
        {overriding === ws && (
          <form
            className="vault-line-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveOverride(ws);
            }}
          >
            <input
              aria-label={`Override value for ${p.names[ws] ?? ws}`}
              type={entry.secret ? 'password' : 'text'}
              placeholder="override value"
              value={overrideValue}
              onChange={(e) => setOverrideValue(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <button type="submit" className="btn-mini primary" disabled={busy}>Save</button>
            <button type="button" className="btn-mini" onClick={() => setOverriding(null)} disabled={busy}>Cancel</button>
          </form>
        )}
      </div>
    );
  };

  return (
    <div className={`vault-row${open ? ' open' : ''}`} data-vault-key={entry.key}>
      <div className="vault-row-main">
        <button
          type="button"
          className="vault-chevron"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.key}`}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="vault-key">{entry.key}</span>
        {rootCell}
        <span className="vault-meta">
          {fleetKey && <span className="vault-fleet-label" title={fleetKey.description}>{fleetKey.label}</span>}
          {entry.tags.map((t) => (
            <span key={t} className="vault-chip">{t}</span>
          ))}
          {!entry.secret && <span className="vault-plain">plain</span>}
        </span>
        {!scopeWorkspaceId && entry.lines.length > 0 && (
          <span className="vault-count">
            {entry.lines.length} workspace{entry.lines.length === 1 ? '' : 's'}
          </span>
        )}
        {entry.fleet && <span className="vault-chip derived">fleet</span>}
        <span className="vault-actions">
          {p.onEditKey && (
            <>
              <button
                type="button"
                className={`vault-icon-btn${entry.secret ? ' on' : ''}`}
                aria-label={entry.secret ? `Make ${entry.key} plain` : `Make ${entry.key} secret`}
                aria-pressed={entry.secret}
                title={entry.secret ? 'Secret — click to store as plain text' : 'Plain — click to make secret'}
                onClick={() => void run(() => p.onEditKey!({ key: entry.key, secret: !entry.secret, tags: entry.tags }))}
                disabled={locked}
              >
                <IconLock open={!entry.secret} />
              </button>
              <button
                type="button"
                className="vault-icon-btn"
                aria-label={`Edit ${entry.key}`}
                title="Edit"
                onClick={() => setEditing(!editing)}
                disabled={locked}
              >
                ✎
              </button>
            </>
          )}
          {p.onDeleteKey && (
            <button
              type="button"
              className="vault-icon-btn danger"
              aria-label={`Delete ${entry.key}`}
              title="Delete everywhere"
              onClick={() => setConfirmDelete(true)}
              disabled={locked}
            >
              🗑
            </button>
          )}
        </span>
      </div>
      {fleetKey && open && <div className="vault-fleet-desc">{fleetKey.description}</div>}
      {confirmDelete && p.onDeleteKey && (
        <div className="vault-confirm" role="group" aria-label={`Confirm deleting ${entry.key}`}>
          <span>
            Delete {entry.key} everywhere?
            {entry.lines.length > 0 &&
              ` Removes it from ${entry.lines.length} workspace${entry.lines.length === 1 ? '' : 's'}.`}
          </span>
          <button
            type="button"
            className="btn-mini danger"
            onClick={() => void run(p.onDeleteKey!).then((ok) => ok && setConfirmDelete(false))}
            disabled={locked}
          >
            Delete
          </button>
          <button type="button" className="btn-mini" onClick={() => setConfirmDelete(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {editing && p.onEditKey && (
        <VaultKeyForm
          entry={entry}
          tagOptions={p.tagOptions ?? []}
          onSubmit={p.onEditKey}
          onCancel={() => setEditing(false)}
        />
      )}
      {open && (
        <div className="vault-lines">
          {lines.map(renderLine)}
          {!lines.length && !publishable.length && <div className="vault-line muted">Not published to any workspace.</div>}
          {publishable.length > 0 && (
            <select
              className="vault-publish"
              aria-label={`Publish ${entry.key} to workspace`}
              value=""
              onChange={(e) => {
                const ws = e.target.value;
                if (ws) void run(() => p.onSetLine(ws, { mode: 'inherit' }));
              }}
              disabled={locked}
            >
              <option value="">+ Publish to workspace…</option>
              {publishable.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
