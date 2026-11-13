// Detail pane for a remote automation (remote g). Run now is a host RPC
// (steer); Ask Claude to change drafts locally (D127); the rest is the host
// config's (D125). Host text renders as text only.
import { useEffect, useState } from 'react';
import type { RemoteAutomation, RemoteAutomationDetail as Detail } from '../../../preload';
import { RUN_LABELS, TRIGGER_LABELS, nextLabel, runDuration, runTone, runWhen } from '../automationView';
import { actionGate, rowKey, stableFingerprint } from '../remoteAutomationsView';
import { AskClaude } from './AskClaude';
import { OriginBadge } from './OriginBadge';
import { RunModal } from './RunModal';
import { useRemoteAction } from './useRemoteAction';

interface Props {
  automation: RemoteAutomation;
  version: number;
  automationsWs: { name: string } | null;
  onWatch?: () => void;
}

export function RemoteAutomationDetail({ automation: a, version, automationsWs, onWatch }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [running, setRunning] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const act = useRemoteAction();
  const gate = actionGate(a.tier, a.workspaceName);

  useEffect(() => {
    let live = true;
    void window.api.remoteAutomations.get(a.origin, a.id).then((d) => { if (live) setDetail(d); });
    return () => { live = false; };
  }, [a.origin, a.id, version]);

  const runKey = rowKey(a.origin, `run:${a.id}`);
  return (
    <aside className="ib-detail auto-detail" aria-label="Automation details">
      <div className="ib-detail-head">
        <div className="ib-detail-chips">
          <OriginBadge name={a.workspaceName} hue={a.workspaceColorHue} tier={a.tier} />
          <span className={`state-chip${a.enabled ? ' ok' : ''}`}>{a.enabled ? 'enabled' : 'disabled'}</span>
          <span className="mono ib-dim">v{a.version}</span>
        </div>
        <h3 className="ib-detail-title">{a.name}</h3>
        {a.description && <p className="ib-desc">{a.description}</p>}
        <p className="remote-managed">Managed by the host config of {a.workspaceName}. Changes land through a platform-ops PR.</p>
        <div className="ib-detail-actions">
          <button
            className="btn btn-sm primary"
            disabled={!!gate || !a.enabled || act.busy.has(runKey)}
            title={gate ?? (a.enabled ? undefined : 'Disabled in the host config')}
            onClick={() => setRunning(true)}
          >▶ Run now…</button>
          {act.errors[runKey] && <span className="remote-msg">{act.errors[runKey]}</span>}
        </div>
      </div>
      <AskClaude
        key={rowKey(a.origin, a.id)}
        label={`Ask Claude to change ${a.name}`}
        placeholder="Ask Claude to change this… (e.g. run every 30 min on weekdays)"
        button="Ask"
        send={(t) => window.api.automations.draftRemote(a.origin, t, a.id)}
        sentNote={`Sent to ${automationsWs?.name ?? 'the automations workspace'}. The changed entry for ${a.workspaceName}'s host config will appear in Activity › Needs approval, to copy into a platform-ops PR.`}
        onWatch={onWatch}
        disabledReason={automationsWs ? null : 'Set up the automations workspace to ask Claude for changes'}
      />
      <div className="ib-statline">
        <span><b className="mono">{a.weekStats.runs}</b> runs this week</span>
        <span><b className="mono">{a.weekStats.nothingToDo}</b> nothing to do</span>
        <span><b className="mono">{a.weekStats.failed}</b> failed</span>
        <span className="ib-dim">next {nextLabel(a)}</span>
      </div>
      <div className="ib-sec">Triggers</div>
      <ul className="ib-lines">{a.triggerSummaries.map((t, i) => <li key={i}><span className="mono">{t}</span></li>)}</ul>
      <div className="ib-sec">Steps</div>
      <ol className="ib-steps">
        {a.definition.steps.map((s) => 'prompt' in s ? (
          <li key={s.id}>
            <span className="step-k">{s.id}</span>
            <span>prompt <b>{a.workspaceName}</b></span>
            <span className="ib-dim">fresh session · runs to completion</span>
            {(s.prompt.allowedTools ?? []).map((t) => <span key={t} className="tag">{t}</span>)}
          </li>
        ) : null)}
      </ol>
      <div className="ib-sec">Runs</div>
      {!detail ? <p className="ib-dim">Loading…</p> : detail.runs.length === 0 ? <p className="ib-dim">No runs yet.</p> : (
        <ul className="run-list" aria-label="Runs">
          {detail.runs.map((r) => (
            <li key={r.id} className={`run-row${openRun === r.id ? ' open' : ''}`} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
              <span className="mono">{runWhen(r)}</span>
              <span className="ib-dim">{TRIGGER_LABELS[r.trigger.kind]}{r.trigger.by?.kind === 'user' && r.trigger.by.id ? ` by @${r.trigger.by.id}` : ''}</span>
              <span className={`run-chip ${runTone(r.status)}`}>{RUN_LABELS[r.status]}</span>
              <span className="mono ib-dim">{runDuration(r)}</span>
              {r.error && <span className="run-out">{r.error}</span>}
              {openRun === r.id && (
                <div className="run-steps">
                  {Object.keys(r.args).length > 0 && <div className="run-step"><span className="step-k">args</span><code>{JSON.stringify(r.args)}</code></div>}
                  {r.steps.map((s) => (
                    <div className="run-step" key={s.id}>
                      <span className="step-k">{s.stepId}</span>
                      <span><span className={`run-chip ${runTone(s.status)}`}>{RUN_LABELS[s.status]}</span>{s.error ? ` · ${s.error}` : ''}</span>
                      {Array.isArray(s.detail?.warnings) && (s.detail.warnings as string[]).map((w, i) => <span key={i} className="run-warn">⚠ {w}</span>)}
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {running && (
        <RunModal
          automation={a}
          running={!!detail?.runs.some((r) => r.status === 'running')}
          onClose={() => setRunning(false)}
          onStarted={() => setRunning(false)}
          runWith={async (values) => {
            const r = await act.run(runKey, stableFingerprint({ id: a.id, args: values }), (rid) => window.api.remoteAutomations.run(a.origin, a.id, values, rid));
            return r.ok ? null : r.message;
          }}
        />
      )}
    </aside>
  );
}
