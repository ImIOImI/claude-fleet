// What a workspace's published transcripts are scrubbed of on the desktop (remote-workspaces §7).
import { ENDPOINT_VAULT_PREFIX } from '../vaultScopes.js';
import type { ScrubValue } from './scrub.js';

/** endpoints.ts ENDPOINT_VAULT_KEY; that module needs Electron. */
const ENDPOINT_KEY = 'ANTHROPIC_AUTH_TOKEN';

export interface VaultReader {
  listKeys(workspaceId: string): Promise<string[]>;
  getSecret(workspaceId: string, key: string): Promise<string | null>;
}

/** The vault bag, the model endpoint's API key and the GitHub sign-in. Throws (so nothing is sent) when a declared or in-use secret can't be read. */
export async function publishSecretValues(
  spec: { id: string; env: { secretKeys: string[] }; endpointId?: string },
  vault: VaultReader,
  githubToken: () => Promise<string | null>,
  endpoint: (id: string) => Promise<{ hasApiKey: boolean } | null> = async () => null
): Promise<ScrubValue[]> {
  const out: ScrubValue[] = [];
  const declared = new Set(spec.env.secretKeys);
  for (const key of new Set([...declared, ...(await vault.listKeys(spec.id))])) {
    const value = await vault.getSecret(spec.id, key);
    if (value) out.push({ key, value });
    else if (declared.has(key)) throw new Error(`secret ${key} can’t be read from the vault`);
  }
  if (spec.endpointId && (await endpoint(spec.endpointId))?.hasApiKey) {
    const value = await vault.getSecret(`${ENDPOINT_VAULT_PREFIX}${spec.endpointId}`, ENDPOINT_KEY);
    if (!value) throw new Error('the model endpoint’s API key can’t be read from the vault');
    out.push({ key: ENDPOINT_KEY, value });
  }
  const token = await githubToken();
  if (token) out.push({ key: 'GITHUB_TOKEN', value: token });
  return out;
}
