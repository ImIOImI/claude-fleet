// src/renderer/src/components/ModelCombobox.tsx
// Rich "Model" picker for the workspace form (#256). Options carry two
// lines (name + modelId · baseUrl) and a badge, which a native <select>
// can't render — hence a hand-rolled listbox. Presentational: the parent
// owns the registry list and the selection; this component owns only
// open/close + active-option state and the listbox ARIA contract.

import { useEffect, useRef, useState } from 'react';
import type { ModelSelection } from './modelPicker';

export interface EndpointEntry {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
}

interface Props {
  value: ModelSelection;
  endpoints: EndpointEntry[];
  /** False until the first registry fetch resolves — suppresses the
   *  "(deleted endpoint)" state while the list is still loading. */
  endpointsLoaded: boolean;
  disabled?: boolean;
  onChange: (next: ModelSelection) => void;
  /** "＋ Add endpoint…" — parent opens Settings → Model Endpoints. */
  onAddEndpoint?: () => void;
  /** Fired on every open — parent refetches the registry. */
  onOpen?: () => void;
}

interface Option {
  /** 'claude' | endpoint id | '__add' */
  key: string;
  label: string;
  sub: string;
  badge: string;
}

export function ModelCombobox({
  value,
  endpoints,
  endpointsLoaded,
  disabled,
  onChange,
  onAddEndpoint,
  onOpen
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const options: Option[] = [
    { key: 'claude', label: 'Claude', sub: 'Anthropic · claude.ai account or API key', badge: '✳' },
    ...endpoints.map((e) => ({
      key: e.id,
      label: e.name,
      sub: `${e.modelId} · ${e.baseUrl}`,
      badge: '⬢'
    })),
    ...(onAddEndpoint ? [{ key: '__add', label: '＋ Add endpoint…', sub: 'opens Settings → Model Endpoints', badge: '' }] : [])
  ];

  const selectedKey = value.kind === 'claude' ? 'claude' : value.endpointId;
  const selected = options.find((o) => o.key === selectedKey);
  // Selected endpoint no longer in the registry: dangling. Only claim
  // "deleted" once the registry has actually loaded.
  const danglingLabel = endpointsLoaded ? '(deleted endpoint)' : '…';

  const openList = (): void => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.key === selectedKey)));
    setOpen(true);
    onOpen?.();
  };
  const closeList = (): void => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const pick = (key: string): void => {
    if (key === '__add') {
      setOpen(false);
      onAddEndpoint?.();
      return;
    }
    onChange(key === 'claude' ? { kind: 'claude' } : { kind: 'endpoint', endpointId: key });
    closeList();
  };

  // Click-outside closes without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent): void => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (!open) {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openList();
      }
      return;
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Home':
        ev.preventDefault();
        setActive(0);
        break;
      case 'End':
        ev.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        pick(options[active].key);
        break;
      case 'Escape':
      case 'Tab':
        closeList();
        break;
    }
  };

  return (
    <div className="model-combo" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={btnRef}
        className="model-combo-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className={`model-badge ${value.kind === 'claude' ? 'claude' : 'endpoint'}`}>
          {selected?.badge ?? '⬢'}
        </span>
        <span className="model-combo-meta">
          <b>{selected?.label ?? danglingLabel}</b>
          {selected && <small>{selected.sub}</small>}
        </span>
        <span className="model-combo-caret">▾</span>
      </button>
      {open && (
        <div className="model-combo-list" role="listbox" aria-label="Model options" aria-activedescendant={`model-opt-${active}`}>
          {options.map((o, i) => (
            <div
              key={o.key}
              id={`model-opt-${i}`}
              role="option"
              aria-selected={o.key === selectedKey}
              className={`model-combo-item${o.key === selectedKey ? ' sel' : ''}${i === active ? ' hover' : ''}${o.key === '__add' ? ' add' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.key)}
            >
              {o.badge && (
                <span className={`model-badge ${o.key === 'claude' ? 'claude' : 'endpoint'}`}>{o.badge}</span>
              )}
              <span className="model-combo-meta">
                <b>{o.label}</b>
                {o.sub && <small>{o.sub}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
