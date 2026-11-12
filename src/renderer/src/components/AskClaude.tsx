// "Describe it / ask for changes" input (#407 Phase 6). Sends the text to the
// automations workspace; the result comes back as a proposal in Activity.
import { useState } from 'react';

interface Props {
  label: string;
  placeholder: string;
  button: string;
  /** Resolves when the automations workspace has the request. */
  send: (text: string) => Promise<unknown>;
  sentNote: string;
  onWatch?: () => void;
  disabledReason?: string | null;
  multiline?: boolean;
  /** Where to draft (remote g): the local automations workspace and remote workspaces. */
  targets?: Array<{ id: string; label: string; disabledReason: string | null }>;
  target?: string;
  onTarget?: (id: string) => void;
}

const err = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function AskClaude({ label, placeholder, button, send, sentNote, onWatch, disabledReason = null, multiline = false, targets, target, onTarget }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!text.trim() || busy || disabledReason) return;
    setBusy(true); setError(null); setSent(false);
    void send(text).then(() => { setText(''); setSent(true); }).catch((e) => setError(err(e))).finally(() => setBusy(false));
  };
  const Field = multiline ? 'textarea' : 'input';
  return (
    <div className={`ask-claude${multiline ? ' multi' : ''}`}>
      {targets && targets.length > 1 && (
        <select className="ib-select ask-target" aria-label="Draft in" value={target} onChange={(e) => { onTarget?.(e.target.value); setSent(false); setError(null); }}>
          {targets.map((t) => <option key={t.id} value={t.id} disabled={!!t.disabledReason} title={t.disabledReason ?? undefined}>{t.label}</option>)}
        </select>
      )}
      <div className="ask-row">
        <Field
          aria-label={label}
          placeholder={disabledReason ?? placeholder}
          disabled={!!disabledReason}
          value={text}
          onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => { setText(e.target.value); setSent(false); }}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
        />
        <button className="btn btn-sm ask-btn" disabled={!text.trim() || busy || !!disabledReason} onClick={submit}>{busy ? 'Sending…' : button}</button>
      </div>
      {sent && (
        <p className="ask-sent" role="status">
          {sentNote}
          {onWatch && <> <button className="btn-mini" onClick={onWatch}>Watch</button></>}
        </p>
      )}
      {error && <p className="form-hint error-text" role="alert">{error}</p>}
    </div>
  );
}
