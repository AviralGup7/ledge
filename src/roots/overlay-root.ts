// E4 · Overlay composition root (ADR-025): wires the reflex-search surface to the
// chrome channel, the timer seam (debounce), and the panel teardown seam. The
// surface itself stays authority-free and chrome-free.
import type { WireTransport } from '@/surfaces/components/session/client.js';
import type { CidEntropy } from '@/surfaces/components/session/ids.js';
import { mountOverlay, type Mounted, type OverlayDeps } from '@/surfaces/overlay/overlay.js';
/** Overlay chrome bindings (roots-are-terminus: each root wires itself). */
const composeOverlayTransport = (): WireTransport => ({
  send: (message) =>
    new Promise<unknown>((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response: unknown) => {
          const lastError = chrome.runtime.lastError;
          if (lastError !== undefined) reject(new Error(lastError.message));
          else resolve(response);
        });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }),
  listen: (listener) => {
    const handler = (raw: unknown): void => {
      listener(raw);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
    };
  },
});

const composeOverlayEntropy = (): CidEntropy => ({
  now: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
});

export interface OverlayRootDeps {
  readonly transport?: WireTransport | undefined;
  readonly entropy?: CidEntropy | undefined;
  readonly debounce?: ((delayMs: number, fn: () => void) => () => void) | undefined;
  readonly close?: (() => void) | undefined;
  readonly contractHash?: string | undefined;
}

/** Platform debounce: one trailing timer per caller, cancellable (overlay input). */
export function composeOverlayDebounce(): (delayMs: number, fn: () => void) => () => void {
  return (delayMs, fn) => {
    const handle = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(handle);
    };
  };
}

/** Teardown seam: the overlay page closes itself after its one gesture. */
export function composeOverlayClose(doc: Document): () => void {
  return () => {
    doc.defaultView?.close();
  };
}

export function bootstrapOverlay(doc: Document, deps: OverlayRootDeps = {}): Mounted {
  const surfaceDeps: OverlayDeps = {
    transport: deps.transport ?? composeOverlayTransport(),
    entropy: deps.entropy ?? composeOverlayEntropy(),
    debounce: deps.debounce ?? composeOverlayDebounce(),
    close: deps.close ?? composeOverlayClose(doc),
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  };
  return mountOverlay(doc, surfaceDeps);
}
