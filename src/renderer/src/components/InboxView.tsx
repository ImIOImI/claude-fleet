// Inbox main-pane view (#407). Todos (status tabs, search, tag filter, add row,
// priority-grouped list, detail pane) and Activity (the notification log), with
// the notify control in the header and a banner while notifications are paused.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EffectiveRule, QuietState, Todo, TodoPriority, TodoStatus } from '../../../preload';
import { groupByPriority, matchesSearch, relativeAgo, sourceLabel } from '../inboxView';
import { mutedHint, quietLabel } from '../notifyView';
import { TodoDetail } from './TodoDetail';
import { ActivityView } from './ActivityView';
import { AutomationsView } from './AutomationsView';
import { BellPopover } from './BellPopover';
import { BellIcon, BellOffIcon, NotifyControl } from './NotifyControl';

interface Props {
  names: Record<string, string>;
  openCount: number;
  quiet: QuietState | null;
  /** Select this todo when it changes (toast / OS-notification click-through). */
  focusTodoId?: string | null;
  focusNonce?: number;
  onJump: (workspaceId: string) => void;
  onOpenSchedules: () => void;
  /** Enabled automations, for the tab count. */
  automationCount?: number;
  /** Pending proposals, for the Activity tab count. */
  approvals?: number;
}

const TABS: Array<[TodoStatus | 'all', string]> = [['open', 'Open'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']];

export function InboxView({ names, openCount, quiet, focusTodoId, focusNonce, onJump, onOpenSchedules, automationCount = 0, approvals = 0 }: Props) {
  const [section, setSection] = useState<'todos' | 'automations' | 'activity'>('todos');
  const [status, setStatus] = useState<TodoStatus | 'all'>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [effective, setEffective] = useState<Record<string, EffectiveRule>>({});
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bellFor, setBellFor] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [version, setVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');

  const reload = useCallback(() => {
    void window.api.inbox.list({ status }).then((list) => {
      setTodos(list);
      void window.api.notifications
        .effectiveMany(list.map((t) => ({ id: t.id, priority: t.priority, source: t.source, dedupeKey: t.dedupeKey, tags: t.tags })))
        .then(setEffective);
    });
    setVersion((v) => v + 1);
  }, [status]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.inbox.onChanged(() => reload()), [reload]);
  useEffect(() => window.api.notifications.onChanged(() => reload()), [reload]);
  useEffect(() => {
    if (!focusTodoId) return;
    setSection('todos');
    void window.api.inbox.get(focusTodoId).then((d) => {
      if (!d) return;
      setStatus(d.todo.status);
      setSelected(d.todo.id);
    });
  }, [focusTodoId, focusNonce]);

  const visible = useMemo(
    () => todos.filter((t) => matchesSearch(t, search) && (!tag || t.tags.includes(tag))),
    [todos, search, tag]
  );
  const groups = groupByPriority(visible);
  const q = quietLabel(quiet);

  const add = async () => {
    if (!title.trim()) return;
    await window.api.inbox.create({ title, priority });
    setTitle('');
    setPriority('normal');
  };

  return (
    <div className="inbox-view">
      <div className="session-tab-strip ib-tabs" role="tablist" aria-label="Inbox sections">
        <div role="tab" aria-selected={section === 'todos'} className={`session-tab${section === 'todos' ? ' active' : ''}`} onClick={() => setSection('todos')}>
          <span className="session-tab-name">Todos</span>
          <span className="ib-count">{openCount}</span>
        </div>
        <div role="tab" aria-selected={section === 'automations'} className={`session-tab${section === 'automations' ? ' active' : ''}`} onClick={() => setSection('automations')}>
          <span className="session-tab-name">Automations</span>
          <span className="ib-count">{automationCount}</span>
        </div>
        <div role="tab" aria-selected={section === 'activity'} className={`session-tab${section === 'activity' ? ' active' : ''}`} onClick={() => setSection('activity')}>
          <span className="session-tab-name">Activity</span>
          {approvals > 0 ? <span className="ib-count wait" title="Waiting for your approval">{approvals}</span>
            : quiet && quiet.heldSinceQuiet > 0 && <span className="ib-count" title="Held while quiet">{quiet.heldSinceQuiet}</span>}
        </div>
        <span className="ib-tabs-spacer" />
        <div className="ph-ctl">
          <NotifyControl quiet={quiet} onOpenSchedules={onOpenSchedules} />
        </div>
      </div>
      {q.state !== 'notifying' && (
        <div className="restart-banner pause-banner" role="status">
          <BellOffIcon />
          <span className="restart-banner-text">
            <strong>{q.state === 'paused' ? `Notifications paused ${q.detail}.` : `Downtime: ${q.text} (ends ${q.detail.replace('downtime · ', '')}).`}</strong>{' '}
            {quiet?.heldSinceQuiet ?? 0} held so far.{quiet?.pause?.letUrgent || (q.state === 'downtime' && quiet?.activeDowntime?.bypass !== 'none') ? ' Urgent ones still come through.' : ''}
          </span>
          {q.state === 'paused' && (
            <>
              <button className="btn btn-sm" onClick={() => void window.api.notifications.pause({ until: (quiet?.pause?.until ?? Date.now()) + 30 * 60_000, letUrgent: quiet?.pause?.letUrgent ?? true })}>+30 min</button>
              <button className="btn primary restart-banner-btn" onClick={() => void window.api.notifications.resume()}>Resume now</button>
            </>
          )}
        </div>
      )}
      {section === 'automations' ? (
        <AutomationsView names={names} />
      ) : section === 'activity' ? (
        <ActivityView
          names={names}
          onOpenTodo={(id) => {
            setSection('todos');
            void window.api.inbox.get(id).then((d) => { if (d) { setStatus(d.todo.status); setSelected(id); } });
          }}
          onOpenWorkspace={onJump}
        />
      ) : (
        <div className="ib-split">
          <section className="ib-listcol">
            <div className="ib-toolbar">
              <div className="obs-scope-toggle ib-scope" role="tablist" aria-label="Todo status">
                {TABS.map(([s, label]) => (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={status === s}
                    className={`obs-scope-btn ${status === s ? 'active' : ''}`}
                    onClick={() => { setStatus(s); setSelected(null); }}
                  >
                    {s === 'open' ? `${label} · ${openCount}` : label}
                  </button>
                ))}
              </div>
              <div className="ib-add">
                <input
                  className="sessions-search"
                  aria-label="New todo title"
                  placeholder="Add a todo…"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
                />
                <select className="ib-select" aria-label="New todo priority" value={priority} onChange={(e) => setPriority(e.target.value as TodoPriority)}>
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
                <button className="btn btn-sm primary" onClick={() => void add()} disabled={!title.trim()}>Add todo</button>
              </div>
              <div className="ib-filters">
                <input className="sessions-search" type="search" aria-label="Search todos" placeholder="Search todos…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {tag && <button className="pill" onClick={() => setTag(null)} title="Remove filter">#{tag} ✕</button>}
                <span className="nofm">{visible.length} of {todos.length}</span>
              </div>
            </div>
            {visible.length === 0 ? (
              <div className="ib-empty">{todos.length === 0 && status === 'open' ? 'Nothing open. Workspaces and you can post todos here.' : 'No todos match.'}</div>
            ) : (
              <ul className="todo-list">
                {groups.map((g) => (
                  <li key={g.priority} className="todo-group-wrap">
                    <div className={`session-group-label todo-group g-${g.priority}`}>{g.label} · {g.todos.length}<span className="session-group-line" /></div>
                    <ul className="todo-sublist">
                      {g.todos.map((t) => {
                        const hint = mutedHint(effective[t.id], Date.now());
                        return (
                          <li
                            key={t.id}
                            className={`todo-row p-${t.priority}${selected === t.id ? ' sel' : ''}`}
                            aria-selected={selected === t.id}
                            tabIndex={0}
                            onClick={() => setSelected(t.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setSelected(t.id); }}
                          >
                            <button
                              className="todo-check"
                              aria-label={t.status === 'open' ? `Mark "${t.title}" done` : `Reopen "${t.title}"`}
                              onClick={(e) => { e.stopPropagation(); void window.api.inbox.update(t.id, { status: t.status === 'open' ? 'done' : 'open' }); }}
                            />
                            <div className="todo-main">
                              <div className="todo-title">{t.title}</div>
                              <div className="todo-meta">
                                <span className="src">{sourceLabel(t.source, names)}</span>
                                <span className="todo-time">{relativeAgo(t.lastSeenAt)}</span>
                                {t.seenCount > 1 && <span className="todo-seen">seen {t.seenCount}×</span>}
                                {t.recurred && <span className="todo-flag">recurred</span>}
                                {t.tags.map((x) => (
                                  <button key={x} className="tag" onClick={(e) => { e.stopPropagation(); setTag(x); }}>{x}</button>
                                ))}
                              </div>
                              {hint && <div className="todo-muted"><BellOffIcon /><span>{hint}</span></div>}
                            </div>
                            <div className="todo-actions">
                              <button
                                className={`todo-act${hint ? ' quiet' : ''}${bellFor?.id === t.id ? ' open' : ''}`}
                                aria-label={`Notifications for "${t.title}"`}
                                onClick={(e) => { e.stopPropagation(); setBellFor(bellFor?.id === t.id ? null : { id: t.id, rect: e.currentTarget.getBoundingClientRect() }); }}
                              >
                                {hint ? <BellOffIcon /> : <BellIcon />}
                              </button>
                            </div>
                            {bellFor?.id === t.id && (
                              <BellPopover
                                anchor={bellFor.rect}
                                item={{ source: t.source, dedupeKey: t.dedupeKey, tags: t.tags, priority: t.priority }}
                                names={names}
                                onClose={() => setBellFor(null)}
                                onChanged={reload}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {selected ? (
            <TodoDetail todoId={selected} names={names} version={version} onJump={onJump} />
          ) : (
            <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Select a todo to see its details.</p></aside>
          )}
        </div>
      )}
    </div>
  );
}
