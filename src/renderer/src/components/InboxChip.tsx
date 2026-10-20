// The Automations chip (formerly "Inbox") in the top strip (#407): a compact chip in the workspace-chip
// language. Dot = state (red urgent / grey open / none); sub-line = counts.
import type { InboxCounts } from '../../../preload';
import { chipDot, chipSubline } from '../inboxView';

interface Props {
  counts: InboxCounts;
  active: boolean;
  onOpen: () => void;
}

export function InboxChip({ counts, active, onOpen }: Props) {
  const dot = chipDot(counts);
  return (
    <div className={`ws-chip-group inbox-chip${active ? ' active' : ''}`}>
      <button className="ws-chip" onClick={onOpen} title="Automations: todos, automations and activity" aria-pressed={active}>
        <span className={`inbox-dot ${dot}`} aria-hidden="true" />
        <span className="ws-chip-text">
          <span className="name">Automations</span>
          <span className="ws-chip-sub">{chipSubline(counts)}</span>
        </span>
      </button>
    </div>
  );
}
