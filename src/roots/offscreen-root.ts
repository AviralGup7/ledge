// Workroom composition root. Hosts future heavy executors (AI jobs, import/export streaming).
// M0 stub: heartbeat only — SW owns our lifecycle; we run nothing uninvited.
export function bootstrapWorkroom(): void {
  chrome.runtime.onMessage.addListener((msg: { name?: string }) => {
    if (msg?.name === 'workroom.ping') {
      // Presence probe for OffscreenPort.isAlive(); reply handled by sendResponse contract in Tier 1.
    }
  });
}
