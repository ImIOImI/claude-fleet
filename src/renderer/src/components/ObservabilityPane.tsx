export function ObservabilityPane() {
  return (
    <aside className="pane sidebar-right">
      <div className="pane-header">
        <span>Observability</span>
      </div>
      <div className="pane-body">
        <div className="pane-placeholder">
          <strong>Coming with #2</strong>
          Per-session cost, token counts, context usage, and recent tool calls
          sourced from each container's Claude transcript JSONL. See
          <code> docs/SPEC.md</code> §11 “Observability layer”.
        </div>
      </div>
    </aside>
  );
}
