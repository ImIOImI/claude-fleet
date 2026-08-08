import { describe, expect, it } from 'vitest';
import { sanitizePerfSamples } from './perfSamples.js';

describe('sanitizePerfSamples', () => {
  it('passes a well-formed payload through', () => {
    expect(
      sanitizePerfSamples({ sessionId: 'handle-1', samples: [{ kind: 'echo_rtt', durMs: 42.5 }, { kind: 'output_hop', durMs: 3 }] })
    ).toEqual({ sessionId: 'handle-1', samples: [{ kind: 'echo_rtt', durMs: 42.5 }, { kind: 'output_hop', durMs: 3 }] });
  });

  it('rejects malformed payloads outright', () => {
    expect(sanitizePerfSamples(null)).toBeNull();
    expect(sanitizePerfSamples('x')).toBeNull();
    expect(sanitizePerfSamples({ sessionId: 7, samples: [] })).toBeNull();
    expect(sanitizePerfSamples({ sessionId: 's', samples: 'nope' })).toBeNull();
  });

  it('drops invalid entries but keeps valid ones', () => {
    expect(
      sanitizePerfSamples({
        sessionId: 's',
        samples: [
          { kind: 'input_hop', durMs: 5 },        // renderer may not claim input_hop
          { kind: 'echo_rtt', durMs: -1 },         // negative
          { kind: 'echo_rtt', durMs: Infinity },   // non-finite
          { kind: 'echo_rtt', durMs: 999999 },     // absurd (> 60s)
          { kind: 'echo_rtt', durMs: 42 },         // valid
          'garbage'                                 // non-object
        ]
      })
    ).toEqual({ sessionId: 's', samples: [{ kind: 'echo_rtt', durMs: 42 }] });
  });

  it('caps a batch at 1000 samples', () => {
    const samples = Array.from({ length: 2000 }, () => ({ kind: 'echo_rtt', durMs: 1 }));
    expect(sanitizePerfSamples({ sessionId: 's', samples })!.samples).toHaveLength(1000);
  });
});
