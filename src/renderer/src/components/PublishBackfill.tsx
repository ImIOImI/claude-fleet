// "Also publish existing sessions…" for one saved publish target (D140): never automatic, always confirmed.
import { useState } from 'react';
import { backfillConfirmText, backfillFrom, backfillNote, ipcErrorText } from './publishTargets';

type Step = { kind: 'closed' } | { kind: 'choose' } | { kind: 'confirm'; from: number | 'all'; sessions: number } | { kind: 'busy' };

export function PublishBackfill({ workspaceId, target, host, disabled }: {
  workspaceId: string;
  target: string;
  host: string;
  disabled: boolean;
}): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'closed' });
  const [choice, setChoice] = useState<'all' | 'date'>('all');
  const [date, setDate] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const from = backfillFrom(choice, date);

  const fail = (err: unknown): void => {
    setNote(ipcErrorText(err));
    setStep({ kind: 'closed' });
  };
  const preview = async (): Promise<void> => {
    if (from === null) return;
    setStep({ kind: 'busy' });
    try {
      const r = await window.api.publish.backfillCount(workspaceId, target, from);
      setStep({ kind: 'confirm', from, sessions: r.sessions });
    } catch (err) {
      fail(err);
    }
  };
  const confirm = async (at: number | 'all'): Promise<void> => {
    setStep({ kind: 'busy' });
    try {
      const r = await window.api.publish.backfill(workspaceId, target, at);
      setNote(backfillNote(r.sessions, host));
      setStep({ kind: 'closed' });
    } catch (err) {
      fail(err);
    }
  };

  if (step.kind === 'closed') {
    return (
      <span className="publish-backfill">
        <button type="button" className="btn-mini" disabled={disabled} onClick={() => { setNote(null); setStep({ kind: 'choose' }); }}>
          Also publish existing sessions…
        </button>
        {note && <span className="form-hint">{note}</span>}
      </span>
    );
  }
  if (step.kind === 'confirm') {
    return (
      <span className="publish-backfill">
        <span className="form-hint">{backfillConfirmText(step.sessions, host)}</span>
        {step.sessions > 0 && (
          <button type="button" className="btn-mini danger" disabled={disabled} onClick={() => void confirm(step.from)}>
            Upload
          </button>
        )}
        <button type="button" className="btn-mini" onClick={() => setStep({ kind: 'closed' })}>
          Cancel
        </button>
      </span>
    );
  }
  const busy = step.kind === 'busy';
  return (
    <span className="publish-backfill">
      <label>
        <input type="radio" checked={choice === 'all'} onChange={() => setChoice('all')} disabled={busy} /> All existing sessions
      </label>
      <label>
        <input type="radio" checked={choice === 'date'} onChange={() => setChoice('date')} disabled={busy} /> Sessions since{' '}
        <input type="date" value={date} onChange={(e) => { setChoice('date'); setDate(e.target.value); }} disabled={busy} />
      </label>
      <button type="button" className="btn-mini" disabled={busy || disabled || from === null} onClick={() => void preview()}>
        Continue…
      </button>
      <button type="button" className="btn-mini" disabled={busy} onClick={() => setStep({ kind: 'closed' })}>
        Cancel
      </button>
    </span>
  );
}
