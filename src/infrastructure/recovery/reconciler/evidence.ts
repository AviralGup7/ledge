// E2-T06 · journal evidence scan — ONE ordered pass over the device stream that maps
// every pending intent to what the journal can prove about it (EES §2.13's
// command→observation mapping, made literal). Pure read; no decisions live here.
//
// What an "observation of command X" means is curated by policies.ts; this module
// only collects: (a) every event naming an intentId we care about (in stream order,
// byte-exact — complete-safe re-drives these through the ledger), (b) the external
// close observations with their tab identity links (R2), (c) the stream cursor the
// reconciler needs to stamp contiguous resolution events, (d) forward-tolerance
// counts (ADR-033 preserved unknowns are gaps to disclose, never blockers).
import type { JournalPort, JournalReadEvent } from '@/application/ports/journal.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId } from '@/shared-kernel/identity/index.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** One external close observation: TabClosedExternal + its mint-time identity. */
export interface CloseObservation {
  readonly browserTabId: number;
  readonly ledgeTabId: string;
  readonly seq: number;
}

/** Byte-exact stored events naming one intent, in stream order. */
export interface IntentEventTrail {
  readonly intentId: string;
  readonly events: readonly JournalReadEvent[];
  readonly types: readonly string[];
}

export interface DeviceEvidence {
  /** intentId → every stored event whose payload carries that intentId. */
  readonly intentTrails: ReadonlyMap<string, IntentEventTrail>;
  /** Ordered TabClosedExternal observations (browser id resolved via TabObserved). */
  readonly externalCloses: readonly CloseObservation[];
  /** Every browserTabId ever observed closed more than once is impossible by ingest
   *  finality law (B17); R2 still dedupes defensively at consumption time. */
  readonly closedBrowserTabIds: ReadonlySet<number>;
  /** Stream head for contiguous stamping: durableThrough + max lamport seen. */
  readonly durableThrough: number;
  readonly maxLamport: number;
  /** ADR-033 rows this build cannot upcast (disclosed, never blocking). */
  readonly preservedUnknown: number;
}

const EMPTY_TRAIL: IntentEventTrail = { intentId: '', events: [], types: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Read the intentId off any payload that carries one (catalog-agnostic). */
const intentIdOf = (envelope: EventEnvelope): string | null => {
  if (!isRecord(envelope.payload)) return null;
  const v = envelope.payload['intentId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/**
 * Full-stream evidence scan. Same read the hydration law mandates (readRange from
 * seq 0, this device — the journal is the ONLY source of truth the reconciler may
 * believe; sessions/probes are cross-checks, never proof).
 */
export const scanDeviceEvidence = async (
  journal: JournalPort,
  deviceId: DeviceId,
): Promise<Result<DeviceEvidence, LedgeError>> => {
  const read = await journal.readRange({ deviceId, fromSeq: 0 });
  if (!read.ok) return read;
  const trails = new Map<string, { events: JournalReadEvent[]; types: string[] }>();
  const closes: CloseObservation[] = [];
  const closedIds = new Set<number>();
  /** ledgeTabId → browserTabId (mint row is identity truth). */
  const browserOf = new Map<string, number>();
  let maxLamport = 0;

  for (const entry of read.value.events) {
    const { envelope } = entry;
    maxLamport = Math.max(maxLamport, envelope.hlc.lamport);
    if (envelope.type === 'TabObserved' && isRecord(envelope.payload)) {
      const ledgeTabId = envelope.payload['ledgeTabId'];
      const browserTabId = envelope.payload['browserTabId'];
      if (typeof ledgeTabId === 'string' && typeof browserTabId === 'number') {
        browserOf.set(ledgeTabId, browserTabId);
      }
    }
    if (envelope.type === 'TabClosedExternal' && isRecord(envelope.payload)) {
      const ledgeTabId = envelope.payload['ledgeTabId'];
      const browserTabId = typeof ledgeTabId === 'string' ? browserOf.get(ledgeTabId) : undefined;
      if (typeof ledgeTabId === 'string' && browserTabId !== undefined) {
        closes.push({ browserTabId, ledgeTabId, seq: entry.seq });
        closedIds.add(browserTabId);
      }
    }
    const intentId = intentIdOf(envelope);
    if (intentId !== null) {
      const trail = trails.get(intentId) ?? { events: [], types: [] };
      trail.events.push(entry);
      trail.types.push(envelope.type);
      trails.set(intentId, trail);
    }
  }

  const intentTrails = new Map<string, IntentEventTrail>();
  for (const [intentId, trail] of trails) {
    intentTrails.set(intentId, {
      intentId,
      events: trail.events,
      types: trail.types,
    });
  }

  return {
    ok: true,
    value: {
      intentTrails,
      externalCloses: closes,
      closedBrowserTabIds: closedIds,
      durableThrough: read.value.durableThrough,
      maxLamport,
      preservedUnknown: read.value.preservedUnknown.length,
    },
  };
};

export const trailFor = (evidence: DeviceEvidence, intentId: string): IntentEventTrail =>
  evidence.intentTrails.get(intentId) ?? { ...EMPTY_TRAIL, intentId };
