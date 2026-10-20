// Inbox main-pane view (#407). Phase 1: the Todos tab — status tabs, search,
// tag filter, an add row, a priority-grouped list and a detail pane.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Todo, TodoPriority, TodoStatus } from '../../../preload';
import { groupByPriority, matchesSearch, relativeAgo, sourceLabel } from '../inboxView';
import { TodoDetail } from './TodoDetail';

interface Props {
  names: Record<string, string>;
  openCount: number;
  onJump: (workspaceId: string) => void;
}

const TABS: Array<[TodoStatus | 'all', string]> = [['open', 'Open'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']];

export function InboxView({ names, openCount, onJump }: Props) {
  const [status, setStatus] = useState<TodoStatus | 'all'>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');

  const reload = useCallback(() => {
    void window.api.inbox.list({ status }).then(setTodos);
    setVersion((v) => v + 1);
  }, [status]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.inbox.onChanged(() => reload()), [reload]);

  const visible = useMemo(
    () => todos.filter((t) => matchesSearch(t, search) && (!tag || t.tags.includes(tag))),
    [todos, search, tag]
  );
  const groups = groupByPriority(visible);

  const add = async () => {
    if (!title.trim()) return;
    await window.api.inbox.create({ title, priority });
    setTitle('');
    setPriority('normal');
  };

  return (
    <div className="inbox-view">
      <div className="session-tab-strip ib-tabs" role="tablist" aria-label="Inbox sections">
        <div role="tab" aria-selected="true" className="session-tab active">
          <span className="session-tab-name">Todos</span>
          <span className="ib-count">{openCount}</span>
        </div>
      </div>
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
                    {g.todos.map((t) => (
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
                        </div>
                      </li>
                    ))}
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
    </div>
  );
}
