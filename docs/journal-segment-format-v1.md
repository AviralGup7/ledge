# Ledge Journal Segment Format — v1

**Status:** locked covenant (formatV = 1) · **Date:** 2026-07-25 · **Gate:** M1 exit (G1)
**Owners:** `src/infrastructure/journal/**` · **Reads:** this spec is the journal row of EES §9 ("Docs: segment format spec") and the roadmap's M1 exit docs column.

This document is the versioned specification of the bytes Ledge's journal
persists. It describes the format **as implemented and gate-proven** — every
law below is executable in the repo (each section names its tripwire). A
format change is an ADR + a migration (E2-T04), never a silent edit.

---

## 1. Scope and stores

The journal occupies the `events` object store plus the journal-owned rows of
the `meta` object store (EES §5 inventory). All writes are single-IDB-txn
scoped (`events` + `meta` together); there is no ambient write handle.

| Row                    | Store    | Written by                             |
| ---------------------- | -------- | -------------------------------------- |
| `JournalSegmentRecord` | `events` | appender (append), compactor (rewrite) |
| `journalHeads`         | `meta`   | appender (per batch, hinge last)       |
| `journal.idem.<key>`   | `meta`   | appender (idempotency ledger)          |
| `checkpointPtrs`       | `meta`   | scanner `checkpoint()`                 |
| `purgeEpoch`           | `meta`   | compactor (E2-T11 baselines)           |
| `schemaV`              | `meta`   | storage engine open (ADR-034 anchor)   |

Unknown fields **round-trip preserved** by the engine (structured clone, no
field mapping). Readers must tolerate additive-optional fields materializing
ABSENT, never defaulted-in.
_Tripwire:_ `ops/fixtures/storage/unknown-field.golden.json` contract suite.

## 2. Record shapes

### 2.1 `JournalSegmentRecord` (`core/types.ts`)

| Field       | Type                   | Law                                                                                               |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `segmentId` | string                 | `segmentIdFor(deviceId, seqStart)` = `"<deviceId>:<seqStart>"` — the addressing covenant.         |
| `deviceId`  | DeviceId (26-char Id)  | One segment belongs to exactly one device stream.                                                 |
| `seqStart`  | safe integer ≥ 1       | `hlc.seq` of the segment's first entry; frozen at creation (never rewritten, even by compaction). |
| `sealed`    | boolean                | Sealed bytes are immutable (see §5 exception).                                                    |
| `formatV`   | `1`                    | This document's version row. Anything else ⇒ suspect `format-unknown`.                            |
| `entries`   | `JournalEntryRecord[]` | ≤ `SEGMENT_ENTRY_CAP = 500`; stream-ordered.                                                      |
| `crc`       | 8-hex-char CRC-32      | See §4.                                                                                           |

### 2.2 `JournalEntryRecord`

| Field        | Type           | Law                                                                                  |
| ------------ | -------------- | ------------------------------------------------------------------------------------ |
| `seq`        | integer ≥ 1    | Entry's `hlc.seq`.                                                                   |
| `batchIndex` | integer ≥ 0    | Position within its append batch; segments may pack several batches.                 |
| `v`          | schema version | `CURRENT_SCHEMA_VERSION` at append time.                                             |
| `event`      | EventEnvelope  | The registered event (payload plain-data; unknown types/versions preserved on read). |

## 3. Stream (chain) laws — per device

1. **Origin:** the stream starts at `seq = 1` (full-walk origin; with a
   compaction baseline the origin may land late — §7 L6).
2. **Dense chaining:** consecutive entries (flattened in segment order,
   across segment boundaries) satisfy `next.seq === prev.seq + 1`, except
   lawful purge gaps at/≤ the active baseline's horizon (§7 L6).
3. **Batch discipline:** within equal `seq`, `batchIndex` strictly climbs
   (`entry-gap` otherwise).
4. **Device purity:** every entry's `hlc.deviceId` equals the stream device
   (`boundary-drift` otherwise).
5. **Lamport:** never decreases within a device journal
   (`lamport-regression` otherwise; EES §2.2).
6. **Seal law:** at most one unsealed segment per device, and it is the LAST
   in `seqStart` order (`seal-law` otherwise).
7. **Head anchor:** meta `journalHeads[deviceId] = { lastSeq, lastLamport,
openSegmentId }` must agree with the computed stream tail (`head-drift`
   otherwise: open segment id mismatch, or `lastSeq` ≠ tail entry seq).

_Tripwires:_ `journal.integrity.test.ts`, `journal.integrity.property.test.ts`.

## 4. CRC-32 image

`crc = crc32Hex(stableStringify(image))` where `image` covers **exactly**
the explicit field list
`[segmentId, deviceId, seqStart, sealed, formatV, entries]` — the list is a
literal, not a rest-spread, so any new un-checksummed field trips the census
test (`crcCoveredFields()` vs `Object.keys(record) − {crc}`).

- Recomputed on **every** open-segment mutation (`withFreshCrc`).
- Frozen at seal; the open segment always self-verifies.
- `verifySegmentCrc` refusal is total: `readRange` throws
  `segment-crc-mismatch` rather than serve bytes the checksum cannot vouch
  for; `scanFull`/`scanTail` report `crc-mismatch` suspects (with expected/actual).

_Tripwires:_ CRC field census test; seeded bit-flip walk
(`journal.integrity.*`), chaos corrupted seeds (bit-rot / crc-flip).

## 5. Append, seal, and the one sealed-byte exception

