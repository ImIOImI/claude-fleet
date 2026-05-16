import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ProfilesDialog({ open, onClose }: Props) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => setProfiles(await window.api.vault.list());
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  if (!open) return null;

  const add = async () => {
    if (!newName.trim() || !newKey.trim()) return;
    setBusy(true);
    try {
      await window.api.vault.set({ name: newName.trim(), apiKey: newKey.trim() });
      setNewName('');
      setNewKey('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const del = async (name: string) => {
    if (!confirm(`Delete profile "${name}"?`)) return;
    await window.api.vault.delete(name);
    await refresh();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Credential profiles</h2>
        <p className="muted">API keys are stored in your OS keychain.</p>
        <ul className="profile-list">
          {profiles.length === 0 && <li className="muted">No profiles yet.</li>}
          {profiles.map((name) => (
            <li key={name}>
              <span>{name}</span>
              <button onClick={() => del(name)}>Delete</button>
            </li>
          ))}
        </ul>
        <div className="profile-add">
          <input
            placeholder="Profile name (e.g. default)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            placeholder="ANTHROPIC_API_KEY"
            type="password"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <button onClick={add} disabled={busy || !newName || !newKey}>Add</button>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
