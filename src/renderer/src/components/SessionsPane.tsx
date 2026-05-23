export function SessionsPane() {
  return (
    <aside className="pane sidebar-left">
      <div className="pane-header">
        <span>Sessions</span>
      </div>
      <div className="pane-body">
        <div className="pane-placeholder">
          <strong>Coming with #3</strong>
          Global resumable session list, populated by the JSONL watcher + SQLite
          index. See <code>docs/SPEC.md</code> §11 “Sessions table”.
        </div>
      </div>
    </aside>
  );
}
