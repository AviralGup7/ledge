// Workroom (offscreen document) composition root (ADR-008/025 · E1-T12). The workroom
// hosts the heavy lanes (AI jobs, import/export parsing) as they wire in E3+; its real
// E1 composition is the §3.6 liveness protocol over the message contract: the SW's
// EnsureWorkroom probe is answered with WorkroomReady. Validators run before dispatch
// (§3.1 rule a); unknown names are ignored, never thrown (rule b).
import {
  CONTRACT_V,
  computeContractHash,
  makeHello,
  validateMessage,
} from '@/application/contracts/index.js';
import type { Hello, MessageEnvelope, ValidationOutcome } from '@/application/contracts/index.js';
import { platformIds, type IdGenerator } from '@/shared-kernel/identity/index.js';

const WORKROOM_CONTEXT = 'offscreen' as const;

export interface WorkroomTransport {
  /** Push one validated envelope toward the SW (runtime channel in prod, stub in tests). */
  readonly send: (message: MessageEnvelope) => void;
}

export interface WorkroomGraphDeps {
  /** Outbound channel seam; production binds chrome.runtime.sendMessage. */
  readonly transport?: WorkroomTransport;
  /** cid generator seam for replies; production binds the platform generator. */
  readonly ids?: IdGenerator;
  /** Test seam: fixed contract hash (production computes from the live registry). */
  readonly contractHash?: string;
}

export interface WorkroomGraph {
  readonly context: typeof WORKROOM_CONTEXT;
  /** Handshake material for the hub channel (§3.1 hash agreement, ADR-010). */
  readonly hello: Hello;
  /**
   * Inbound dispatch — total over hostile input: any value yields a ValidationOutcome
   * (observable by the diagnostics lane once it lands; §3.1 rule b's ignore+log).
   */
  readonly dispatch: (raw: unknown) => ValidationOutcome;
}

const workroomReady = (cid: IdGenerator, contractHash: string): MessageEnvelope => ({
  v: CONTRACT_V,
  kind: 'event',
  name: 'WorkroomReady',
  cid: cid.nextId(),
  senderContext: WORKROOM_CONTEXT,
  // Executor lanes resolve real capabilities in E3+; an empty object claims none.
  payload: { capabilitiesResolved: {} },
  contractHash,
});

export function composeWorkroomGraph(deps: WorkroomGraphDeps = {}): WorkroomGraph {
  const transport = deps.transport ?? { send: () => undefined };
  const ids = deps.ids ?? platformIds;
  const contractHash = deps.contractHash ?? computeContractHash();
  return {
    context: WORKROOM_CONTEXT,
    hello: makeHello(WORKROOM_CONTEXT, contractHash),
    dispatch: (raw: unknown): ValidationOutcome => {
      const outcome = validateMessage(raw, { zone: 'zone0' });
      if (
        outcome.type === 'ok' &&
        outcome.message.name === 'EnsureWorkroom' &&
        outcome.message.senderContext === 'sw'
      ) {
        transport.send(workroomReady(ids, contractHash));
      }
      return outcome;
    },
  };
}

/**
 * Activate the workroom context. The listener registers synchronously (ADR-007) and
 * performs no async hold (it returns void, so MV3 never keeps the channel suspended).
 */
export function bootstrapWorkroom(): WorkroomGraph {
  const graph = composeWorkroomGraph({
    transport: {
      send: (message) => {
        void chrome.runtime.sendMessage(message);
      },
    },
  });
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    graph.dispatch(raw);
  });
  return graph;
}
