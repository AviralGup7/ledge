// E3-APP · Mission deliverable "structured logging" — every application command logs
// a structured envelope (E3 observability law: progress, cancellation, TIMING, logging,
// one envelope per command). The sink is an application port shape: the diagnostics
// tier (EES §2.15 logs-ring, 500 rolling) attaches a store-backed sink later; tests and
// v1 attach the in-memory ring exported here.
import type { LedgeError } from '@/shared-kernel/result/index.js';

/** Structured entry per executed command/query (log keys are data, never copy). */
export interface CommandLogEntry {
  readonly cid: string;
  readonly name: string;
  readonly kind: 'command' | 'query';
  readonly senderContext: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: 'applied' | 'failed' | 'ignored' | 'cancelled';
  readonly lane: 'interactive' | 'maintenance';
  readonly errorCode?: LedgeError['code'] | undefined;
}

/** Sink port — implementations are diagnostics-tier storage or the in-memory ring. */
export interface StructuredLogSink {
  readonly write: (entry: CommandLogEntry) => void;
}

/** §2.15 ring law mirror (500 rolling) at the application boundary. */
const RING_CAP = 500;

/** In-memory ring sink — deterministic in tests; ready to be flushed off-context. */
export const createRingLogSink = (
  cap: number = RING_CAP,
): StructuredLogSink & { readonly entries: () => readonly CommandLogEntry[] } => {
  const ring: CommandLogEntry[] = [];
  return {
    write: (entry) => {
      if (ring.length >= cap) ring.shift();
      ring.push(entry);
    },
    entries: () => [...ring],
  };
};

/** Multi-sink fan-out (ring + future diagnostics store sink). */
export const fanOutSinks = (sinks: readonly StructuredLogSink[]): StructuredLogSink => ({
  write: (entry) => {
    for (const sink of sinks) sink.write(entry);
  },
});
