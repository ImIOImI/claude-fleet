// Parse the loadouts:addSource / loadouts:setSourceCredential error contract
// (#444). Electron carries only an Error's message across IPC, so main encodes
// the kind as a prefix: `needs-credential: <base>`, `credential-rejected: <base>
// (HTTP <n>)`, or `malformed-credential: <base>` (bad token/username shape,
// rejected before anything is stored — see loadoutSources.cleanCredential).

export const SOURCE_PRIVATE_PROMPT = 'This source is private. Add a token:';
export const SOURCE_MALFORMED_MESSAGE = 'That token contains spaces or invalid characters. Paste it again.';

export type SourceError =
  | { kind: 'needs-credential'; base: string; message: string }
  | { kind: 'credential-rejected'; base: string; status: number; message: string }
  | { kind: 'malformed-credential'; base: string; message: string }
  | { kind: 'other'; message: string };

const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/;

export function parseSourceError(err: unknown): SourceError {
  const raw = String((err as Error | undefined)?.message ?? err).replace(IPC_PREFIX, '');
  const need = /^needs-credential: (\S+)$/.exec(raw);
  if (need) return { kind: 'needs-credential', base: need[1], message: SOURCE_PRIVATE_PROMPT };
  const rejected = /^credential-rejected: (\S+) \(HTTP (\d+)\)$/.exec(raw);
  if (rejected) {
    return {
      kind: 'credential-rejected',
      base: rejected[1],
      status: Number(rejected[2]),
      message: `credential rejected (HTTP ${rejected[2]})`
    };
  }
  const malformed = /^malformed-credential: (\S+)$/.exec(raw);
  if (malformed) {
    return { kind: 'malformed-credential', base: malformed[1], message: SOURCE_MALFORMED_MESSAGE };
  }
  return { kind: 'other', message: raw };
}
