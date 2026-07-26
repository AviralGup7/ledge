// Quiet-page composition root (ADR-025 · E1-T12). The quiet page is a consumer-only
// surface — authority-free by law (ADR-005): it holds no storage, touches no Chrome
// APIs, and its stream subscriptions attach here when the projection hub lands
// (E2-T03). Its E1 composition is contract identity: the senderContext it will speak
// as and the hash-agreed hello material for the hub channel (§3.1, ADR-010).
import { computeContractHash, makeHello } from '@/application/contracts/index.js';
import type { Hello, SenderContext } from '@/application/contracts/index.js';

const QUIET_CONTEXT: SenderContext = 'quiet';

export interface QuietPageGraphDeps {
  /** Test seam: fixed contract hash (production computes from the live registry). */
  readonly contractHash?: string;
}

export interface QuietPageGraph {
  readonly context: SenderContext;
  /** Handshake material for the hub channel (§3.1 hash agreement, ADR-010). */
  readonly hello: Hello;
}

export function composeQuietPageGraph(deps: QuietPageGraphDeps = {}): QuietPageGraph {
  const hash = deps.contractHash ?? computeContractHash();
  return { context: QUIET_CONTEXT, hello: makeHello(QUIET_CONTEXT, hash) };
}

export function bootstrapQuietPage(): QuietPageGraph {
  return composeQuietPageGraph();
}

// ─── E4 · quiet-page surface composition ───────────────────────────────────────
// The E1 identity composition above is unchanged (roots.test's laws hold). The E4
// app mount is additive: this is where the quiet page meets chrome (A-02), as
// narrow seams injected into the authority-free surface.
import type { WireTransport } from '@/surfaces/components/session/client.js';
import type { CidEntropy } from '@/surfaces/components/session/ids.js';
import { mountQuietPage, type Mounted, type QuietDeps } from '@/surfaces/quiet-page/quiet.js';
/** Quiet-page chrome bindings (roots-are-terminus: each root wires itself). */
const composeQuietTransport = (): WireTransport => ({
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

const composeQuietEntropy = (): CidEntropy => ({
  now: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
});

const composeQuietWake =
  (doc: Document) =>
  (listener: () => void): (() => void) => {
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

export interface QuietAppDeps {
  readonly transport?: WireTransport | undefined;
  readonly entropy?: CidEntropy | undefined;
  readonly onWake?: ((listener: () => void) => () => void) | undefined;
  readonly contractHash?: string | undefined;
}

/** Unmount handle + the E1 identity graph, composed in one bootstrap. */
export interface QuietApp {
  readonly graph: QuietPageGraph;
  readonly mounted: Mounted;
}

export function bootstrapQuietPageApp(doc: Document, deps: QuietAppDeps = {}): QuietApp {
  const graph = bootstrapQuietPage();
  const surfaceDeps: QuietDeps = {
    transport: deps.transport ?? composeQuietTransport(),
    entropy: deps.entropy ?? composeQuietEntropy(),
    onWake: deps.onWake ?? composeQuietWake(doc),
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  };
  return { graph, mounted: mountQuietPage(doc, surfaceDeps) };
}
