// YAML editor for an automation (#407 Phase 3): live validation against the
// host's validator, starter template for new ones. The Form view arrives with
// Phase 6's Claude-drafted cards.
import { useEffect, useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';

interface Props {
  /** null = new automation. */
  automationId: string | null;
  initialYaml: string;
  onClose: () => void;
  onSaved: (id: string) => void;
  /** Override saving (e.g. edit-then-approve a proposal). */
  onSubmit?: (text: string) => Promise<void>;
  submitLabel?: string;
  title?: string;
}

export function AutomationEditor({ automationId, initialYaml, onClose, onSaved, onSubmit, submitLabel, title }: Props) {
  const [text, setText] = useState(initialYaml);
  const [errors, setErrors] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setChecking(true);
    const t = setTimeout(() => {
      void window.api.automations.validate(text).then((r) => { setErrors(r.errors); setChecking(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      if (onSubmit) {
        await onSubmit(text);
        onSaved(automationId ?? '');
        return;
      }
      const a = automationId ? await window.api.automations.update(automationId, text) : await window.api.automations.create(text);
      onSaved(a.id);
    } catch (e) {
      setSaveError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal auto-editor" role="dialog" aria-label={title ?? (automationId ? 'Edit automation' : 'New automation')} onClick={(e) => e.stopPropagation()}>
        <h2>{title ?? (automationId ? 'Edit automation' : 'New automation')}</h2>
        <p className="form-hint">
          Saving creates a new version. Steps name a workspace (by name); schedules use cron
          (<code>*/30 8-18 * * 1-5</code>). Describing an automation to Claude instead arrives in a later phase.
        </p>
        <textarea
          className="auto-yaml"
          aria-label="Automation YAML"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={`auto-check ${errors.length ? 'bad' : 'ok'}`} role="status" aria-live="polite">
          {checking ? 'Checking…' : errors.length ? `${errors.length} problem${errors.length > 1 ? 's' : ''}` : 'Looks good'}
        </div>
        {!checking && errors.length > 0 && (
          <ul className="auto-errors" aria-label="Problems">
            {errors.map((e) => <li key={e}><code>{e}</code></li>)}
          </ul>
        )}
        {saveError && <p className="form-hint error-text">{saveError}</p>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || checking || errors.length > 0} onClick={() => void save()}>
            {submitLabel ?? (automationId ? 'Save new version' : 'Create automation')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
