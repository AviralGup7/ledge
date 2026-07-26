# E6-T03…T06 · diagnostics core, rescue console, export, cadence — decision record

Milestone: EPIC E6 (RECOVERY, DIAGNOSTICS, RESCUE — Tier 2), work packages three
through six, shipped as one unit. Roadmap rows: T03 "Diagnostics core | ring
buffer, redactor, probes registry (EES §2.15) | Redactor-fail-drop proof";
T04 "Rescue console | health probes UI, repair actions | Probe catalog complete
per EES §12"; T05 "Diagnostics export | bundle assembly, include-flip auto-decay
| ≤10s; decay fixture"; T06 "Integrity scanner UI hooks | tail/full scans w/ C24
rate law | Full-scan cadence enforced". Frozen anchors: EES §2.15 (ring 500,
redact default-ON, redactor failure ⇒ drop, drop-oldest, probe registry
versioned), EES §5 logs row (seq# mod 500, ctx redacted, redactor self-test on
boot), EES §6 DiagnosticsPort (≤1ms/log amortized, batched flush), EES §7.10
(export ≤10s), Blueprint §12 (ten-probe catalog), C23/C24 (RepairRebuild,
RescueScanNow, full scan ≥7d apart unless rescue console), C26
(ExportDiagnostics, flip ≤24h auto-decay), ADR-027 (ring 500 IDB, URLs/domains
hashed, flip off-by-default auto-resets 24h, nothing leaves the device unless
the user chooses), ADR-028 (no telemetry).

---

## F1 (T06) — full-scan cadence override → `capability-authorized force`

**Ruling (verbatim by substance):** the payload gains an additive-optional
`force?: true` literal. Server law: repeating a full scan inside 7 days is
`E_DOMAIN_LEGALITY 'full-scan-cadence'` UNLESS forced; a forced scan is accepted
ONLY for the rescue-console capability, otherwise authorization/domain refusal.
"The backend should never assume: 'If force is present, it must have come from
the Rescue Console.' … Server enforces: cadence rule, caller capability, audit
trail, independently of the client." Console flow: full scan rejected <7d ⇒ calm
confirmation ⇒ resend `force: true` ⇒ server verifies the rescue capability from
the envelope. Rationale: additive payload amendment; census unchanged;
implements the roadmap text exactly ("unless rescue console"); future-proofs;
business rules live on the server; overrides stay auditable.

Laws implemented:

- **Envelope-derived authority:** `consoleAuthorized` is computed from
  `ctx.message.senderContext === 'quiet'` — the dispatch envelope, never a
  payload claim. A forged `force` from any other context refuses
  `force-unauthorized`; a cadence repeat without force refuses
  `full-scan-cadence` with `details.nextEligibleAt`.
- **Stamp after success only:** `diag.lastFullScanAt` is stamped only after a
  successful full scan; refused or failed scans never move the window.
- **Auditability (F4 timeline):** every accepted forced scan writes ONE ring row
  `{mode:'full', forced:true}` — overrides are visible on the calm timeline, not
  silent.
- **Census unchanged:** same wire name, additive-optional payload — the frozen
  30C/9Q/13S/17W/5S census stands; contract fixtures tolerate the additive key.

## F2 (T03/T04) — probe catalog → `registry-completeness with lifecycle states`

**Ruling (verbatim by substance):** ship all ten §12 probe DEFINITIONS in the
registry; distinguish `wired` from `unwired` (later: deprecated/experimental);
the UI renders unwired probes neutral grey, NEVER fake green. "Catalog complete
= all probe definitions exist in the registry. Implementation complete = every
probe has status: wired."

Laws implemented:

- Catalog order is the §12 order; the registry carries a version
  (`registryV: 1`) per EES §2.15 versioning.
- v1 honesty: the AI-lanes and offscreen-spawn probes ship
  `{wired:false, status:'unwired', fields:{tier:'v1.1'}}` — declared, visible,
  never pretending to pass.
- The compaction-age probe reports what the store actually proves
  (baseline present/epoch/throughSeq, `schedule:'operator'`) — the missing
  run-stamp is admitted on its face and lands with the v1.1 scheduled lane.
- The boot self-test row rides the registry as the eleventh row
  (`diag-selftest`), degraded ⇒ the row says so (never a boot fault).
- Probe failures drop into ONE summary ring row (`probe-run-issues`) —
  signal-not-noise law: a registry run must not churn the 500-slot ring.

## F3 (T05) — bundle delivery → `GetHealth lastBundle (producer/observer)`

**Ruling (verbatim by substance):** embed bundle metadata (+cached json) in
GetHealth: `lastBundle{bundleId, createdAt, available, size, json (optional,
local-only)}`. ExportDiagnostics stays frozen `{bundleId}` — it is the
PRODUCER; GetHealth is the OBSERVER; the UI merely DOWNLOADS (Blob→file, no
network, no regeneration). "Why not add a new query? …extra surface area
without much benefit. Why not bundleId only? …weakens the 'user owns their
diagnostics' principle."

