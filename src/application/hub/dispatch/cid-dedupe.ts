// E3-APP · EES §3.3 timeout law — "dispatch ack expectation ≤3s (else resend with same
// cid — dedupe by persisted cid cache, 10-min TTL)". This module is the dedupe half the
// dispatcher needs that is transport-independent: a bounded LRU of cid → terminal
// outcome with a 10-minute TTL. The mutations-durable half (park-class dedupe) lives in
// the intent ledger (ADr-011 cid dedupe law) — a resend of a park-class command replays
// the cached terminal AND the ledger's own dedupe is the durable backstop; this cache
// guarantees cheap, immediate constancy for every other command class.
/** Terminal result cached per cid (command name kept for mismatch defense). */
export interface CachedTerminal {
  readonly commandName: string;
  readonly recordedAt: number;
  readonly outcome: unknown;
}

export interface CidDedupeCache {
  /** Returns the cached terminal when present and fresh, else undefined (and forgets stale). */
  readonly lookup: (cid: string, commandName: string, now: number) => CachedTerminal | undefined;
  /** Record a terminal outcome for a cid (LRU insert). */
  readonly record: (cid: string, commandName: string, now: number, outcome: unknown) => void;
  readonly size: () => number;
}

/** §3.3 timeout-law constants. */
const CID_TTL_MS = 600_000; // 10 minutes
const CID_CACHE_CAP = 500;

export const createCidDedupeCache = (
  ttlMs: number = CID_TTL_MS,
  cap: number = CID_CACHE_CAP,
): CidDedupeCache => {
  const entries = new Map<string, CachedTerminal>();
  return {
    lookup: (cid, commandName, now) => {
      const hit = entries.get(cid);
      if (hit === undefined) return undefined;
      if (now - hit.recordedAt > ttlMs) {
        entries.delete(cid);
        return undefined;
      }
      // A resend ALWAYS repeats the same name by §3.1 shape; a name mismatch is a botched
      // client — never serve another command's terminal (fail-closed: caller re-executes).
      if (hit.commandName !== commandName) return undefined;
      // LRU refresh on hit.
      entries.delete(cid);
      entries.set(cid, hit);
      return hit;
    },
    record: (cid, commandName, now, outcome) => {
      entries.delete(cid);
      if (entries.size >= cap) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(cid, { commandName, recordedAt: now, outcome });
    },
    size: () => entries.size,
  };
};
