# Ledge Recovery Runbook — v0

**Status:** v0 (M1 gate doc) · **Date:** 2026-07-25 · **Gate:** M1 exit (G1)
**Row:** EES §9 recovery ("Docs: runbook") · EES §8 failure-row coverage
("each §9 failure row has a runbook doc" — this is the v0 consolidation).
**Companion:** [journal-segment-format-v1.md](./journal-segment-format-v1.md) (byte-level vocabulary).

Scope: what the system guarantees on failure, how to read its disclosures,
and the lawful operator actions. Ledge is local-first — the "operator" is
engineering on-call reading a user's diagnostics bundle, not a server team.

**The invariant above all (ADR-004 / journal.port law):** never silent
truncation of user truth. Conservative paths write NOTHING, name the damage
precisely, and degrade. When in doubt: capture, don't touch.

---

## 1. Diagnostic artifacts (where the truth is disclosed)

| Artifact                 | Producer                                       | Read it for                                                               |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `BootReport`             | `recovery/reconciler` (every boot, always)     | `outcome` (clean / reconciled / recovered), `gaps`, resolutions, lossRisk |
| `BootSignal`             | `recovery/marker` classify                     | `cause` + `evidence` (stamps consulted)                                   |
| `JournalIntegrityReport` | `journal.scanFull / scanTail`                  | suspects with exact `segmentId` + reason + expected/actual CRC            |
| `CompactionReport`       | `JournalPort.compact`                          | epoch, exclusions, `excludedDigest`, checkpoints restamped                |
| `CompactionBaseline`     | `meta.purgeEpoch` / `compactionState`          | running vs done sweeps, cursor, totals                                    |
| `ProjectionStatus`       | `projections.status()`                         | per-view watermarks, `dirty` set                                          |
| G1 evidence golden       | `ops/chaos/evidence/g1-chaos-evidence.v1.json` | reproducibility baseline of every kill point + corrupted seed             |

## 2. Boot classification (marker semantics, EES-R16)

Wake phases per boot: onInstalled stamp (install events) → arm alive
(session storage) → boot stamp (local storage). Next boot's classification:

| Signal         | Condition (evidence)                                                               | Copy gate (lossRisk=true) |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `first-run`    | no install stamp, no boot stamp (virgin or collapsed)                              | null (invisible)          |
| `warm-recycle` | alive marker present — session never died (SW recycle only)                        | null (invisible)          |
| `updated`      | fresh install stamp: `reason ≠ install`, version moved, or install newer than boot | `msg.recovery.updated`    |
| `crashed`      | none of the above: last completed cycle's stamps, no update evidence               | `msg.recovery.crashed`    |

Without loss risk, abnormal classes render `msg.heartbeat.recovered`
(quiet), never a card. **R16 no-double:** a later same-build restart after an
`updated` classification is `crashed`, never `updated` again.
Kill points: `boot.marker.arm` (armed, not stamped — previous cycle governs),
`boot.marker.stamp` (truncated update wake — fresh stamp governs).

## 3. Boot outcomes (reconciler)

- **clean** — nothing dangling; zero resolutions.
- **reconciled** — ≥1 intent resolved: `completed-safe` (effect provably
  committed), `completed-evidence` (evidence secured, `securedCounted` —
  dedupe law), `aborted-conservative` (`liveLeftOpen`, evidence tabs
  preserved), `deferred` (not decidable yet — next boot retries).
- **recovered** — degraded path taken; `gaps[]` names why:
  `integrity-probe:<code>` (e.g. `journal-probe-failed`) or `evidence-scan:<...>`.
  **Conservative law: on degraded truth the reconciler writes NOTHING** —
  zero resolutions, journal byte-frozen (the T09 corrupted-seed rows prove
  it). The evidence scan is skipped entirely when the probe is degraded:
  acting on unverified truth is forbidden.

## 4. Failure rows → playbooks

### R1 · Journal integrity suspect (`scanFull/scanTail` = `suspect`)

