// Inbox main-pane view (#407). Todos (status tabs, search, tag filter, add row,
// priority-grouped list, detail pane) and Activity (the notification log), with
// the notify control in the header and a banner while notifications are paused.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EffectiveRule, QuietState, RemoteTierName, RemoteTodo, Todo, TodoPriority, TodoStatus } from '../../../preload';
import type { UnavailableSource } from '../../../preload/federation';
import { groupByPriority, matchesSearch, relativeAgo, sourceLabel } from '../inboxView';
import { mutedHint, quietLabel } from '../notifyView';
import { TodoDetail } from './TodoDetail';
import { RemoteTodoDetail } from './RemoteTodoDetail';
import { OriginBadge } from './OriginBadge';
import { useRemoteAction } from './useRemoteAction';
import { actionGate, remoteSourceLabel, rowKey, sortRemoteTodos, stableFingerprint } from '../remoteAutomationsView';
import { unavailableText } from '../sessionsView';
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
  /** Controlled section (App owns it so the Sessions tab can reveal the automations workspace's terminal). */
  section: InboxSection;
  onSection: (s: InboxSection) => void;
  /** The automations workspace (Phase 5b), if set up; enables the Sessions tab. */
  automationsWs?: { id: string; name: string; running: boolean } | null;
  workspaces?: Array<{ id: string; name: string; kind: string; isAutomations?: boolean; remoteTier?: RemoteTierName | null }>;
  onCreateAutomationsWs?: () => void;
  onEditAutomationsWs?: () => void;
  onStartAutomationsWs?: () => void;
}

export type InboxSection = 'todos' | 'automations' | 'activity' | 'sessions';

