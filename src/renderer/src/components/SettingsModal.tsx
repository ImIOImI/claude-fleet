// App-level settings: the fleet root — the single host directory that holds
// every workspace's private folder (<root>/<id>) and the shared folder
// (<root>/shared) mounted into every container (changing it takes effect for
// new containers and on the next restart of existing ones) — plus the
// hardware-acceleration toggle (applied at the next app launch).

import { useEffect, useState } from 'react';
import type { UsageBudgetPreset } from '../../../preload';

/** Compact token formatter for preset labels (e.g. 19_000_000 → "19M"). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Mirrors the ModelEndpoint shape from src/main/endpoints.ts. */
interface ModelEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  smallFastModelId?: string;
  contextLength?: number;
  hasApiKey: boolean;
  notes?: string;
}

interface EndpointFormState {
  id?: string; // present when editing
  name: string;
  baseUrl: string;
  modelId: string;
  smallFastModelId: string;
  contextLength: string;
  notes: string;
  apiKey: string;
}

function blankForm(): EndpointFormState {
  return { name: '', baseUrl: '', modelId: '', smallFastModelId: '', contextLength: '', notes: '', apiKey: '' };
}

function formFromEndpoint(ep: ModelEndpoint): EndpointFormState {
  return {
    id: ep.id,
    name: ep.name,
    baseUrl: ep.baseUrl,
    modelId: ep.modelId,
    smallFastModelId: ep.smallFastModelId ?? '',
    contextLength: ep.contextLength != null ? String(ep.contextLength) : '',
    notes: ep.notes ?? '',
    apiKey: '' // never prefilled — vault secret
  };
}

export type ActiveTab = 'settings' | 'endpoints';

interface Props {
  onClose: () => void;
  /** Called after a successful save with the new config so the app can refresh. */
  onSaved: (config: { fleetRoot: string; sharedDir: string }) => void;
  /** Open the modal directly on this tab (default: 'settings'). */
  initialTab?: ActiveTab;
}

