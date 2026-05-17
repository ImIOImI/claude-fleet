import keytar from 'keytar';

const SERVICE = 'claude-fleet';
const INDEX_KEY = '__profiles__';

export interface Profile {
  name: string;
  apiKey: string;
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await keytar.getPassword(SERVICE, INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function writeIndex(names: string[]): Promise<void> {
  await keytar.setPassword(SERVICE, INDEX_KEY, JSON.stringify(names));
}

export async function listProfileNames(): Promise<string[]> {
  return readIndex();
}

export async function getProfile(name: string): Promise<Profile | null> {
  try {
    const apiKey = await keytar.getPassword(SERVICE, name);
    if (apiKey) return { name, apiKey };
  } catch {
    // keyring unavailable (e.g., WSL without gnome-keyring); fall through to env
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return { name, apiKey: envKey };
  return null;
}

export async function setProfile(profile: Profile): Promise<void> {
  await keytar.setPassword(SERVICE, profile.name, profile.apiKey);
  const idx = await readIndex();
  if (!idx.includes(profile.name)) {
    idx.push(profile.name);
    await writeIndex(idx);
  }
}

export async function deleteProfile(name: string): Promise<void> {
  await keytar.deletePassword(SERVICE, name);
  const idx = (await readIndex()).filter((n) => n !== name);
  await writeIndex(idx);
}
