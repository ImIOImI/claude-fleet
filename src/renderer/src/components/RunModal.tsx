// Run now (#407 Phase 3): a form generated from the automation's params,
// validated by the host before any run exists.
import { useState } from 'react';
import type { Automation } from '../../../preload';
import { initialArgs } from '../automationView';
import { ModalBackdrop } from './ModalBackdrop';
import { Markdown } from './Markdown';

interface Props {
  automation: Automation;
  running: boolean;
  onClose: () => void;
  onStarted: () => void;
}

export function RunModal({ automation, running, onClose, onStarted }: Props) {
  const params = automation.definition.params ?? [];
  const [values, setValues] = useState<Record<string, string>>(initialArgs(params));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.api.automations.run(automation.id, values);
      onStarted();
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal run-modal" role="dialog" aria-label={`Run ${automation.name}`} onClick={(e) => e.stopPropagation()}>
        <h2>Run {automation.name}</h2>
        <p className="form-hint">
          Runs version {automation.version} now
          {running
            ? automation.definition.concurrency === 'queue'
              ? '. A run is in progress, so this one waits for it.'
              : '. A run is already in progress, so this one would be skipped.'
            : params.length ? ' with these parameters.' : '.'}
        </p>
        <div className="run-form">
          {params.map((p) => (
            <div className="form-row" key={p.name}>
              <label htmlFor={`rf-${p.name}`}>
                {p.name}
                {p.required && p.default === undefined && <span className="req">required</span>}
              </label>
              {p.type === 'enum' ? (
                <select id={`rf-${p.name}`} value={values[p.name]} onChange={(e) => set(p.name, e.target.value)}>
                  {p.default === undefined && <option value="">—</option>}
                  {p.values?.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              ) : p.type === 'boolean' ? (
                <select id={`rf-${p.name}`} value={values[p.name]} onChange={(e) => set(p.name, e.target.value)}>
                  <option value="">{p.default === undefined ? '—' : `default (${String(p.default)})`}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input id={`rf-${p.name}`} type={p.type === 'number' ? 'number' : 'text'} value={values[p.name]} onChange={(e) => set(p.name, e.target.value)} />
              )}
              {p.description && <p className="form-hint"><Markdown text={p.description} inline /></p>}
            </div>
          ))}
        </div>
        {error && <p className="form-hint error-text" role="alert">{error}</p>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>▶ Run now</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