const TABS: Array<[TodoStatus | 'all', string]> = [['open', 'Open'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']];

export function InboxView({ names, openCount, quiet, focusTodoId, focusNonce, onJump, onOpenSchedules, automationCount = 0, approvals = 0, section, onSection: setSection, automationsWs = null, workspaces = [],
  onCreateAutomationsWs, onEditAutomationsWs, onStartAutomationsWs }: Props) {
  const [status, setStatus] = useState<TodoStatus | 'all'>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [effective, setEffective] = useState<Record<string, EffectiveRule>>({});
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bellFor, setBellFor] = useState<{ id: string; rect: DOMRect; el: HTMLElement } | null>(null);
  const [version, setVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');
  const remotes = useMemo(() => workspaces.filter((w) => w.kind === 'remote').map((w) => ({ id: w.id, name: w.name, tier: w.remoteTier ?? null })), [workspaces]);

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

  // Remote todos (remote g): live-only; the 🔔 rule maps them like their notices (D132): the workspace, the host's key, no tags.
  const [remoteTodos, setRemoteTodos] = useState<RemoteTodo[]>([]);
  const [remoteDown, setRemoteDown] = useState<UnavailableSource[]>([]);
  const [remoteSel, setRemoteSel] = useState<{ origin: string; id: string } | null>(null);
  const [remoteEffective, setRemoteEffective] = useState<Record<string, EffectiveRule>>({});
  const [addTo, setAddTo] = useState('local');
  const todoAct = useRemoteAction();
  const reloadRemote = useCallback(() => {
    void window.api.remoteInbox.list({ status }).then((r) => {
      setRemoteTodos(sortRemoteTodos(r.items));
      setRemoteDown(r.unavailable);
      void window.api.notifications
        .effectiveMany(r.items.map((t) => ({ id: rowKey(t.origin, t.id), priority: t.priority, source: { kind: 'workspace' as const, id: t.origin }, dedupeKey: t.dedupeKey, tags: [] })))
        .then(setRemoteEffective);
    });
    setVersion((v) => v + 1);
  }, [status]);
  useEffect(() => { reloadRemote(); }, [reloadRemote]);
  useEffect(() => window.api.remote.onChanged((c) => { if (c.channel === 'inbox:changed') reloadRemote(); }), [reloadRemote]);
  useEffect(() => window.api.notifications.onChanged(() => reloadRemote()), [reloadRemote]);
  const remoteVisible = useMemo(() => remoteTodos.filter((t) => matchesSearch(t, search) && (!tag || t.tags.includes(tag))), [remoteTodos, search, tag]);
  const addTarget = remotes.find((r) => r.id === addTo) ?? null;
  useEffect(() => { if (addTo !== 'local' && !addTarget) setAddTo('local'); }, [addTo, addTarget]);
  const pickLocal = (id: string) => { setSelected(id); setRemoteSel(null); };
  const pickRemote = (t: RemoteTodo) => { setRemoteSel({ origin: t.origin, id: t.id }); setSelected(null); };

  const visible = useMemo(
    () => todos.filter((t) => matchesSearch(t, search) && (!tag || t.tags.includes(tag))),
    [todos, search, tag]
  );
  const groups = groupByPriority(visible);
  const q = quietLabel(quiet);

  const addKey = rowKey(addTo, 'create');
  const add = async () => {
    if (!title.trim()) return;
    if (!addTarget) await window.api.inbox.create({ title, priority });
    else {
      const input = { title: title.trim(), priority };
      const r = await todoAct.run(addKey, stableFingerprint(input), (rid) => window.api.remoteInbox.create(addTarget.id, input, rid));
      if (!r.ok) return;
    }
    setTitle('');
    setPriority('normal');
  };

  return (
    <div className={`inbox-view${section === 'sessions' && automationsWs?.running ? ' header-only' : ''}`}>
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
        {automationsWs && (
          <>
            <span className="ib-tab-sep" aria-hidden="true" />
            <div role="tab" aria-selected={section === 'sessions'} className={`session-tab ib-sess${section === 'sessions' ? ' active' : ''}`}
              onClick={() => setSection('sessions')} title={`Sessions in ${automationsWs.name}, the automations workspace`}>
              <span className="session-tab-name">Sessions</span>
              <span className="ib-dim mono">{automationsWs.name}</span>
            </div>
          </>
        )}
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
      {section === 'sessions' ? (
        automationsWs?.running ? null : (
          <div className="ib-empty ib-sess-empty">
            <p>{automationsWs ? `${automationsWs.name} isn't running.` : 'No automations workspace yet.'}</p>
            {automationsWs && <button className="btn btn-sm primary" onClick={onStartAutomationsWs}>Start it</button>}
          </div>
        )
      ) : section === 'automations' ? (
        <AutomationsView
          names={names}
          automationsWs={automationsWs}
          workspaces={workspaces}
          onCreateAutomationsWs={onCreateAutomationsWs}
          onEditAutomationsWs={onEditAutomationsWs}
          onWatch={() => setSection('sessions')}
          remotes={remotes}
        />
      ) : section === 'activity' ? (
        <ActivityView
          names={names}
          canDiscuss={!!automationsWs}
          onDiscussed={() => setSection('sessions')}
          onWatch={() => setSection('sessions')}
          automationsWsId={automationsWs?.id ?? null}
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
                    onClick={() => { setStatus(s); setSelected(null); setRemoteSel(null); }}
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
                {remotes.length > 0 && (
                  <select className="ib-select" aria-label="Add to" value={addTo} onChange={(e) => setAddTo(e.target.value)}>
                    <option value="local">This desktop</option>
                    {remotes.map((r) => {
                      const gate = actionGate(r.tier, r.name);
                      return <option key={r.id} value={r.id} disabled={!!gate} title={gate ?? undefined}>{r.name} (remote)</option>;
                    })}
                  </select>
                )}
                <button className="btn btn-sm primary" onClick={() => void add()} disabled={!title.trim() || todoAct.busy.has(addKey)}>Add todo</button>
                {todoAct.errors[addKey] && <span className="remote-msg">{todoAct.errors[addKey]}</span>}
              </div>
              <div className="ib-filters">
                <input className="sessions-search" type="search" aria-label="Search todos" placeholder="Search todos…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {tag && <button className="pill" onClick={() => setTag(null)} title="Remove filter">#{tag} ✕</button>}
                <span className="nofm">{visible.length} of {todos.length}</span>
              </div>
            </div>
            {visible.length === 0 ? (
              remoteVisible.length > 0 ? null : <div className="ib-empty">{todos.length === 0 && status === 'open' ? 'Nothing open. Workspaces and you can post todos here.' : 'No todos match.'}</div>
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
                            onClick={() => pickLocal(t.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') pickLocal(t.id); }}
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
                                onClick={(e) => { e.stopPropagation(); setBellFor(bellFor?.id === t.id ? null : { id: t.id, rect: e.currentTarget.getBoundingClientRect(), el: e.currentTarget }); }}
                              >
                                {hint ? <BellOffIcon /> : <BellIcon />}
                              </button>
                            </div>
                            {bellFor?.id === t.id && (
                              <BellPopover
                                anchor={bellFor.rect}
                                anchorEl={bellFor.el}
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
            {remoteVisible.length > 0 && (
              <>
                <div className="session-group-label">From remote workspaces · {remoteVisible.length}<span className="session-group-line" /></div>
                <ul className="todo-sublist" aria-label="Remote todos">
                  {remoteVisible.map((t) => {
                    const k = rowKey(t.origin, t.id);
                    const gate = actionGate(t.tier, t.workspaceName);
                    const hint = mutedHint(remoteEffective[k], Date.now());
                    const next = t.status === 'open' ? 'done' : 'open';
                    return (
                      <li key={k} className={`todo-row p-${t.priority}${remoteSel && rowKey(remoteSel.origin, remoteSel.id) === k ? ' sel' : ''}`} tabIndex={0}
                        onClick={() => pickRemote(t)} onKeyDown={(e) => { if (e.key === 'Enter') pickRemote(t); }}>
                        <button className="todo-check" disabled={!!gate || todoAct.busy.has(k)} title={gate ?? undefined}
                          aria-label={t.status === 'open' ? `Mark "${t.title}" done` : `Reopen "${t.title}"`}
                          onClick={(e) => { e.stopPropagation(); void todoAct.run(k, stableFingerprint({ id: t.id, status: next }), (rid) => window.api.remoteInbox.update(t.origin, t.id, { status: next }, rid)); }} />
                        <div className="todo-main">
                          <div className="todo-title">{t.title}</div>
                          <div className="todo-meta">
                            <OriginBadge name={t.workspaceName} hue={t.workspaceColorHue} tier={t.tier} />
                            <span className="src">{remoteSourceLabel(t.source, t.origin, names)}</span>
                            <span className="todo-time">{relativeAgo(t.lastSeenAt)}</span>
                            {t.tags.map((x) => <span key={x} className="tag">{x}</span>)}
                          </div>
                          {hint && <div className="todo-muted"><BellOffIcon /><span>{hint}</span></div>}
                          {todoAct.errors[k] && <div className="remote-msg">{todoAct.errors[k]}</div>}
                        </div>
                        <div className="todo-actions">
                          <button className={`todo-act${hint ? ' quiet' : ''}`} aria-label={`Notifications for "${t.title}"`}
                            onClick={(e) => { e.stopPropagation(); setBellFor(bellFor?.id === k ? null : { id: k, rect: e.currentTarget.getBoundingClientRect(), el: e.currentTarget }); }}>
                            {hint ? <BellOffIcon /> : <BellIcon />}
                          </button>
                        </div>
                        {bellFor?.id === k && (
                          <BellPopover anchor={bellFor.rect} anchorEl={bellFor.el}
                            item={{ source: { kind: 'workspace', id: t.origin }, dedupeKey: t.dedupeKey, tags: [], priority: t.priority }}
                            names={names} onClose={() => setBellFor(null)} onChanged={reloadRemote} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {unavailableText(remoteDown) && <div className="remote-unavailable" role="note">{unavailableText(remoteDown)}</div>}
          </section>
          {remoteSel ? (
            <RemoteTodoDetail key={rowKey(remoteSel.origin, remoteSel.id)} origin={remoteSel.origin} todoId={remoteSel.id} names={names} version={version} />
          ) : selected ? (
            <TodoDetail todoId={selected} names={names} version={version} onJump={onJump} />
          ) : (
            <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Select a todo to see its details.</p></aside>
          )}
        </div>
      )}
    </div>
  );
}
