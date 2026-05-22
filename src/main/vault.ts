const SERVICE = 'claude-fleet';
const INDEX_KEY = '__profiles__';

export interface Profile {
  name: string;
  apiKey: string;
}

// keytar links libsecret-1.so.0 at module load on Linux. Loading it lazily and
// catching the dlopen failure lets the rest of the app survive on systems
// without it (bare WSL, CI without libsecret-1-0). isVaultAvailable() reports
// the resulting state so the UI hides the Profiles dialog and the env fallback
// in getProfile keeps create-container working.
type Keytar = typeof import('keytar');
let cachedKeytar: Keytar | null | undefined;
async function loadKeytar(): Promise<Keytar | null> {
  if (cachedKeytar !== undefined) return cachedKeytar;
  try {
    const mod = await import('keytar');
    cachedKeytar = (mod.default ?? mod) as Keytar;
  } catch {
    cachedKeytar = null;
  }
  return cachedKeytar;
}

async function readIndex(): Promise<string[]> {
  const kt = await loadKeytar();
  if (!kt) return [];
  try {
    const raw = await kt.getPassword(SERVICE, INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function writeIndex(names: string[]): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error('Vault unavailable (libsecret missing or keyring unreachable).');
  await kt.setPassword(SERVICE, INDEX_KEY, JSON.stringify(names));
}

export async function listProfileNames(): Promise<string[]> {
  return readIndex();
}

export async function getProfile(name: string): Promise<Profile | null> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      const apiKey = await kt.getPassword(SERVICE, name);
      if (apiKey) return { name, apiKey };
    } catch {
      // keyring API failure — fall through to env fallback
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return { name, apiKey: envKey };
  return null;
}

export async function setProfile(profile: Profile): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error('Vault unavailable (libsecret missing or keyring unreachable).');
  await kt.setPassword(SERVICE, profile.name, profile.apiKey);
  const idx = await readIndex();
  if (!idx.includes(profile.name)) {
    idx.push(profile.name);
    await writeIndex(idx);
  }
}

export async function deleteProfile(name: string): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error('Vault unavailable (libsecret missing or keyring unreachable).');
  await kt.deletePassword(SERVICE, name);
  const idx = (await readIndex()).filter((n) => n !== name);
  await writeIndex(idx);
}

let probeResult: boolean | null = null;
export async function isVaultAvailable(): Promise<boolean> {
  if (probeResult !== null) return probeResult;
  const kt = await loadKeytar();
  if (!kt) {
    probeResult = false;
    return false;
  }
  try {
    await kt.getPassword(SERVICE, '__probe__');
    probeResult = true;
  } catch {
    probeResult = false;
  }
  return probeResult;
}
