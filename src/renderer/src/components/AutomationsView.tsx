// Inbox › Automations (#407 Phase 3): the list (switch, triggers, next fire,
// last run, tags) and the detail pane (actions, week stats, triggers, steps,
// params, runs with per-step outcomes). Authoring is Claude-first (Phase 6):
// describe it and the automations workspace drafts it; YAML is the fallback.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Automation, RunRow } from '../../../preload';
import { RUN_LABELS, TRIGGER_LABELS, nextLabel, rescheduleLabel, runDuration, runTone, runWhen } from '../automationView';
import { AutomationEditor } from './AutomationEditor';
import { RunModal } from './RunModal';
import { AskClaude } from './AskClaude';
import { HostShellPicker } from './HostShellPicker';
import { stringify } from 'yaml';
import { withShell } from '../automationView';
import { Markdown } from './Markdown';

interface Props {
  names: Record<string, string>;
  automationsWs?: { id: string; name: string; running: boolean } | null;
  workspaces?: Array<{ id: string; name: string; kind: string }>;
  onCreateAutomationsWs?: () => void;
  onEditAutomationsWs?: () => void;
  onWatch?: () => void;
}

export function AutomationsView({ names, automationsWs = null, workspaces = [], onCreateAutomationsWs, onEditAutomationsWs, onWatch }: Props) {
  const [pick, setPick] = useState('');
  const [roleError, setRoleError] = useState<string | null>(null);
  const containers = workspaces.filter((w) => w.kind === 'container');
  const [list, setList] = useState<Automation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ automation: Automation; runs: RunRow[]; yaml: string } | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; yaml: string } | null>(null);
  const [running, setRunning] = useState<Automation | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'failing'>('all');
  const [search, setSearch] = useState('');

  const reload = useCallback(() => {
    void window.api.automations.list().then((l) => {
      setList(l);
      setSelected((s) => s ?? l[0]?.id ?? null);
    });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => window.api.automations.onChanged(() => reload()), [reload]);
  useEffect(() => {
    setConfirmDelete(false);
    if (!selected) { setDetail(null); return; }
    void window.api.automations.get(selected).then(setDetail);
  }, [selected, list]);

  const visible = useMemo(() => list.filter((a) =>
    (filter === 'all' || (filter === 'enabled' ? a.enabled : a.lastRun && runTone(a.lastRun.status) === 'bad')) &&
    (!search.trim() || `${a.name} ${a.description ?? ''} ${a.tags.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))
  ), [list, filter, search]);
  const enabledCount = list.filter((a) => a.enabled).length;
  const failingCount = list.filter((a) => a.lastRun && runTone(a.lastRun.status) === 'bad').length;

  const a = detail?.automation;
  const isRunning = !!detail?.runs.some((r) => r.status === 'running');

  return (
    <div className="ib-split">
      <section className="ib-listcol">
        {automationsWs ? (
          <div className="aw-banner set" role="note">
            <span>Automations workspace: <b>{automationsWs.name}</b>{automationsWs.running ? '' : ' (not running)'}</span>
            <span className="ib-spacer" />
            <button className="btn-mini" onClick={onEditAutomationsWs}>Edit</button>
            <button className="btn-mini" onClick={() => void window.api.automations.setRole(null)}>Stop using</button>
          </div>
        ) : (
          <div className="aw-banner" role="note" aria-label="Set up the automations workspace">
            <div className="aw-text">
              <b>Set up an automations workspace</b>
              <span className="ib-dim">Claude there can see and manage every automation, review proposals with you, and make bulk changes. Its sessions open inside the Inbox. It's trusted for low-risk edits.</span>
            </div>
            <div className="aw-actions">
              <select aria-label="Existing workspace" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Use an existing container workspace…</option>
                {containers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <button className="btn btn-sm" disabled={!pick} onClick={() => { setRoleError(null); void window.api.automations.setRole(pick).catch((e) => setRoleError(String(e.message ?? e))); }}>Use it</button>
              <span className="ib-dim">or</span>
              <button className="btn btn-sm primary" onClick={onCreateAutomationsWs}>Create one…</button>
            </div>
            {roleError && <p className="form-hint error-text">{roleError}</p>}
          </div>
        )}
        <AskClaude
          label="Describe a new automation"
          placeholder="Describe an automation: what to check, how often, and what should land in your inbox…"
          button="Draft with Claude"
          multiline
          send={(t) => window.api.automations.draft(t)}
          sentNote={`Sent to ${automationsWs?.name ?? 'the automations workspace'}. Its draft will appear in Activity for you to approve.`}
          onWatch={onWatch}
          disabledReason={automationsWs ? null : 'Set up the automations workspace to draft automations with Claude'}
        />
        <div className="ib-toolbar">
          <div className="obs-scope-toggle ib-scope three" role="tablist" aria-label="Automation filter">
            {([['all', `All · ${list.length}`], ['enabled', `Enabled · ${enabledCount}`], ['failing', `Failing · ${failingCount}`]] as const).map(([f, label]) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`obs-scope-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>
          <div className="ib-filters">
            <input className="sessions-search" type="search" aria-label="Search automations" placeholder="Search automations…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="btn btn-sm" onClick={() => void window.api.automations.starter().then((yaml) => setEditor({ id: null, yaml }))} title="Start from a YAML template">Write YAML…</button>
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="ib-empty">{list.length === 0 ? 'No automations yet. Describe one above and Claude drafts it, or write the YAML yourself.' : 'No automations match.'}</div>
        ) : (
          <ul className="auto-list" aria-label="Automations">
            {visible.map((x) => (
              <li key={x.id} className={`auto-row${selected === x.id ? ' sel' : ''}${x.enabled ? '' : ' off'}`} onClick={() => setSelected(x.id)} aria-selected={selected === x.id} tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setSelected(x.id); }}>
                <button
                  className={`switch${x.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={x.enabled}
                  aria-label={`${x.name} enabled`}
                  onClick={(e) => { e.stopPropagation(); void window.api.automations.setEnabled(x.id, !x.enabled); }}
                />
                <div className="auto-main">
                  <div className="auto-name">{x.name}</div>
                  <div className="auto-meta"><span className="mono">{x.triggerSummaries.join(' + ') || 'no triggers'}</span><span className="ib-dim">· next {nextLabel(x)}</span></div>
                  <div className="auto-meta">
                    {x.lastRun ? (
                      <><span className={`run-chip ${runTone(x.lastRun.status)}`}>{RUN_LABELS[x.lastRun.status]}</span><span className="ib-dim">{runWhen(x.lastRun)}</span></>
                    ) : <span className="ib-dim">never run</span>}
                    {x.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {a && detail ? (
        <aside className="ib-detail auto-detail" aria-label="Automation details">
          <div className="ib-detail-head">
            <div className="ib-detail-chips">
              <span className={`state-chip${a.enabled ? ' ok' : ''}`}>{a.enabled ? 'enabled' : 'disabled'}</span>
              <span className="mono ib-dim">v{a.version} · {a.createdBy.kind === 'user' ? 'created by you' : `created by ${names[a.createdBy.id ?? ''] ?? 'a workspace'}`}</span>
            </div>
            <h3 className="ib-detail-title">{a.name}</h3>
            {a.description && <p className="ib-desc"><Markdown text={a.description} inline /></p>}
            {a.origin && (
              <p className="ib-dim auto-origin">
                From loadout <b>{a.origin.loadoutId}</b>{a.origin.version ? ` v${a.origin.version}` : ''} · installed in {names[a.origin.workspaceId] ?? a.origin.workspaceId}
                {a.origin.edited ? ' · you edited it, so loadout updates keep your version' : ''}
              </p>
            )}
            <div className="ib-detail-actions">
              <button className="btn btn-sm primary" disabled={!a.enabled} title={a.enabled ? undefined : 'Enable it first'} onClick={() => setRunning(a)}>▶ Run now…</button>
              <button className="btn btn-sm" onClick={() => setEditor({ id: a.id, yaml: detail.yaml })}>Edit YAML</button>
              <span className="ib-spacer" />
              {confirmDelete ? (
                <span className="auto-confirm">
                  <span className="ib-dim">Delete {a.name}? Run history is kept.</span>
                  <button className="btn-mini" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  <button className="btn-mini danger" onClick={() => { void window.api.automations.remove(a.id).then(() => { setSelected(null); reload(); }); }}>Delete</button>
                </span>
              ) : (
                <button className="btn btn-sm danger" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
            </div>
          </div>
          <AskClaude
            key={a.id}
            label={`Ask Claude to change ${a.name}`}
            placeholder="Ask Claude to change this… (e.g. run every 30 min on weekdays, skip bot authors)"
            button="Ask"
            send={(t) => window.api.automations.askChange(a.id, t)}
            sentNote="Sent. The change will appear in Activity as a proposal with a diff."
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
          <ul className="ib-lines">
            {a.triggerSummaries.map((t, i) => <li key={i}><span className="mono">{t}</span></li>)}
          </ul>
          <div className="ib-sec">Steps</div>
          <ol className="ib-steps">
            {a.definition.steps.map((s) => 'script' in s ? (
              <li key={s.id} className={s.script.runIn === 'host' ? 'host-step' : undefined}>
                <span className="step-k">{s.id}</span>
                <span>script {s.script.runIn === 'host'
                  ? <>on <b>this computer</b></>
                  : <>in <b>{s.script.runIn ? names[s.script.runIn] ?? s.script.runIn : automationsWs?.name ?? 'the automations workspace'}</b></>}</span>
                {s.script.runIn === 'host' && (
                  <HostShellPicker
                    stepId={s.id}
                    value={s.script.shell}
                    onChange={(shell) => { void window.api.automations.update(a.id, stringify(withShell(a.definition, s.id, shell), { lineWidth: 0 })).then(reload); }}
                  />
                )}
                <span className="ib-dim">{s.script.timeout ? `timeout ${s.script.timeout}` : 'timeout 5m'}{s.script.ensureRunning ? ' · starts it if needed' : ''}</span>
                {(s.script.secrets ?? []).map((k) => <span key={k} className="tag" title="Secret injected into this script only">🔑 {k}</span>)}
                <pre className="ib-pre step-script">{s.script.run}</pre>
              </li>
            ) : (
              <li key={s.id}>
                <span className="step-k">{s.id}</span>
                <span>prompt <b>{names[s.prompt.workspace] ?? s.prompt.workspace}</b></span>
                <span className="ib-dim">{s.prompt.mode === 'fresh' ? 'fresh session · runs to completion' : `live session${s.prompt.wait ? ' · waits' : ''}`}{s.prompt.ensureRunning ? ' · starts it if needed' : ''}</span>
                {s.prompt.mode === 'fresh' && (s.prompt.allowedTools ?? []).map((t) => <span key={t} className="tag" title="Extra tool this unattended session may use">{t}</span>)}
              </li>
            ))}
          </ol>
          {(a.definition.params ?? []).length > 0 && (
            <>
              <div className="ib-sec">Parameters</div>
              <ul className="ib-lines params">
                {a.definition.params!.map((p) => (
                  <li key={p.name}><code>{p.name}</code><span className="ib-dim">{p.type}{p.required && p.default === undefined ? ' · required' : ''}{p.default !== undefined ? ` · default ${String(p.default)}` : ''}</span></li>
                ))}
              </ul>
            </>
          )}
          <div className="ib-sec">Runs</div>
          {detail.runs.length === 0 ? (
            <p className="ib-dim">No runs yet.</p>
          ) : (
            <ul className="run-list" aria-label="Runs">
              {detail.runs.map((r) => (
                <li key={r.id} className={`run-row${openRun === r.id ? ' open' : ''}`} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                  <span className="mono">{runWhen(r)}</span>
                  <span className="ib-dim">{TRIGGER_LABELS[r.trigger.kind]}{r.trigger.event && r.trigger.event.count > 1 ? ` ×${r.trigger.event.count}` : ''}</span>
                  <span className={`run-chip ${runTone(r.status)}`}>{RUN_LABELS[r.status]}</span>
                  <span className="mono ib-dim">{runDuration(r)}</span>
                  {r.error && <span className="run-out">{r.error}</span>}
                  {openRun === r.id && (
                    <div className="run-steps">
                      {Object.keys(r.args).length > 0 && <div className="run-step"><span className="step-k">args</span><code>{JSON.stringify(r.args)}</code></div>}
                      {r.reschedule && <div className="run-step"><span className="step-k">next</span><span>{rescheduleLabel(r)}</span></div>}
                      {r.steps.map((s) => (
                        <div className="run-step" key={s.id}>
                          <span className="step-k">{s.stepId}</span>
                          <span>
                            <span className={`run-chip ${runTone(s.status)}`}>{RUN_LABELS[s.status]}</span>{' '}
                            {s.kind === 'script' ? (
                              <>
                                script {String(s.detail?.via ?? '').startsWith('host:') ? `on this computer (${String(s.detail?.via).slice(5)})` : `in ${names[s.workspaceId ?? ''] ?? s.workspaceId ?? 'the automations workspace'}`}
                                {s.detail?.exitCode !== undefined ? ` · exit ${String(s.detail.exitCode)}` : ''}
                                {s.detail?.todos ? ` · ${String(s.detail.todos)} todo${s.detail.todos === 1 ? '' : 's'}` : ''}
                                {s.detail?.notifications ? ` · ${String(s.detail.notifications)} notification${s.detail.notifications === 1 ? '' : 's'}` : ''}
                              </>
                            ) : (
                              <>
                                prompted {names[s.workspaceId ?? ''] ?? s.workspaceId}
                                {s.detail?.via ? ` (${s.detail.via === 'attached' ? 'open tab' : s.detail.via === 'fresh' ? 'fresh session' : 'background attach'})` : ''}
                              </>
                            )}
                            {s.error ? ` · ${s.error}` : ''}
                          </span>
                          {Array.isArray(s.detail?.warnings) && (s.detail.warnings as string[]).map((w, i) => <span key={i} className="run-warn">⚠ {w}</span>)}
                          {typeof s.detail?.stdout === 'string' && <pre className="ib-pre run-io" aria-label={`${s.stepId} output`}>{s.detail.stdout}</pre>}
                          {typeof s.detail?.stderr === 'string' && <pre className="ib-pre run-io err" aria-label={`${s.stepId} errors`}>{s.detail.stderr}</pre>}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      ) : (
        <aside className="ib-detail ib-detail-empty"><p className="ib-dim">Select an automation to see its details.</p></aside>
      )}

      {editor && (
        <AutomationEditor
          automationId={editor.id}
          initialYaml={editor.yaml}
          onClose={() => setEditor(null)}
          onSaved={(id) => { setEditor(null); setSelected(id); reload(); }}
        />
      )}
      {running && (
        <RunModal
          automation={running}
          running={isRunning}
          onClose={() => setRunning(null)}
          onStarted={() => { setRunning(null); reload(); }}
        />
      )}
    </div>
  );
}
