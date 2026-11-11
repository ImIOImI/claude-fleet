// What a workspace's published transcripts are scrubbed of on the desktop (remote-workspaces §7).
import type { ScrubValue } from './scrub.js';

export interface VaultReader {
  listKeys(workspaceId: string): Promise<string[]>;
  getSecret(workspaceId: string, key: string): Promise<string | null>;
}

/** The vault bag plus the GitHub sign-in. Throws (so nothing is sent) when a declared secret can't be read. */
export async function publishSecretValues(
  spec: { id: string; env: { secretKeys: string[] } },
  vault: VaultReader,
  githubToken: () => Promise<string | null>
): Promise<ScrubValue[]> {
  const out: ScrubValue[] = [];
  const declared = new Set(spec.env.secretKeys);
  for (const key of new Set([...declared, ...(await vault.listKeys(spec.id))])) {
    const value = await vault.getSecret(spec.id, key);
    if (value) out.push({ key, value });
    else if (declared.has(key)) throw new Error(`secret ${key} can’t be read from the vault`);
  }
  const token = await githubToken();
  if (token) out.push({ key: 'GITHUB_TOKEN', value: token });
  return out;
}
