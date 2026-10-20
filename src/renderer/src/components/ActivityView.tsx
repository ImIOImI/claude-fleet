// Inbox › Activity (#407 Phase 2): the notification log — delivered and held
// back, with the exact reason each held item was held. (Proposals join in Phase 5.)
import { useCallback, useEffect, useState } from 'react';
import type { Downtime, NotificationRow, NotifyRule, Proposal } from '../../../preload';
import { ProposalCard } from './ProposalCard';
import { heldReasonLabel, hhmm } from '../notifyView';
import { relativeAgo, sourceLabel } from '../inboxView';
import { BellPopover } from './BellPopover';
import { BellIcon, BellOffIcon } from './NotifyControl';

interface Props {
  names: Record<string, string>;
  onOpenTodo: (todoId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  /** Phase 5b: "Ask Claude about this" needs the automations workspace. */
  canDiscuss?: boolean;
  onDiscussed?: () => void;
}

type Filter = 'all' | 'approvals' | 'delivered' | 'held';

export function ActivityView({ names, onOpenTodo, onOpenWorkspace, canDiscuss = false, onDiscussed }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [rules, setRules] = useState<NotifyRule[]>([]);
  const [downtimes, setDowntimes] = useState<Downtime[]>([]);
  const [bellFor, setBellFor] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const reload = useCallback(() => {
    void window.api.proposals.list().then(setProposals);
    if (filter !== 'approvals') void window.api.notifications.list(filter).then(setRows);
    void window.api.notifications.settings().then((s) => { setRules(s.rules); setDowntimes(s.downtimes); });
  }, [filter]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.notifications.onChanged(() => reload()), [reload]);
  useEffect(() => window.api.proposals.onChanged(() => reload()), [reload]);

  const sameDay = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();
  const pendingProposals = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending' && p.status !== 'superseded').slice(0, 10);
  const FILTERS: Array<[Filter, string]> = [['all', 'Everything'], ['approvals', `Needs approval${pendingProposals.length ? ` · ${pendingProposals.length}` : ''}`], ['delivered', 'Notifications'], ['held', 'Held back']];

  return (
    <div className="ib-single">
      <div className="ib-toolbar row">
        <div className="obs-scope-toggle ib-scope" role="tablist" aria-label="Activity filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`obs-scope-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="ib-scroll">
        {(filter === 'all' || filter === 'approvals') && pendingProposals.length > 0 && (
          <>
            <div className="session-group-label">Needs approval<span className="session-group-line" /></div>
            {pendingProposals.map((p) => <ProposalCard key={p.id} proposal={p} names={names} canDiscuss={canDiscuss} onDiscussed={onDiscussed} />)}
          </>
        )}
        {filter === 'approvals' && (
          <>
            {pendingProposals.length === 0 && <div className="ib-empty">Nothing waiting for approval. Workspaces can propose automations; they land here.</div>}
            {decided.length > 0 && <div className="session-group-label">Decided<span className="session-group-line" /></div>}
            {decided.map((p) => <ProposalCard key={p.id} proposal={p} names={names} canDiscuss={canDiscuss} onDiscussed={onDiscussed} />)}
          </>
        )}
        {filter === 'all' && pendingProposals.length > 0 && <div className="session-group-label">Notifications<span className="session-group-line" /></div>}
        {filter === 'approvals' ? null : rows.length === 0 ? (
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
                    <button className="todo-act" aria-label={`Notifications for things like "${n.title}"`} onClick={(e) => setBellFor(bellFor?.id === n.id ? null : { id: n.id, rect: e.currentTarget.getBoundingClientRect() })}><BellIcon /></button>
                    {bellFor?.id === n.id && (
                      <BellPopover
                        anchor={bellFor.rect}
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
