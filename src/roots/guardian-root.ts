// E4 · Guardian composition root (ADR-025): the ONLY place the guardian surface
// meets chrome. The root binds the narrow seams (transport, entropy, wake) and
// hands them to the authority-free surface — surfaces never see the `chrome`
// global (A-02 containment); this file is the sanctioned crossing.
import type { WireTransport } from '@/surfaces/components/session/client.js';
import type { CidEntropy } from '@/surfaces/components/session/ids.js';
import { mountGuardian, type GuardianDeps, type Mounted } from '@/surfaces/guardian/guardian.js';

export interface GuardianRootDeps {
  readonly transport?: WireTransport | undefined;
  readonly entropy?: CidEntropy | undefined;
  readonly onWake?: ((listener: () => void) => () => void) | undefined;
  readonly contractHash?: string | undefined;
}

/** chrome.runtime channel (sendMessage + onMessage): the §3.1/§3.5 wire, roots-side. */
export function composeGuardianTransport(): WireTransport {
  return {
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
  };
}

export function composeGuardianEntropy(): CidEntropy {
  return {
    now: () => Date.now(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  };
}

/** MV3 reconnect seam: a visible-again page re-reads its snapshots (streams are
 *  fire-and-forget; a full snapshot rejoin after SW sleep is the honest resume). */
export function composeGuardianWake(doc: Document): (listener: () => void) => () => void {
  return (listener) => {
    const onVisible = (): void => {
      if (doc.visibilityState === 'visible') listener();
    };
    const onFocus = (): void => listener();
    doc.addEventListener('visibilitychange', onVisible);
    doc.defaultView?.addEventListener('focus', onFocus);
    return () => {
      doc.removeEventListener('visibilitychange', onVisible);
      doc.defaultView?.removeEventListener('focus', onFocus);
    };
  };
}

export function bootstrapGuardian(doc: Document, deps: GuardianRootDeps = {}): Mounted {
  const surfaceDeps: GuardianDeps = {
    transport: deps.transport ?? composeGuardianTransport(),
    entropy: deps.entropy ?? composeGuardianEntropy(),
    onWake: deps.onWake ?? composeGuardianWake(doc),
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  };
  return mountGuardian(doc, surfaceDeps);
}
