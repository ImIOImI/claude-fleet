// The 🔔 quick-change popover (#407 Phase 2): set the notification level for
// future items like this one — this item, its source, or its tag — or snooze it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EffectiveRule, NotifyLevel, NotifyRule, RuleScope, TodoPriority, TodoSource } from '../../../preload';
import { LEVEL_LABELS, bellPosition, ruleScopeLabel, snoozePresets } from '../notifyView';

export interface BellItem {
  source: TodoSource;
  dedupeKey: string | null;
  tags: string[];
  priority: TodoPriority;
}

interface Props {
  item: BellItem;
  /** The trigger's rect when opened; the popover is portaled and fixed-positioned from it. */
  anchor: DOMRect;
  names: Record<string, string>;
  onClose: () => void;
  /** Called after a rule changes so the caller can refresh hints. */
  onChanged?: () => void;
}

const LEVELS: NotifyLevel[] = ['all', 'high', 'urgent', 'off'];
const HINTS: Partial<Record<NotifyLevel, string>> = { all: 'every post can notify', off: 'still lands in the inbox' };

export function BellPopover({ item, anchor, names, onClose, onChanged }: Props) {
  const [scopes, setScopes] = useState<RuleScope[]>([]);
  const [rules, setRules] = useState<NotifyRule[]>([]);
  const [scopeIdx, setScopeIdx] = useState(0);
  const [eff, setEff] = useState<EffectiveRule | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = () => {
    void window.api.notifications.scopesFor(item).then(setScopes);
    void window.api.notifications.settings().then((s) => setRules(s.rules));
    void window.api.notifications.effective(item).then(setEff);
  };
  useEffect(load, [item.source.kind, item.source.id, item.dedupeKey, item.tags.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // The popover is fixed-positioned from its trigger, so close when the list
    // holding the trigger scrolls or the window really changes size. Scrolls
    // elsewhere (rails, terminals) and no-op resize events must not close it.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (ref.current?.contains(t as Node)) return;
      if (t === document || (t instanceof Element && t.closest('.inbox-view'))) onClose();
    };
    const size = { w: window.innerWidth, h: window.innerHeight };
    const onResize = () => { if (window.innerWidth !== size.w || window.innerHeight !== size.h) onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  const scope = scopes[scopeIdx];
  const rule = scope ? rules.find((r) => r.scopeKind === scope.scopeKind && r.scopeValue === scope.scopeValue) : undefined;
  const current: NotifyLevel = rule?.level ?? eff?.level ?? 'all';

  const apply = async (level: NotifyLevel, snoozeUntil: number | null = null) => {
    if (!scope) return;
    await window.api.notifications.setRule({ scopeKind: scope.scopeKind, scopeValue: scope.scopeValue, level, snoozeUntil });
    load();
    onChanged?.();
  };
  const clear = async () => {
    if (!rule) return;
    await window.api.notifications.removeRule(rule.id);
    load();
    onChanged?.();
  };

  const from = eff?.ruleId
    ? (() => {
        const r = rules.find((x) => x.id === eff.ruleId);
        return r ? `rule for ${ruleScopeLabel(r.scopeKind, r.scopeValue, names)}` : 'a rule';
      })()
    : 'your default';

  const pos = bellPosition(anchor, window.innerWidth, window.innerHeight);
  return createPortal(
    <div className="ws-chip-menu bell-pop" role="dialog" aria-label="Notification settings" ref={ref} style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="bp-title">Future notifications for</div>
      <div className="obs-scope-toggle bp-scope" role="tablist" style={{ gridTemplateColumns: `repeat(${Math.max(scopes.length, 1)}, 1fr)` }}>
        {scopes.map((s, i) => (
          <button key={s.scopeKind + s.scopeValue} role="tab" aria-selected={i === scopeIdx} className={`obs-scope-btn ${i === scopeIdx ? 'active' : ''}`} onClick={() => setScopeIdx(i)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="bp-levels" role="radiogroup" aria-label="Level">
        {LEVELS.map((l) => (
          <label key={l} className={`bp-level${current === l && !rule?.snoozeUntil ? ' on' : ''}`}>
            <input type="radio" name="bp-level" checked={current === l} onChange={() => void apply(l)} />
            <span className="bp-radio" aria-hidden="true" />
            <span>{LEVEL_LABELS[l]}</span>
            {HINTS[l] && <span className="bp-hint">{HINTS[l]}</span>}
          </label>
        ))}
      </div>
      <div className="bp-sub">Or snooze</div>
      <div className="bp-snooze">
        {snoozePresets(Date.now()).map((p) => (
          <button key={p.label} className="btn-mini" onClick={() => void apply(rule?.level ?? 'all', p.until)}>{p.label}</button>
        ))}
      </div>
      <div className="bp-foot">
        <span className="ib-dim">
          Now: <strong>{eff ? (eff.snoozeUntil ? 'Snoozed' : LEVEL_LABELS[eff.level]) : '…'}</strong>, from {from}
        </span>
        {rule && <button className="ib-link" onClick={() => void clear()}>Clear rule</button>}
      </div>
    </div>,
    document.body
  );
}
