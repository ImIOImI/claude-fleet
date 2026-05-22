import { useState } from 'react';
import type { ContainerSummary } from '../App';
import { ProfilesDialog } from './ProfilesDialog';
import { CreateContainerModal } from './CreateContainerModal';

interface Props {
  containers: ContainerSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: () => void;
  vaultAvailable: boolean | null;
}

export function Sidebar({ containers, selectedId, onSelect, onCreated, vaultAvailable }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);

  const handleCreate = async (
    spec: { name: string; workspaceRoot: string; workspaceSubdir: string; profileName: string },
    setStatus: (msg: string) => void
  ) => {
    let env: Record<string, string> = {};
    const labelProfile = spec.profileName || 'oauth';

    if (spec.profileName) {
      const profile = await window.api.vault.get(spec.profileName);
      if (!profile) {
        throw new Error(
          `No vault profile "${spec.profileName}". Add one in Profiles first, or leave the field blank to use Claude.ai login.`
        );
      }
      if (profile.apiKey) {
        env = { ANTHROPIC_API_KEY: profile.apiKey };
      }
    }

    await window.api.docker.ensureImage(({ message }) => setStatus(message));
    setStatus('Creating container…');
    await window.api.docker.create({
      name: spec.name,
      workspaceRoot: spec.workspaceRoot,
      workspaceSubdir: spec.workspaceSubdir,
      profile: labelProfile,
      env
    });
    onCreated();
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
      <button onClick={() => setCreateOpen(true)}>+ New container</button>
      {vaultAvailable !== false && (
        <button onClick={() => setProfilesOpen(true)}>Profiles…</button>
      )}
      <CreateContainerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
      {vaultAvailable !== false && (
        <ProfilesDialog open={profilesOpen} onClose={() => setProfilesOpen(false)} />
      )}
    </aside>
  );
}
