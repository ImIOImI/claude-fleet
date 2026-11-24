// What a workspace's published transcripts are scrubbed of on the desktop (remote-workspaces §7).
import { ENDPOINT_VAULT_PREFIX } from '../vaultScopes.js';
import type { ScrubValue } from './scrub.js';

/** endpoints.ts ENDPOINT_VAULT_KEY; that module needs Electron. */
const ENDPOINT_KEY = 'ANTHROPIC_AUTH_TOKEN';

export interface VaultReader {
  workspaceSecretValues(workspaceId: string): Promise<{ key: string; value: string }[]>;
  getSecret(workspaceId: string, key: string): Promise<string | null>;
}

/** The workspace's resolved vault bag, the model endpoint's API key and the GitHub sign-in.
 *  Throws (so nothing is sent) when an in-use secret can't be read. */
export async function publishSecretValues(
  spec: { id: string; authMode?: string; endpointId?: string },
  vault: VaultReader,
  githubToken: () => Promise<string | null>,
  endpoint: (id: string) => Promise<{ hasApiKey: boolean } | null> = async () => null
): Promise<ScrubValue[]> {
  const out: ScrubValue[] = [];
  out.push(...(await vault.workspaceSecretValues(spec.id)));
  if (spec.endpointId && (await endpoint(spec.endpointId))?.hasApiKey) {
    const value = await vault.getSecret(`${ENDPOINT_VAULT_PREFIX}${spec.endpointId}`, ENDPOINT_KEY);
    // Only an endpoint in use is required; a leftover endpointId (authMode switched away) is scrubbed when readable.
    if (value) out.push({ key: ENDPOINT_KEY, value });
    else if (spec.authMode === 'endpoint') throw new Error('the model endpoint’s API key can’t be read from the vault');
  }
  const token = await githubToken();
  if (token) out.push({ key: 'GITHUB_TOKEN', value: token });
  return out;
}
