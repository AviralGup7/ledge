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
