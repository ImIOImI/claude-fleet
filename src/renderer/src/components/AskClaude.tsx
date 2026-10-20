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
}

const err = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function AskClaude({ label, placeholder, button, send, sentNote, onWatch, disabledReason = null, multiline = false }: Props) {
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