Laws implemented:

- ExportDiagnostics assembles the document (schemaV 1: bundleId, generatedAt,
  includeAddresses, redactor posture, probes, projections, journalTailScan,
  storage, ≤100 newest ring rows stripped of bundle payloads) and stores it in
  the ring row's `bundleJson`; the wire answer stays `{bundleId}` exactly.
- GetHealth reports `lastBundle` with the cached json for the local download
  gesture; timeline reads always strip `bundleJson` (bundles are artifacts,
  not timeline noise).
- Bundle assembly measured under the §7.10 ≤10s law in the decay-fixture lane.
- The quiet download button is DISARMED until a bundle exists (`data-armed`,
  `aria-disabled`); the gesture is Blob→objectUrl→`<a download>`→revoke — no
  network hop, ever (ADR-027/028).
- The HealthChanged stream stays reserved (declared, not emitted) this
  milestone — observers poll GetHealth; no push contract is risked half-built.

## F4 (T03) — observability storage → `unified typed ring`

**Ruling (verbatim by substance):** ONE event stream — typed entries
(CommandStarted/Completed/Rejected, ProbeStarted/Completed, RecoveryDetected,
BundleExported, ScanStarted/Finished…) — one timeline, one retention (500), one
export path, one console, one filter system. Write amplification is solved at
the BATCHING layer, not by splitting storage. The in-memory ring stays the
test seam/cache.

Laws implemented:

- The dispatcher's command lifecycle flows into the same IDB ring beside the
  existing in-memory ring (`fanOutSinks([createRingLogSink(), diagSink])` —
  both wire and internal dispatchers); failed verbs log at warn because they
  carry the legality refusals an operator hunts.
- `log()` is a fire-and-forget queue (≤1ms/log amortized per §6), batch-
  flushed at 25; queue cap 500 with a `ring-dropped-queued` marker row so loss
  is admitted, never silent. Drop-safe by constitution: queued entries are
  diagnostics, never truth — SW death may orphan them.
- Retention is the §5 covenant: seq# mod 500 slots, drop-oldest, 500 rolling.
- Entries are typed `{kind: command|scan|bundle|probe|diag, level:
debug|info|warn|error}` with a fnv1a ctx hash; the rescue console filters by
  kind on the same timeline rows.

## Cross-cutting laws

- **Redactor posture (ADR-027):** redaction default-ON — URLs hash to
  `adr#<fnv1a64(url)>`, bare domains and declared address keys
  (url/domain/host/origin/href) hash whole-value. The include-addresses flip is
  off-by-default and auto-decays ≤24h READ-SIDE (expiry observation at read
  time; a grant past its window reads inactive and redaction resumes — no
  timers). Escape eschatology tested: grant ⇒ unredacted window ⇒ time passes
  ⇒ re-redacted.
- **FAIL-DROP (the T03 completion gate, proven):** redactor failure ⇒ the entry
  is DROPPED, never passed through raw (sabotaged-redactor fixture: `log()`
  never persists; `report()` answers `E_OUTPUT_MALFORMED 'redactor-drop'`;
  healing the redactor lands the next entry). Redactor self-test runs on boot
  (fire-and-forget; degraded verdict lives on its probe row, never a boot
  fault). Non-primitive fields refuse — structured junk is droppable, not
  leakable.
- **Legacy degrade:** every place the diagnostics seam is optional
  (`deps.diagnostics?`), the pre-T03 behavior stands — inline ring writes and
  the legacy ad-hoc GetHealth dump — degrade, never fault.
- **Census note:** wire census UNCHANGED (30C/9Q/13S/17W/5S). No new verb; the
  payload amendments are additive-optional literals.

## Test-infrastructure exposure (fixed, law-preserving)

Bringing the diagnostics actors online (a fire-and-forget on-boot self-test —
EES §5 "redactor self-test on boot") exposed a latent defect in the TEST-only
in-memory storage engine: readwrite transactions committed by whole-table
copyback, so any two overlapping txns (the selfTest meta write vs the journal
append/watermark write) let the later commit wipe rows it never touched. Real
IndexedDB isolates writers by row inside a scope, so the fixture was
unfaithful, and `roots.test.ts` ("append → recompose → read") failed
deterministically. Fix: IDB write-isolation parity in
`infrastructure/storage/memory` — clone only the declared scope, track the
txn's WRITE SET (put/delete deltas), and commit the deltas onto the live
tables. Same-key overlap stays last-committer-wins. The adapter's `toRow` was
additionally bracketed (include-flip read inside the slot txn) to hold its
clone window tight. The parametric contract suite (Dexie + memory) holds both
ways. Also: the diagnostics unit suite lives at
`ops/tests/unit/infrastructure/diagnostics.test.ts` because depcruise's
ADR-005 writer-concentration law forbids `src/**` non-writer-family modules
(test files included) importing the journal/storage testkits — no rule was
weakened to fit.
