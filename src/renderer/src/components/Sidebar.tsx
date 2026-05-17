import { useState } from 'react';
import type { ContainerSummary } from '../App';
import { ProfilesDialog } from './ProfilesDialog';

interface Props {
  containers: ContainerSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: () => void;
}

export function Sidebar({ containers, selectedId, onSelect, onCreated }: Props) {
  const [creating, setCreating] = useState(false);
  const [creatingMessage, setCreatingMessage] = useState<string | null>(null);
  const [profilesOpen, setProfilesOpen] = useState(false);

  const create = async () => {
    const name = prompt('Container name?', `claude-${Date.now().toString(36).slice(-5)}`);
    if (!name) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      alert('Container name must match [a-zA-Z0-9_-]+ (no spaces, slashes, or dots).');
      return;
    }
    const workspaceRoot = prompt('Host workspace root (parent dir):', '/home/troy/repos');
    if (!workspaceRoot) return;
    const workspaceSubdir = prompt('Subdir inside workspace:', '') ?? '';
    const profileName = prompt('Profile name (must exist in vault):', 'default');
    if (!profileName) return;

    setCreating(true);
    try {
      const profile = await window.api.vault.get(profileName);
      if (!profile) {
        alert(`No vault profile "${profileName}". Add one in Profiles first.`);
        return;
      }
      await window.api.docker.ensureImage(({ message }) => setCreatingMessage(message));
      setCreatingMessage('Creating container…');
      await window.api.docker.create({
        name,
        workspaceRoot,
        workspaceSubdir,
        profile: profileName,
        env: { ANTHROPIC_API_KEY: profile.apiKey }
      });
      onCreated();
    } catch (err) {
      alert(`Failed to create: ${err}`);
    } finally {
      setCreating(false);
      setCreatingMessage(null);
    }
  };

  return (
    <aside className="sidebar">
      <h1>Containers</h1>
      {containers.length === 0 && (
        <div style={{ color: '#6b7280', padding: '8px 10px', fontSize: 12 }}>None yet.</div>
      )}
      {containers.map((c) => (
        <div
          key={c.id}
          className={`container-row ${c.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(c.id)}
        >
          <span className={`dot ${c.state}`} />
          <span className="name">{c.name}</span>
        </div>
      ))}
      <button onClick={create} disabled={creating}>
        {creating ? (creatingMessage ?? 'Creating…') : '+ New container'}
      </button>
      <button onClick={() => setProfilesOpen(true)}>Profiles…</button>
      <ProfilesDialog open={profilesOpen} onClose={() => setProfilesOpen(false)} />
    </aside>
  );
}
