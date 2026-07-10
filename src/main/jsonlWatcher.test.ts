// Unit tests for parseTranscriptFilename — the pure helper that maps a
// watched file path to { sessionId, sidecar } or null. The sidecar flag
// controls whether 'new-session' fires and whether the mirror write runs.
// (#207: <uuid>.fleet.jsonl sidecar support for Stop-hook chapter summaries)

import { describe, expect, it } from 'vitest';
import { parseTranscriptFilename } from './jsonlWatcher.js';

describe('sidecar filename routing (#207)', () => {
  const U = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('routes <uuid>.jsonl as a primary transcript', () => {
    expect(parseTranscriptFilename(`/x/${U}.jsonl`)).toEqual({ sessionId: U, sidecar: false });
  });

  it('routes <uuid>.fleet.jsonl to the same session as a sidecar', () => {
    expect(parseTranscriptFilename(`/x/${U}.fleet.jsonl`)).toEqual({ sessionId: U, sidecar: true });
  });

  it('rejects non-uuid stems', () => {
    expect(parseTranscriptFilename('/x/notes.jsonl')).toBeNull();
    expect(parseTranscriptFilename('/x/junk.fleet.jsonl')).toBeNull();
  });

  it('rejects non-jsonl extensions', () => {
    expect(parseTranscriptFilename(`/x/${U}.txt`)).toBeNull();
    expect(parseTranscriptFilename(`/x/${U}.json`)).toBeNull();
  });

  it('rejects bare path with no filename', () => {
    expect(parseTranscriptFilename('/x/')).toBeNull();
    expect(parseTranscriptFilename('')).toBeNull();
  });
});
