// E2-T09 · IDB fault injection (EES §8 "IDB latency injection") — a
// StorageEnginePort PROXY that sits between the consumer and the real engine
// and (a) delays every durability op by a deterministic seeded latency,
// (b) fails the Nth op with a planned, typed LedgeError. Three laws:
//
//   TYPED     — an injected failure is a catalog LedgeError with the plan's
//               code; details.chaosFault names the weapon (op + ordinal), so a
//               fault is never mistakable for a field bug.
//   ANNOTATED — every op the proxy sees lands in `observed` (ordinal, op kind,
//               latency applied): a replay of the run is re-derivable.
//   REVERSIBLE — the plan is immutable config; unwrapping = constructing a new
//               proxy (or none) over THE SAME engine. No hidden mutation.
//
// Determinism: the latency stream is a fixed LCG keyed by plan.seed — same
// seed ⇒ same latencies, in CI and on any machine. maxMs is deliberately tiny:
// the law under test is that durability outcomes are latency-INVARIANT, not
// that we simulate production p99.
import type {
  StorageEnginePort,
  StoreName,
  TxnMode,
  TxScope,
} from '@/application/ports/storage-engine.port.js';
import {
  err,
  ledgeError,
  type ErrorCode,
  type LedgeError,
  type Result,
} from '@/shared-kernel/result/index.js';

// LCG constants (Numerical Recipes mod-2^31 generator; named, never magic).
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;
const LCG_MODULUS = 2_147_483_648; // 2^31

export interface LatencyPlan {
  readonly seed: number;
  /** Inclusive upper bound of the per-op delay in ms (0 = no delay). */
  readonly maxMs: number;
}

export interface FailAtPlan {
  /** 1-based durability-op ordinal that must fail (open/txn/quota/persist/schemaVersion). */
  readonly ordinal: number;
  /** Catalog code the failure surfaces as (e.g. E_QUOTA for a quota-shaped IDB fault). */
  readonly code: ErrorCode;
  /** What the injected fault simulates, for details.what. */
  readonly what: string;
}

export interface FaultPlan {
  readonly latency?: LatencyPlan;
  readonly failAt?: FailAtPlan;
}

export interface OpObservation {
  readonly ordinal: number;
  readonly op: string;
  readonly latencyMs: number;
}

export interface FaultObservations {
  readonly ops: readonly OpObservation[];
  readonly injectedOrdinal: number | null;
}

export interface FaultyEngine {
  readonly engine: StorageEnginePort;
  readonly observed: FaultObservations;
}

const nextLcg = (x: number): number => (x * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wrap an already-constructed engine. The proxy never opens/closes on its own:
 * lifecycle stays the caller's law (open before wrap, close after unwrap —
 * close() is NOT an injected op and passes straight through).
 */
export const withFaults = (inner: StorageEnginePort, plan: FaultPlan): FaultyEngine => {
  const ops: OpObservation[] = [];
  let ordinal = 0;
  let lcgState = plan.latency?.seed ?? 0;
  let injectedOrdinal: number | null = null;

  const gate = async <T>(op: string, run: () => Promise<Result<T, LedgeError>>) => {
    ordinal += 1;
    let latencyMs = 0;
    if (plan.latency !== undefined) {
      lcgState = nextLcg(lcgState);
      latencyMs = lcgState % (plan.latency.maxMs + 1);
      if (latencyMs > 0) await sleep(latencyMs);
    }
    ops.push({ ordinal, op, latencyMs });
    const failAt = plan.failAt;
    if (failAt !== undefined && failAt.ordinal === ordinal) {
      injectedOrdinal = ordinal;
      // Flat primitive details (§3.2): the weapon is named in chaosOp/chaoOrdinal —
      // a fault is typed (catalog code via the kernel factory) and annotated.
      return err(
        ledgeError(failAt.code, { what: failAt.what, chaosOp: op, chaosOrdinal: ordinal }),
      );
    }
    return run();
  };

  const engine: StorageEnginePort = {
    open: () => gate('open', () => inner.open()),
    txn: <T>(scope: readonly StoreName[], mode: TxnMode, work: (tx: TxScope) => Promise<T>) =>
      gate(`txn:${scope.join('+')}:${mode}`, () => inner.txn(scope, mode, work)),
    quota: () => gate('quota', () => inner.quota()),
    persist: () => gate('persist', () => inner.persist()),
    schemaVersion: () => gate('schemaVersion', () => inner.schemaVersion()),
    close: () => inner.close(),
  };

  return {
    engine,
    observed: {
      ops,
      get injectedOrdinal() {
        return injectedOrdinal;
      },
    },
  };
};