- **Batch-atomic packing:** a batch must fit one segment
  (`oversized-batch`, cap 500); per batch: contiguity
  `firstSeq === head.lastSeq + 1` (`seq-gap-vs-head`), homogeneous device,
  dense +1 within the batch (`seq-not-contiguous`), lamport monotone.
- **Rollover:** appending past the cap seals the open segment and starts a
  fresh one at the next `seqStart`.
- **Write classes per batch (one txn):** segment record + stream head +
  `journal.idem.<key>` row `{ ack: { count, deviceId, fromSeq, toSeq },
batchHash }`; the ack resolves only after commit. A used key with a
  different batch hash ⇒ `idempotency-key-reuse`.
- **Sealed immutability — the one exception (ADR-020b):** the compaction
  purge-exclusion rewrite may rewrite a SEALED segment, only horizon-gated,
  epoch-tagged, baseline-gated (§7), with survivors re-checksummed and
  fully-excluded rows physically deleted. No other code path mutates sealed
  bytes; the T09 chaos driver explicitly corrupts sealed bytes store-direct
  and the scanner must name the damage.

## 6. Read and scan semantics

| Op           | Semantics                                                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readRange`  | Gap-tolerant. Serves `(seq, batchIndex)`-ordered entries within `[fromSeq, toSeq]` clamped to the head (acked ⇔ visible). CRC-verified per segment in range; overlap with a mismatched segment is refused. Unknown event versions/types surface as `preserved` rows (never dropped, never served as known). |
| `scanTail`   | Post-checkpoint window only (WAL design; ≤50 ms law). Same law set as a full walk over its window.                                                                                                                                                                                                          |
| `scanFull`   | Every byte, from origin (or baseline-adjusted origin). Returns `JournalIntegrityReport`: `status: 'ok' \| 'suspect'`, `coverage`, suspects, per-device summaries.                                                                                                                                           |
| `checkpoint` | Runs `scanFull` first; **refuses to stamp over suspect bytes** (§2.8). Stamps per device `{ deviceId, throughSeq: head.lastSeq, lastSegmentId: <last segment in stream order>, crc: <that segment's crc> }`. Idempotent.                                                                                    |

**Suspect reason census (`SegmentSuspectReason`):** `crc-mismatch` ·
`format-unknown` · `chain-sequence` · `seal-law` · `head-drift` ·
`lamport-regression` · `entry-gap` · `boundary-drift`. (§3 names each.)

## 7. Compaction baselines (`meta.purgeEpoch`, E2-T11)

EES §5 names this row `purgeEpoch` (TrashPurged: "purgeEpoch recorded in
meta"). Value: `Record<deviceId, CompactionBaseline>`:

| Field             | Law                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `schemaV: 1`      | Anything else ⇒ `compaction-baseline-unknown` (prosecuted, never migrated in place).                      |
| `status`          | `running` (a chunked sweep is in flight) \| `done`.                                                       |
| `epoch`           | Monotone per device.                                                                                      |
| `throughSeq`      | Exclusion horizon; **monotone non-decreasing** per device (regression ⇒ `compaction-horizon-regression`). |
| `planDigest`      | fnv1a64 of the canonical plan — resume/replay lawful for this plan only (`compaction-plan-conflict`).     |
| `cursorSeqStart`  | seqStart of the first unprocessed window segment; `null` = window exhausted (deletion-invariant anchor).  |
| `entriesExcluded` | Cumulative exclusions this epoch.                                                                         |
| `excludedDigest`  | XOR-fold of per-id fnv1a64 hashes (commutative ⇒ resume-safe audit).                                      |

Scanner law **L6**: with a baseline present (running or done), gaps at/≤
`throughSeq` are lawful purge exclusions — origin may land late, adjacent
pairs may skip up to `horizon + 1`; the strict +1 chain reasserts above.
Without a baseline the pre-compaction law is byte-for-byte. A baseline row is
written only once a first exclusion exists; a sweep that excludes nothing
leaves no row and no checkpoint (byte-true no-op).

## 8. Error vocabulary (journal family, `E_JOURNAL_INTEGRITY` raws)

Append path: `empty-batch` · `oversized-batch` · `hlc-malformed` ·
`cross-device-batch` · `seq-unsafe` · `lamport-unsafe` · `seq-not-contiguous`
· `lamport-regression` · `seq-gap-vs-head` · `idempotency-key-empty` ·
`idempotency-key-reuse`. Read path: `range-fromSeq-invalid` ·
`range-toSeq-invalid` · `segment-crc-mismatch` (thrown, txn aborted).
Compaction: `compaction-horizon-invalid` · `compaction-plan-empty` ·
`compaction-baseline-unknown` · `compaction-plan-conflict` ·
`compaction-horizon-regression` · `compaction-flip-lost-baseline`.
Checkpoint refuse: `checkpoint-over-suspect` (named with first suspect's segmentId).

## 9. Versioning covenant

`formatV = 1` is the only produced format. Readers: tolerate additive
optional fields (absent, never defaulted-in); preserve unknown
fields/types/versions on read; refuse unknown `formatV` with
`format-unknown` (a migration concern, ADR-034/E2-T04; N-1→N fixtures live
in `ops/fixtures/migrations/`). Any change to §2–§7 is an ADR,
a `formatV` bump, and new tripwires in the same PR — the census tests
(CRC fields, suspect reasons, meta keys via `check:errors`+checker suites)
fail loudly on drift.
