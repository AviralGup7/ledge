// E2-T11 · compaction policy (PURE — no IO, no clocks; every law golden-testable).
import { fnv1a64, stableStringify } from '@/shared-kernel/canon/index.js';
import type { JournalEntryRecord, JournalSegmentRecord } from '../core/types.js';
import type { CompactionPlan, ExcludedMatch, PurgeChainRef } from './types.js';

/** Audit sample bound (counts + digest always carry the whole story). */
export const EXCLUDED_SAMPLE_CAP = 100;
/** Default chunk width in segments per transaction (L7 chunked law). */
export const CHUNK_SEGMENTS_DEFAULT = 4;

const MAX_PAYLOAD_DEPTH = 8;

/**
 * SUBJECT MATCH (L2's semantics) — a payload references a purged entity iff the
 * entity id occurs as a COMPLETE string value anywhere inside the payload:
 * whole-value equality at any depth, string-array elements included. Deliberate
 * conservatism:
 *   - never substring (a note/title QUOTING an id is not a reference to it);
 *   - never key-restricted (the extractor is event-type-agnostic by design —
 *     the §4 catalog grows new subject-carrying fields without a policy edit);
 *   - plain-data payloads only (registry-frozen); depth-capped defensively.
 */
export const payloadMatchesId = (payload: unknown, id: string): boolean => {
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > MAX_PAYLOAD_DEPTH || value === null) return false;
    if (typeof value === 'string') return value === id;
    if (Array.isArray(value)) return value.some((item) => walk(item, depth + 1));
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some((item) => walk(item, depth + 1));
    }
    return false;
  };
  return walk(payload, 0);
};

/** First chain (in PLAN order) whose id the payload references, if any. */
const matchingChain = (
  payload: unknown,
  chains: readonly PurgeChainRef[],
): PurgeChainRef | undefined => chains.find((chain) => payloadMatchesId(payload, chain.id));

/**
 * L2+L4 projection: partition a segment's entries into survivors + exclusions.
 * An entry drops iff it is BOTH horizon-eligible (seq ≤ throughSeq) AND its
 * payload references a committed purge chain. A match ABOVE the horizon stays
 * (recent-truth tail law L4: those bytes are never touched by a sweep).
 */
export const excludeEntries = (
  entries: readonly JournalEntryRecord[],
  throughSeq: number,
  chains: readonly PurgeChainRef[],
): { kept: JournalEntryRecord[]; excluded: ExcludedMatch[] } => {
  const kept: JournalEntryRecord[] = [];
  const excluded: ExcludedMatch[] = [];
  for (const entry of entries) {
    const chain = entry.seq <= throughSeq ? matchingChain(entry.event.payload, chains) : undefined;
    if (chain === undefined) {
      kept.push(entry);
    } else {
      excluded.push({
        seq: entry.seq,
        batchIndex: entry.batchIndex,
        eventId: entry.event.eventId as string,
        chainKind: chain.kind,
        chainId: chain.id,
      });
    }
  }
  return { kept, excluded };
};

/** Plan identity (L5 resume law): order of CHAINS is normalized first. */
export const digestOfPlan = (plan: CompactionPlan): string => {
  const chains = [...plan.purgeChains]
    .map((c) => ({ kind: c.kind, id: c.id, purgedAt: c.purgedAt, purgeEpoch: c.purgeEpoch }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return fnv1a64(
    stableStringify({
      deviceId: plan.deviceId as string,
      throughSeq: plan.throughSeq,
      chains,
    }),
  );
};

const HEX_RADIX = 16;
/** fnv1a64 hex width (64-bit ⇒ 16 nibbles). */
const FNV_HEX_WIDTH = 16;

/**
 * Commutative audit digest: XOR-fold of per-id hashes. Kill-resume law — the
 * digest must accumulate identically whether the sweep runs uninterrupted or
 * resumes after a kill with the matches partitioned across the boundary
 * (a sort-then-hash digest cannot fold; a xor-fold can).
 */
export const digestOfExcludedIds = (ids: readonly string[]): string => {
  let fold = 0n;
  for (const id of ids) {
    fold ^= BigInt(`0x${fnv1a64(id)}`);
  }
  return fold.toString(HEX_RADIX).padStart(FNV_HEX_WIDTH, '0');
};

/** Continue an existing fold with more ids (order-independent). */
export const foldExcludedInto = (digest: string, ids: readonly string[]): string => {
  let fold = BigInt(`0x${digest}`);
  for (const id of ids) {
    fold ^= BigInt(`0x${fnv1a64(id)}`);
  }
  return fold.toString(HEX_RADIX).padStart(FNV_HEX_WIDTH, '0');
};

export const EMPTY_EXCLUDED_DIGEST = digestOfExcludedIds([]);

/** Deterministic window chunking (segment order = seqStart — stream order). */
export const chunkWindow = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

/**
 * Window law (L1 + L4): the segment set compaction MAY touch — SEALED segments
 * carrying at least one entry at/≤ throughSeq. The open segment is never in
 * window, even when the horizon would reach into it: the sweep's jurisdiction
 * is sealed bytes (the one lawful sealed-mutation, L3); live-tail bytes become
 * eligible only once sealed + behind a later horizon. Eligibility INSIDE a
 * window segment still keys on seq ≤ throughSeq per entry (partial overlap).
 */
export const windowSegments = (
  segments: readonly JournalSegmentRecord[],
  deviceId: string,
  throughSeq: number,
): JournalSegmentRecord[] =>
  segments
    .filter((s) => (s.deviceId as string) === deviceId)
    .filter((s) => s.sealed)
    .sort((a, b) => a.seqStart - b.seqStart)
    .filter((s) => s.entries.some((entry) => entry.seq <= throughSeq));
