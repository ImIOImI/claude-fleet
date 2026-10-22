// Detail pane for the selected todo (#407): actions, key facts, tags, body, history.
import { useEffect, useState } from 'react';
import type { Todo, TodoEvent, TodoPriority } from '../../../preload';
import { eventLabel, relativeAgo, sourceLabel } from '../inboxView';
import { BellPopover } from './BellPopover';
import { BellIcon } from './NotifyControl';
import { Markdown } from './Markdown';

interface Props {
  todoId: string;
  names: Record<string, string>;
  version: number;
  onJump: (workspaceId: string) => void;
}

export function TodoDetail({ todoId, names, version, onJump }: Props) {
  const [data, setData] = useState<{ todo: Todo; events: TodoEvent[] } | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [bellOpen, setBellOpen] = useState<DOMRect | null>(null);

  useEffect(() => {
    let live = true;
    void window.api.inbox.get(todoId).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [todoId, version]);

  if (!data) return <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Loading…</p></aside>;
  const { todo, events } = data;
  const update = (patch: Parameters<typeof window.api.inbox.update>[1]) => void window.api.inbox.update(todo.id, patch);

  return (
    <aside className="ib-detail" aria-label="Todo details">
      <div className="ib-detail-head">
        <div className="ib-detail-chips">
          <span className={`prio prio-${todo.priority}`}>{todo.priority}</span>
          <span className="state-chip">{todo.status}{todo.recurred ? ' · recurred' : ''}</span>
        </div>
        <h3 className="ib-detail-title">{todo.title}</h3>
        <div className="ib-detail-actions">
          {todo.status === 'open' ? (
            <>
              <button className="btn btn-sm primary" aria-label="Mark done" onClick={() => update({ status: 'done' })}>✓ Done</button>
              <button className="btn btn-sm" onClick={() => update({ status: 'dismissed' })}>Dismiss</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => update({ status: 'open' })}>Reopen</button>
          )}
          <span className="ib-bell-wrap">
            <button className="btn btn-sm ib-bell-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setBellOpen((o) => (o ? null : r)); }} aria-expanded={!!bellOpen}>
              <BellIcon /> Notifications
            </button>
            {bellOpen && (
              <BellPopover
                anchor={bellOpen}
                item={{ source: todo.source, dedupeKey: todo.dedupeKey, tags: todo.tags, priority: todo.priority }}
                names={names}
                onClose={() => setBellOpen(null)}
              />
            )}
          </span>
          <span className="ib-spacer" />
          <select
            className="ib-select"
            aria-label="Priority"
            value={todo.priority}
            onChange={(e) => update({ priority: e.target.value as TodoPriority })}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <dl className="ib-kv">
        <dt>Source</dt>
        <dd>{sourceLabel(todo.source, names)}</dd>
        {todo.dedupeKey && (<><dt>Key</dt><dd><code>{todo.dedupeKey}</code></dd></>)}
        <dt>Seen</dt>
        <dd>
          <span className="mono">{todo.seenCount}×</span>
          <span className="ib-dim"> · first {relativeAgo(todo.firstSeenAt)} · last {relativeAgo(todo.lastSeenAt)}</span>
        </dd>
        {todo.workspaceId && names[todo.workspaceId] && (
          <>
            <dt>Linked</dt>
            <dd><button className="ib-link" onClick={() => onJump(todo.workspaceId!)}>{names[todo.workspaceId]} ↗</button></dd>
          </>
        )}
        <dt>Tags</dt>
        <dd className="ib-tags">
          {todo.tags.map((t) => (
            <button key={t} className="tag" title={`Remove ${t}`} onClick={() => update({ tagsRemove: [t] })}>{t} ✕</button>
          ))}
          <input
            className="ib-tag-input"
            aria-label="Add tag"
            placeholder="+ tag"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagDraft.trim()) {
                update({ tagsAdd: [tagDraft] });
                setTagDraft('');
              }
            }}
          />
        </dd>
      </dl>
      {todo.body && (
        <div className="ib-body">
          <Markdown text={todo.body} />
        </div>
      )}
      <div className="ib-hist-title">History</div>
      <ol className="ib-hist">
        {[...events].reverse().map((e) => (
          <li key={e.id}>
            <span className={`h-dot${e.kind === 'reopened' ? ' reopen' : ''}`} />
            <span className="h-what">{eventLabel(e, names)}</span>
            <span className="h-when">{relativeAgo(e.ts)}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
