// Composition root (ADR-025): the only place application <-> infrastructure wiring lives.
// M0 stub: proves the context boots and the lifecycle channels exist. Its job is to be boring.
export function bootstrapBackground(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    // First-run marker (E4-T11 will own onboarding; recovery marker semantics live in E2-T07).
    // Until then: record version so update-vs-crash disambiguation (EES-R16) has its input.
    void chrome.storage.local.set({
      'meta.buildMarker': { reason: details.reason, at: Date.now() },
    });
  });
}