Reason census and meaning: `crc-mismatch` (byte drift/torn write in that
segment) · `format-unknown` (foreign `formatV` — migration concern) ·
`chain-sequence` (seq gap with NO baseline ⇒ lost/dup bytes) · `seal-law`
(open segment not at tail) · `head-drift` (anchor disagrees with bytes —
truncation class) · `lamport-regression` (clock law breach) · `entry-gap`
(batchIndex dup within seq — torn dup territory) · `boundary-drift`
(entry carries another device's id).
**Operator:** capture the full report + `meta.journalHeads`; do NOT hand-edit
IDB. Damage below the suspect stays served byte-honest (prefix honesty);
reads overlapping the damage are refused, never masked. Automatic repair is
the recovery epic's surface (E6); v0 guarantee = disclose precisely + degrade.

### R2 · Checkpoint refused — `checkpoint-over-suspect`

The full walk named suspects; stamping would lie about restorability (§2.8).
Not a failure of the checkpoint — a refusal. Resolve R1 first; retry then.

### R3 · Read refusal — `segment-crc-mismatch`

`readRange` aborting the txn (never serves unvouched bytes). Consumers boot-
degrade conservatively (`evidence-scan` gap) rather than serve partial truth.

### R4 · Append rejections (caller bugs — never auto-repair)

`seq-gap-vs-head` (`firstSeq` must equal `head.lastSeq + 1`) ·
`seq-not-contiguous` / `lamport-regression` (batch-internal order) ·
`cross-device-batch` · `oversized-batch` (>500) · `idempotency-key-reuse`
(same key, different batch hash — a retried append with drifted content).
These are programming errors at the producer; the journal refuses by design
(hub emits registered, contiguous batches).

### R5 · Compaction errors (E2-T11)

`compaction-horizon-invalid` (horizon ≥ head; the tail is never a window) ·
`compaction-plan-empty` · `compaction-baseline-unknown` (foreign schemaV —
never migrated in place) · `compaction-plan-conflict` (a DIFFERENT plan met
a running baseline — finish the running plan first; sweeps are
planDigest-bound) · `compaction-horizon-regression` (new horizon below the
baseline's — would orphan earlier purge gaps; prosecuted) ·
`compaction-flip-lost-baseline` (defensive; hand-damaged meta). Mid-sweep
kill states (running baseline, partial rewrites, stale checkpoint) are all
scan-lawful and self-converging: re-running the SAME plan resumes to the
byte-identical end state (chaos points `compact.segment-rewrite.mid` /
`compact.baseline-flip.before` / `compact.checkpoint.mid` prove it).
**Never** delete a baseline row by hand: it is what makes purge gaps lawful
to the scanner.

### R6 · Foreign schema version — `E_MIGRATION` on `open()`

The store is newer/older than this build's schema. Recovery = the migration
runner (E2-T04, ADR-034); a checkpoint-restored path never silently opens a
newer store. Operator action: align extension version; replay the N-1→N
fixtures story — do not downgrade a live store.

### R7 · Engine used before `open()` (`NotOpen`)

Boot-discipline breach (invariant class) — surfaces as corruption-class
conservatively. Producer bug; instrument the wake path ordering.

### R8 · Quota pressure — `E_QUOTA` / `pressureRatio ≥ 0.8`

(§5 law 6.) Persist request may lawfully answer `false`; health checks must
surface pressure, NOT evict silently. Any future eviction is preview-then-
confirm through retention policy — never automatic under pressure.

### R9 · Corrupt store — `E_CORRUPT_STORE`

Adapter-level mapping of IDB corruption/open-quota/`InvalidStateError`
shapes (see `storage/error-map.ts` + `error-map.catalog` — every code maps
to copy keys; the `check:errors` lint keeps the census closed).
Rescue path: capture diagnostics ↔ do not retry-write into a corrupt handle;
recovery strategy decisions are ADR-level (stop condition).

### R10 · Projection view `dirty`

A projector threw (projector bug class): the view's watermark freezes, peers
are never poisoned, and `status()` names it. Recovery = rebuild of THAT view
only (`projections.rebuild(view)` — wipes rows + watermark, replays the
journal, byte-identical output). A rebuild that dirties again = reproducible
projector bug → capture the stream prefix and escalate. (Lawful catalog
streams must never dirty; fc-guarded.)

### R11 · Sessions cross-check unavailable

The NativeSessions adapter (E3-T03) is read-only by law; until it lands the
cross-check runs degraded-unavailable — a known gap, logged, never blocking
boot or surfacing a card.

## 5. Torn-state taxonomy (what a kill can leave — all self-converging)

Every mutation path's kill doors live in `ops/chaos/points.txt` (constitution:
file == reconciler ∪ marker ∪ compact points, disjoint):

- **Executor (park/resume/delete/undo/import/trash/archive):** durable half
  of a two-phase intent ⇒ next boot resolves per disposition table (§3).
  Tear windows: pre/post commit, mid-batch, completion before/after.
- **Markers:** arm-without-stamp, stamp-without-arm (§2).
- **Compaction:** mid-rewrite prefix, unflipped done-work, stale checkpoint
  (R5) — resume converges byte-identically.
- **Corrupted seeds:** bit-rot / rot-open-tail / crc-flip / checkpointed-rot
  / head-drift — detection + prefix honesty + overlap refusal + zero writes
  (T09 driver; outcomes pinned in the G1 golden).

## 6. Operator checklist (any suspected loss incident)

1. Capture: `BootReport`, `BootSignal.evidence`, marker rows
   (install/boot/alive), `JournalIntegrityReport` (scanFull), meta rows
   (`journalHeads`, `checkpointPtrs`, `purgeEpoch`, watermarks),
   `ProjectionStatus`, and the events-store segment list (ids + sealed only).
2. Classify against §2/§3/§4. Identify the FIRST suspect (scans are precise
   disclosures — `segmentId` + reason).
3. Reproduce locally: the chaos driver's corrupted-seed classes (§5) cover
   every known durable-damage shape; `UPDATE_EVIDENCE` is never used to mask
   drift — golden diffs are review-visible acts.
4. **Stop conditions** (do not improvise past these): hand-editing IDB rows;
   deleting baselines/checkpoints; opening a foreign-schema store; serving
   bytes the CRC cannot vouch for; auto-eviction under quota. Each is an
   ADR-level decision — escalate.
