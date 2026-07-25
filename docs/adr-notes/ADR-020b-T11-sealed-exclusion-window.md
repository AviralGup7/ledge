# ADR-020b · E2-T11 — the ONE lawful sealed-byte mutation: purge-exclusion rewrite

**Status:** accepted (implementation note under ADR-020; does not amend ADR text)
**Date:** 2026-07-25
**Task:** E2-T11 journal compaction + purge exclusion

## Context

ADR-004 freezes a strong durability posture: sealed journal segments are immutable,
CRC-verified byte strings. ADR-020's purge law and EES §5 global law 4 demand the
opposite at one place: a committed purge MUST physically rewrite sealed segments,
excluding the purged events — masking is not a purge (EES §2.8 invariant:
"compaction performs physical exclusion of purged bytes"; Blueprint §14: property
tests asserting "purge ⇒ bytes absent").

This note records how E2-T11 reconciles the two laws without weakening either.

## Decision

The set of lawful sealed-byte mutations is exactly **one**: the compaction
purge-exclusion rewrite, and only under all of these guards:

1. **Horizon-gated** — entries with `seq ≤ throughSeq`, where `throughSeq` is
   strictly below the device head (`head.lastSeq`). The open tail is never in
   the sweep window (compact law L1).
2. **Epoch-tagged** — the sweep is owned by a `meta.purgeEpoch` baseline row:
   monotonic epoch per device, monotone non-decreasing horizon per device,
   `planDigest` binding resume/replay to exactly one plan (L5). A regression
   of horizon is prosecuted (`E_JOURNAL_INTEGRITY · compaction-horizon-regression`)
   because the scanner's gap tolerance is defined against the CURRENT baseline.
3. **Baseline-gated** — while a sweep runs, the running baseline is what makes
   purge gaps lawful to the integrity scanner (L6: gaps at/≤ the horizon are
   tolerated; the strict +1 chain law is reasserted above it). Without a
   baseline the pre-compaction law applies byte for byte.
4. **Chunked + kill-safe** — one IDB transaction per segment chunk; every
   inter-chunk state is scan-lawful; resume after a kill converges to the
   byte-identical end state (L7). The resume cursor is seqStart-anchored
   because fully-excluded segment rows are physically DELETED mid-sweep —
   index cursors shift under deletion, seq anchors do not.
5. **Audited** — every exclusion is counted, sampled (cap 100) and folded into
   a commutative (xor) digest so an interrupted sweep and an uninterrupted one
   arrive at the same audit fingerprint (roadmap R-02 "disclose precisely").

Everything else about sealed bytes is untouched: `seal()` still freezes the
CRC image, `readRange`/`scanFull`/`scanTail`/`checkpoint` verify exactly as
before, and the scanner's CRC law has no compaction exception — rewritten
survivors carry fresh CRCs over their new content.

## Consequences

- `JournalPort` grows `compact(plan)` + `compactionState(deviceId)`; the
  compactor lives in `src/infrastructure/journal/compact/` inside the existing
  writer-concentration family (no dep-policy change beyond T08's route note).
- The scanner gains ONE parameter (the per-device compaction baselines, read
  from `meta.purgeEpoch` — the key EES §5's meta-row inventory names). Every
  other journal law (append contiguity, CRC image census, checkpoint
  refusal-over-suspect-bytes, readRange gap tolerance) is unchanged.

## Regression policy artifacts

- `compact.test.ts` — unit law table (incl. window/horizon/digest/resume laws).
- `compact.property.test.ts` — "purged bytes absent", survivor identity,
  resume equivalence, append-after-compaction continuity.
- `compact.chaos.test.ts` — kill points `compact.segment-rewrite.mid`,
  `compact.baseline-flip.before`, `compact.checkpoint.mid` (added to
  `ops/chaos/points.txt`; owner partition extended to three suites).
