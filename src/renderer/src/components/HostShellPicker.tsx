// Pick the shell a `runIn: host` step runs with, from the shells this
// computer has (#407): Windows PowerShell / PowerShell 7 / each WSL distro, or
// bash / zsh / sh. Shown wherever a host step is reviewed or edited.
import { useEffect, useState } from 'react';
import type { HostShell, ScriptShell } from '../../../preload';

let cached: Promise<HostShell[]> | null = null;
export function useHostShells(): HostShell[] {
  const [shells, setShells] = useState<HostShell[]>([]);
  useEffect(() => {
    cached ??= window.api.automations.hostShells().catch(() => { cached = null; return []; });
    let live = true;
    void cached.then((s) => live && setShells(s));
    return () => { live = false; };
  }, []);
  return shells;
}

interface Props {
  stepId: string;
  value: ScriptShell | undefined;
  onChange: (shell: ScriptShell) => void;
  disabled?: boolean;
}

export function HostShellPicker({ stepId, value, onChange, disabled }: Props) {
  const shells = useHostShells();
  const known = shells.some((s) => s.id === value);
  return (
    <label className="host-shell-pick">
      <span className="ib-dim">runs on this computer with</span>
      <select aria-label={`Shell for ${stepId}`} value={value ?? ''} disabled={disabled || shells.length === 0} onChange={(e) => onChange(e.target.value as ScriptShell)}>
        {!value && <option value="">Pick a shell…</option>}
        {value && !known && <option value={value}>{value} (not on this computer)</option>}
        {shells.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </label>
  );
}
