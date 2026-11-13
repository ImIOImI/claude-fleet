// Detail pane for a remote todo (remote g). Status and priority are host RPCs
// (steer); the 🔔 rule is local (D134). Body and history are text only.
import { useEffect, useState } from 'react';
import type { RemoteTodo, TodoEvent, TodoPriority, UpdateTodoPatch } from '../../../preload';
import { eventLabel, relativeAgo } from '../inboxView';
import { actionGate, remoteSourceLabel, rowKey, stableFingerprint } from '../remoteAutomationsView';
import { OriginBadge } from './OriginBadge';
import { useRemoteAction } from './useRemoteAction';

interface Props { origin: string; todoId: string; names: Record<string, string>; version: number }

export function RemoteTodoDetail({ origin, todoId, names, version }: Props) {
  const [data, setData] = useState<{ todo: RemoteTodo; events: TodoEvent[] } | null | undefined>(undefined);
  const act = useRemoteAction();
  useEffect(() => {
    let live = true;
    void window.api.remoteInbox.get(origin, todoId).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [origin, todoId, version]);
  if (data === undefined) return <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Loading…</p></aside>;
  if (data === null) return <aside className="ib-detail ib-detail-empty"><p className="ib-dim">This todo isn't available: its host may be unreachable.</p></aside>;
  const { todo, events } = data;
  const gate = actionGate(todo.tier, todo.workspaceName);
  const key = (what: string) => rowKey(origin, `${what}:${todo.id}`);
  const update = (what: string, patch: UpdateTodoPatch) =>
    void act.run(key(what), stableFingerprint({ id: todo.id, patch }), (rid) => window.api.remoteInbox.update(origin, todo.id, patch, rid));
  const err = Object.entries(act.errors).find(([k]) => k.endsWith(`:${todo.id}`))?.[1];
  return (
    <aside className="ib-detail" aria-label="Todo details">
      <div className="ib-detail-head">
        <div className="ib-detail-chips"><OriginBadge name={todo.workspaceName} hue={todo.workspaceColorHue} tier={todo.tier} /><span className="mono ib-dim">{todo.status}</span></div>
        <h3 className="ib-detail-title">{todo.title}</h3>
        <div className="ib-detail-actions">
          {todo.status === 'open' ? (
            <>
              <button className="btn btn-sm primary" disabled={!!gate || act.busy.has(key('done'))} title={gate ?? undefined} onClick={() => update('done', { status: 'done' })}>Done</button>
              <button className="btn btn-sm" disabled={!!gate || act.busy.has(key('dismiss'))} title={gate ?? undefined} onClick={() => update('dismiss', { status: 'dismissed' })}>Dismiss</button>
            </>
          ) : (
            <button className="btn btn-sm" disabled={!!gate || act.busy.has(key('reopen'))} title={gate ?? undefined} onClick={() => update('reopen', { status: 'open' })}>Reopen</button>
          )}
          <select className="ib-select" aria-label="Priority" value={todo.priority} disabled={!!gate || act.busy.has(key('priority'))} title={gate ?? undefined}
            onChange={(e) => update('priority', { priority: e.target.value as TodoPriority })}>
            <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
          </select>
          {err && <span className="remote-msg">{err}</span>}
        </div>
      </div>
      <dl className="ib-facts">
        <dt>Source</dt><dd>{remoteSourceLabel(todo.source, origin, names)}</dd>
        {todo.dedupeKey && <><dt>Key</dt><dd className="mono">{todo.dedupeKey}</dd></>}
        <dt>Seen</dt><dd>{todo.seenCount}× · last {relativeAgo(todo.lastSeenAt)}</dd>
        {todo.tags.length > 0 && <><dt>Tags</dt><dd>{todo.tags.map((t) => <span key={t} className="tag">{t}</span>)}</dd></>}
      </dl>
      {todo.body && <pre className="ib-pre">{todo.body}</pre>}
      <div className="ib-sec">History</div>
      <ul className="ib-lines">
        {[...events].reverse().map((e) => (
          <li key={e.id}><span className="mono ib-dim">{relativeAgo(e.ts)}</span> {eventLabel(e, names, remoteSourceLabel(e.actor, origin, names))}</li>
        ))}
      </ul>
    </aside>
  );
}