export function SettingsModal({ onClose, onSaved, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab ?? 'settings');

  // ── Settings tab state ──────────────────────────────────────────────────
  const [fleetRoot, setFleetRoot] = useState('');
  const [hwaDisabled, setHwaDisabled] = useState(false);
  // The persisted HWA value at open time — used to know whether the toggle
  // actually changed, so we only nudge "restart to apply" when it did.
  const [hwaInitial, setHwaInitial] = useState(false);
  const [autoReload, setAutoReload] = useState(true);
  // Plan-usage budget for the observability rail's "tokens left" bar.
  const [budgetPreset, setBudgetPreset] = useState<UsageBudgetPreset>('pro');
  const [budgetCustom, setBudgetCustom] = useState('');
  const [budgetPresets, setBudgetPresets] = useState({ pro: 0, max5: 0, max20: 0 });
  const [budgetWindowHours, setBudgetWindowHours] = useState(5);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Model Endpoints tab state ───────────────────────────────────────────
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([]);
  const [endpointsLoaded, setEndpointsLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EndpointFormState>(blankForm());
  const [epBusy, setEpBusy] = useState(false);
  const [epError, setEpError] = useState<string | null>(null);
  const [probeInFlight, setProbeInFlight] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Load settings on mount ──────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    void window.api.config.get().then((cfg) => {
      if (live) {
        setFleetRoot(cfg.fleetRoot);
        setHwaDisabled(cfg.disableHardwareAcceleration);
        setHwaInitial(cfg.disableHardwareAcceleration);
        setAutoReload(cfg.autoReloadLoadouts);
        // Guard: a partial config (e.g. an old build, or a test stub) shouldn't
        // break the modal — the budget control just falls back to its defaults.
        if (cfg.usageBudget) {
          setBudgetPreset(cfg.usageBudget.preset);
          setBudgetCustom(String(cfg.usageBudget.customTokens));
          setBudgetPresets(cfg.usageBudget.presets);
          setBudgetWindowHours(cfg.usageBudget.windowHours);
        }
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // ── Load endpoints when tab is first activated ──────────────────────────
  useEffect(() => {
    if (activeTab !== 'endpoints' || endpointsLoaded) return;
    let live = true;
    void (window.api.endpoints.list() as Promise<ModelEndpoint[]>).then((list) => {
      if (live) {
        setEndpoints(list);
        setEndpointsLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, [activeTab, endpointsLoaded]);

  async function refreshEndpoints(): Promise<void> {
    const list = await (window.api.endpoints.list() as Promise<ModelEndpoint[]>);
    setEndpoints(list);
  }

  // ── Settings tab handlers ───────────────────────────────────────────────
  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(fleetRoot.trim() || undefined);
    if (picked) setFleetRoot(picked);
  };

  const save = async () => {
    if (busy) return;
    const trimmed = fleetRoot.trim();
    if (!trimmed) {
      setError('Fleet root cannot be empty.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (hwaDisabled !== hwaInitial) {
        await window.api.config.setHardwareAccelDisabled(hwaDisabled);
      }
      await window.api.config.setAutoReloadLoadouts(autoReload);
      const customTokens = Math.max(0, Math.round(Number(budgetCustom) || 0));
      await window.api.config.setUsageBudget(budgetPreset, customTokens);
      const cfg = await window.api.config.setFleetRoot(trimmed);
      onSaved(cfg);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // ── Endpoint tab handlers ───────────────────────────────────────────────
  const openAddForm = () => {
    setForm(blankForm());
    setEpError(null);
    setProbeResult(null);
    setShowForm(true);
  };

  const openEditForm = (ep: ModelEndpoint) => {
    setForm(formFromEndpoint(ep));
    setEpError(null);
    setProbeResult(null);
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setForm(blankForm());
    setEpError(null);
    setProbeResult(null);
  };

  const updateField = (field: keyof EndpointFormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear probe result when form fields change so stale result isn't shown.
    if (field === 'baseUrl' || field === 'modelId' || field === 'apiKey') {
      setProbeResult(null);
    }
  };

  const testConnection = async () => {
    if (probeInFlight) return;
    const baseUrl = form.baseUrl.trim();
    const modelId = form.modelId.trim();
    if (!baseUrl || !modelId) {
      setEpError('Base URL and Model ID are required to test the connection.');
      return;
    }
    setProbeInFlight(true);
    setProbeResult(null);
    setEpError(null);
    try {
      const result = await (window.api.endpoints.probe(
        baseUrl,
        modelId,
        form.apiKey.trim() || null
      ) as Promise<{ ok: boolean; status?: number; message: string }>);
      setProbeResult(result);
    } catch (err) {
      setEpError(String(err));
    } finally {
      setProbeInFlight(false);
    }
  };

  const saveEndpoint = async () => {
    if (epBusy) return;
    setEpBusy(true);
    setEpError(null);
    try {
      const input = {
        id: form.id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        modelId: form.modelId.trim(),
        smallFastModelId: form.smallFastModelId.trim() || undefined,
        contextLength: form.contextLength.trim() ? Number(form.contextLength.trim()) : undefined,
        notes: form.notes.trim() || undefined
      };
      const saved = await (window.api.endpoints.save(input) as Promise<ModelEndpoint>);
      if (form.apiKey.trim()) {
        await window.api.endpoints.setApiKey(saved.id, form.apiKey.trim());
      }
      await refreshEndpoints();
      setShowForm(false);
      setForm(blankForm());
      setProbeResult(null);
    } catch (err) {
      setEpError(String(err));
    } finally {
      setEpBusy(false);
    }
  };

  const deleteEndpoint = async (ep: ModelEndpoint) => {
    if (!confirm(`Delete endpoint "${ep.name}"? This cannot be undone.`)) return;
    try {
      await window.api.endpoints.delete(ep.id);
      await refreshEndpoints();
    } catch (err) {
      setEpError(String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-tabbed" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs" role="tablist">
          <div
            className={`modal-tab${activeTab === 'settings' ? ' active' : ''}`}
            aria-current={activeTab === 'settings' ? 'page' : undefined}
            onClick={() => setActiveTab('settings')}
            style={{ cursor: 'pointer' }}
          >
            Settings
          </div>
          <div
            className={`modal-tab${activeTab === 'endpoints' ? ' active' : ''}`}
            aria-current={activeTab === 'endpoints' ? 'page' : undefined}
            onClick={() => setActiveTab('endpoints')}
            style={{ cursor: 'pointer' }}
          >
            Model Endpoints
            {endpoints.length > 0 && (
              <span className="modal-tab-count">{endpoints.length}</span>
            )}
          </div>
        </div>

        {/* ── Settings tab ─────────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div className="new-tab" role="tabpanel">
            <div className="settings-section">
              <div className="settings-section-header">Storage</div>
              <div className="input-with-button">
                <input
                  value={fleetRoot}
                  onChange={(e) => setFleetRoot(e.target.value)}
                  placeholder="/home/you/fleet"
                  disabled={busy || !loaded}
                  aria-label="Fleet root (host path)"
                />
                <button type="button" onClick={browse} disabled={busy || !loaded}>
                  Browse…
                </button>
              </div>
              <p className="setting-desc">
                Private folder per workspace at <code>&lt;root&gt;/&lt;id&gt;</code> →{' '}
                <code>/workspace</code>, plus a shared <code>&lt;root&gt;/shared</code> →{' '}
                <code>/shared</code> in every container. Applies to new containers and on next
                restart.
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-section-header">Behavior</div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-hwa">
                    Disable hardware acceleration
                  </label>
                  <p className="setting-desc">
                    For GPU-process errors on startup (common on WSLg). Applies at next launch.
                    {hwaDisabled !== hwaInitial && (
                      <strong> Restart required to take effect.</strong>
                    )}
                  </p>
                </div>
                <input
                  id="setting-hwa"
                  type="checkbox"
                  checked={hwaDisabled}
                  onChange={(e) => setHwaDisabled(e.target.checked)}
                  disabled={busy || !loaded}
                />
              </div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-autoreload">
                    Auto-reload loadouts into running workspaces
                  </label>
                  <p className="setting-desc">
                    Reload the Claude session (<code>--resume</code>) after a loadout
                    install/update — waits until Claude is idle before reloading.
                  </p>
                </div>
                <input
                  id="setting-autoreload"
                  type="checkbox"
                  checked={autoReload}
                  onChange={(e) => setAutoReload(e.target.checked)}
                  disabled={busy || !loaded}
                />
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-header">Plan usage</div>
              <div className="setting-row">
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="setting-budget">
                    Budget for the &ldquo;tokens left&rdquo; bar
                  </label>
                  <p className="setting-desc">
                    Rolling {budgetWindowHours}-hour window (input + output + cache), fleet-wide.
                    Presets are estimates — calibrate with Custom.
                  </p>
                </div>
                <select
                  id="setting-budget"
                  value={budgetPreset}
                  onChange={(e) => setBudgetPreset(e.target.value as UsageBudgetPreset)}
                  disabled={busy || !loaded}
                >
                  <option value="pro">
                    Pro — {fmtTokens(budgetPresets.pro)} / {budgetWindowHours}h
                  </option>
                  <option value="max5">
                    Max 5× — {fmtTokens(budgetPresets.max5)} / {budgetWindowHours}h
                  </option>
                  <option value="max20">
                    Max 20× — {fmtTokens(budgetPresets.max20)} / {budgetWindowHours}h
                  </option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {budgetPreset === 'custom' && (
                <div className="setting-custom-budget">
                  <input
                    type="number"
                    min="0"
                    step="1000000"
                    value={budgetCustom}
                    onChange={(e) => setBudgetCustom(e.target.value)}
                    placeholder="e.g. 19000000"
                    disabled={busy || !loaded}
                    aria-label={`Custom budget (tokens per ${budgetWindowHours}h)`}
                  />
                  <p className="setting-desc">
                    Anthropic doesn&apos;t publish exact limits — presets are anchored to the Max
                    5×/20× multipliers. Calibrate with your real ceiling from Settings → Usage, or
                    the spend shown when Claude Code reports a limit.
                  </p>
                </div>
              )}
            </div>

            {error && <div className="form-hint error-text">{error}</div>}
            <div className="modal-footer">
              <span className="modal-footer-spacer" />
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={save} disabled={busy || !loaded}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* ── Model Endpoints tab ───────────────────────────────────────── */}
        {activeTab === 'endpoints' && (
          <div className="new-tab" role="tabpanel">
            {/* Endpoint list */}
            {!showForm && (
              <>
                {!endpointsLoaded ? (
                  <p className="form-hint">Loading…</p>
                ) : endpoints.length === 0 ? (
                  <p className="form-hint">
                    No model endpoints yet. Register an Anthropic-format (/v1/messages) URL — see{' '}
                    <code>docs/local-models.md</code> for Ollama/vLLM/LiteLLM recipes.
                  </p>
                ) : (
                  <ul className="endpoint-list">
                    {endpoints.map((ep) => (
                      <li key={ep.id} className="endpoint-row">
                        <div className="endpoint-row-text">
                          <div className="endpoint-name">{ep.name}</div>
                          <div className="endpoint-detail">
                            {ep.baseUrl} · {ep.modelId}
                          </div>
                        </div>
                        <span className={`endpoint-key-badge${ep.hasApiKey ? ' on' : ''}`}>
                          {ep.hasApiKey ? 'key set' : 'no key'}
                        </span>
                        <button type="button" className="btn-mini" onClick={() => openEditForm(ep)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-mini danger"
                          onClick={() => void deleteEndpoint(ep)}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {epError && <div className="form-hint error-text">{epError}</div>}
                <div className="modal-footer">
                  <span className="modal-footer-spacer" />
                  <button type="button" className="btn" onClick={onClose}>
                    Close
                  </button>
                  <button type="button" className="btn primary" onClick={openAddForm}>
                    Add endpoint
                  </button>
                </div>
              </>
            )}

            {/* Add / Edit inline form */}
            {showForm && (
              <>
                <div className="settings-section">
                  <div className="settings-section-header">Endpoint</div>
                  <div className="form-row">
                    <label>Name *</label>
                    <input
                      value={form.name}
                      onChange={(e) => updateField('name', e.target.value)}
                      placeholder="My Ollama"
                      disabled={epBusy}
                    />
                  </div>
                  <div className="form-row">
                    <label>Base URL *</label>
                    <input
                      value={form.baseUrl}
                      onChange={(e) => updateField('baseUrl', e.target.value)}
                      placeholder="http://host.docker.internal:11434"
                      disabled={epBusy}
                    />
                  </div>
                  <div className="form-row">
                    <label>Model ID *</label>
                    <input
                      value={form.modelId}
                      onChange={(e) => updateField('modelId', e.target.value)}
                      placeholder="qwen3:4b"
                      disabled={epBusy}
                    />
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-header">Options</div>
                  <div className="form-row">
                    <label>Small / fast model ID (optional)</label>
                    <input
                      value={form.smallFastModelId}
                      onChange={(e) => updateField('smallFastModelId', e.target.value)}
                      placeholder="defaults to Model ID"
                      disabled={epBusy}
                    />
                  </div>
                  <div className="form-row">
                    <label>Context length (optional)</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={form.contextLength}
                      onChange={(e) => updateField('contextLength', e.target.value)}
                      placeholder="e.g. 32768"
                      disabled={epBusy}
                    />
                  </div>
                  <div className="form-row">
                    <label>Notes (optional)</label>
                    <input
                      value={form.notes}
                      onChange={(e) => updateField('notes', e.target.value)}
                      placeholder="e.g. local Ollama on workstation"
                      disabled={epBusy}
                    />
                  </div>
                  <div className="form-row">
                    <label>API key (optional)</label>
                    <input
                      type="password"
                      value={form.apiKey}
                      onChange={(e) => updateField('apiKey', e.target.value)}
                      placeholder={
                        form.id
                          ? '••••• (unchanged — leave blank to keep current key)'
                          : '(none — local endpoints usually need no key)'
                      }
                      disabled={epBusy}
                    />
                  </div>
                </div>

                {/* Probe result */}
                {probeResult && (
                  <p
                    className="form-hint"
                    style={{ color: probeResult.ok ? 'var(--ok)' : 'var(--danger)' }}
                  >
                    {probeResult.message}
                  </p>
                )}

                {epError && <div className="form-hint error-text">{epError}</div>}

                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void testConnection()}
                    disabled={epBusy || probeInFlight}
                    style={{ marginRight: 'auto' }}
                  >
                    {probeInFlight ? 'Testing…' : 'Test connection'}
                  </button>
                  <button type="button" className="btn" onClick={cancelForm} disabled={epBusy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void saveEndpoint()}
                    disabled={epBusy || probeInFlight}
                  >
                    {epBusy ? 'Saving…' : form.id ? 'Update' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
