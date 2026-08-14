// Renderer-side perf recording gate (perf telemetry Phase 2). Module
// singleton: one perf:state subscription + one initial perf:status pull for
// the whole window; terminal sessions consult perfRecording() per event.
// Defaults to OFF until told otherwise — worst case the first seconds of
// samples after startup are lost, never spurious work while disabled.

let recording = false;
let initialized = false;

export function initPerfState(): void {
  if (initialized) return;
  initialized = true;
  window.api.perf.onState((r) => {
    recording = r;
  });
  void window.api.perf
    .status()
    .then((s) => {
      recording = s.enabled;
    })
    .catch(() => {});
}

export function perfRecording(): boolean {
  return recording;
}

/** Test seam: perfState is module-global; tests must reset between cases. */
export function __resetPerfStateForTests(): void {
  recording = false;
  initialized = false;
}
