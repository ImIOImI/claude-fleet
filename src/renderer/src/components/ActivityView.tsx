// Inbox › Activity (#407 Phase 2): the notification log — delivered and held
// back, with the exact reason each held item was held. (Proposals join in Phase 5.)
import { useCallback, useEffect, useState } from 'react';
import type { Downtime, NotificationRow, NotifyRule } from '../../../preload';
import { heldReasonLabel, hhmm } from '../notifyView';
import { relativeAgo, sourceLabel } from '../inboxView';
import { BellPopover } from './BellPopover';
import { BellIcon, BellOffIcon } from './NotifyControl';

interface Props {
  names: Record<string, string>;
  onOpenTodo: (todoId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

type Filter = 'all' | 'delivered' | 'held';
const FILTERS: Array<[Filter, string]> = [['all', 'Everything'], ['delivered', 'Notifications'], ['held', 'Held back']];

export function ActivityView({ names, onOpenTodo, onOpenWorkspace }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [rules, setRules] = useState<NotifyRule[]>([]);
  const [downtimes, setDowntimes] = useState<Downtime[]>([]);
  const [bellFor, setBellFor] = useState<string | null>(null);

  const reload = useCallback(() => {
    void window.api.notifications.list(filter).then(setRows);
    void window.api.notifications.settings().then((s) => { setRules(s.rules); setDowntimes(s.downtimes); });
  }, [filter]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.notifications.onChanged(() => reload()), [reload]);

  const sameDay = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();

  return (
    <div className="ib-single">
      <div className="ib-toolbar row">
        <div className="obs-scope-toggle ib-scope three" role="tablist" aria-label="Activity filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`obs-scope-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="ib-scroll">
        {rows.length === 0 ? (
          <div className="ib-empty">{filter === 'held' ? 'Nothing has been held back.' : 'No notifications yet.'}</div>
        ) : (
          <ul className="notif-log" aria-label="Notification log">
            {rows.map((n) => (
              <li key={n.id} className={`nl-row ${n.delivered ? 'ok' : 'held'}`}>
                <span className="nl-glyph" aria-hidden="true">{n.delivered ? '●' : <BellOffIcon />}</span>
                <span className="mono ib-dim" title={new Date(n.ts).toLocaleString()}>{sameDay(n.ts) ? hhmm(n.ts) : relativeAgo(n.ts)}</span>
                <button
                  className="nl-title"
                  onClick={() => (n.todoId ? onOpenTodo(n.todoId) : n.workspaceId ? onOpenWorkspace(n.workspaceId) : undefined)}
                >
                  {n.title}
                </button>
                <span className="src">{sourceLabel(n.source, names)}</span>
                <span className="nl-why">
                  {n.delivered ? `delivered${n.channel === 'os' ? ' · desktop' : n.channel === 'in-app' ? ' · in app' : ''}` : heldReasonLabel(n.heldReason, rules, downtimes, names)}
                  {n.clearedAt ? ' · resolved' : ''}
                </span>
                {n.kind !== 'digest' && n.kind !== 'test' && (
                  <span className="nl-bell">
                    <button className="todo-act" aria-label={`Notifications for things like "${n.title}"`} onClick={() => setBellFor(bellFor === n.id ? null : n.id)}><BellIcon /></button>
                    {bellFor === n.id && (
                      <BellPopover
                        item={{ source: n.source, dedupeKey: n.dedupeKey, tags: n.tags, priority: n.priority }}
                        names={names}
                        onClose={() => setBellFor(null)}
                        onChanged={reload}
                      />
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
