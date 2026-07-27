# E8-T01 · AI job queue + lanes + leases — decision record

Roadmap row: "E8-T01 AI job queue + lanes + leases | Durable jobs, exact-once
artifacts (EES §2.12) | E2-T04, E3-T07 | L | infrastructure/ai | Offscreen-kill
exactly-once proof". State: **shipped** — the pipeline exists end-to-end: durable
coalescing queue, lane admission, leased claims, two worker-hosts behind one
contract, circuit-breaker ladder with the always-present heuristic rung, and the
hinged exactly-once completion commit owned by the application service. The
completion gate (offscreen-kill exactly-once) is green; see Tests below.

---

## F1 — writer-family port access, scoped to `ai_jobs`

**Fork.** E2-era law says only the journal/storage family plus application
orchestration touches the storage engine port ("never AI", written when
`infrastructure/ai` was imagined as pure sandbox compute). EES §2.12 needs a
DURABLE job queue with the exact-once completion marker in the same commit as
the artifact event — impossible without the AI package executing a store write.

**Decision.** The queue (`src/infrastructure/ai/job-queue.ts`) consumes
`StorageEnginePort` scoped to the `ai_jobs` store only (plus its reserved
`__queue-stats__` counter row inside that same store). The terminal write is
exported as `writeTerminalHinge(tx, …)` — a function the queue never invokes
itself; the APPLICATION service invokes it inside `appender.commit({ hinge })`
so event and marker share §5 law 2's one fate. Journal append stays unreachable
from the AI package (depcruise `ai-cannot-mutate` unchanged).

**Why.** This follows the e5-search precedent (E5-T01 F1: search reads journal
cheek-by-jowl but may not append), with the same shape of reconciliation: the
frozen table in `storage-engine.port.ts`'s header gains a footnote rather than a
rewrite — "AI: `ai_jobs` + the completion hinge, executed under the application's
commit; never journal, never foreign stores". Enforcement stays mechanical: the
depcruise `writer-concentration` rule lists `infrastructure/ai` among the
families allowed the storage port **for this store surface**; the port exposes
no narrower type and inventing one would fake precision the txn scope already
enforces (every queue txn names `['ai_jobs']` — an out-of-store write throws at
the engine boundary, and the unit suite pins the scope set).

**Rejects.** (a) Queue-as-application-code: rejected — retention sweeps, lease
CAS, and subject-key coalescing are infrastructure mechanics; application owns
policy (lanes, classification, the commit). (b) A per-store port type:
rejected — the engine's txn scope IS the enforcement; a type-level lie would
only drift.

## F2 — exactly-once via the hinged commit, not at-least-once plus dedupe

**Decision.** One commit, one fate: the service commits
`MemoryArtifactWritten` with idempotency key `ai-artifact:<jobId>` and the
hinge `queue.writeTerminalHinge`. The hinge re-reads the row inside the commit
txn and THROWS on any state that is not its own live claim — duplicate terminal
delivery, stale-lease write after reclaim, missing row. The throw aborts the
WHOLE txn: the artifact event and the completion marker stand or fall together.

**Why the alternatives died.** At-least-once + consumer dedupe pushes exactly-once
to every reader forever (and the artifact event is projected — dedupe would be
view law, multiplying the blast radius). Claim-barrier before commit (compare
lease, then write un-hinged) leaves a kill window between check and write. The
hinge closes the window inside the storage txn itself, and the journal's
idempotency-key law (same-key replay ⇒ ack; alien payload ⇒ hard violation)
covers the SW-crash-resend class for free. Chaos C3 (zombie-SW race) proves the
composition: the loser's commit aborts at the journal key law before the hinge
would even run — every layer fails closed, the outcome is one artifact.

## F3 — heuristic rung is the v1 ladder, and 0.55 is policy

**Decision.** `providers/heuristic` is real code, dependency-free, always
available offline (EES §2.12: "heuristic ladder rung always exists"). It emits
the Spec §6.1 honest label — "N tabs · domain-words · h:mm am/pm" —
deterministically (same input ⇒ same label; coalescing/redelivery-safe) and
stamps `confidence 0.55`, `modelClass 'heuristic-domain-time-v1'`, `schemaV 1`.

**Why 0.55.** §6.11's scale is a product constant; E8-T01 must choose where the
honest label sits. 0.55 lands the artifact in the medium band (≥ 0.5) — rendered
"present with 'suggested' affordance" — because the label is truthful but
shallow; high would assert what it cannot defend, low (< 0.5) would hide a
useful rename affordance behind the neutral frame. The cutoffs
(`CONFIDENCE_TIER_HIGH_AT 0.8`, `MEDIUM_AT 0.5`, boundaries to the higher tier,
non-finite to low) ship as named constants in `domain/memory/confidence.ts`;
tighten-only per ADR law. The ladder identifies the heuristic rung by the
`heuristic-` modelClass prefix, never by provider id — breakers can never
quarantine it (Principle 29: the last rung cannot burn).

**Domain splitting law (§6.1 example stays honest).** The label takes up to two
root-domain words, stepping over a deliberately tiny second-level set
(`co/com/org/net/ac/gov/edu`) to reach the human word ("example.co.uk" →
"example"). This is a label heuristic, never a public-suffix engine — the ADR
note records the law so nobody "fixes" it into one.

## F4 — the background window ships conservative

**Decision.** `ai-window` defaults at the root to
`maintenanceOk: true, backgroundOk: false`. The background lane admits claims
only inside caller-proven idle+battery windows (Blueprint §10 doctrine); until
the E3-T04 idle adapter grows a battery witness, "proven" cannot be shown, so
the lane is closed by default and the S10 property (held until opened,
zero-loss) pins the admission semantics on an open window. Interactive work
never waits on any of this: the SW-local host answers in-process, so the
EES §7.1 2.5s rename budget is unreachable-by-construction for rung-1 work and
the lane deadline exists only as the kill-detector for hosted execution
(AI_LANE_DEADLINE_MS: interactive 2_500, maintenance 30_000, background 120_000).

## Collapse matrix (Blueprint §9 row 6, as implemented)

| casualty              | detection                                                       | disposition                                                             |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| offer not answered    | lane deadline (service-side)                                    | abandon (JobCancel best-effort) + release; attempt consumed; retry      |
| mid-flight death      | `WorkroomShutdown` at the pair                                  | in-flight resolve `host-lost` ⇒ same-claim fallthrough to SW-local host |
| silent death          | lane deadline ⇒ release ⇒ lease expiry reclaim (2 missed beats) | retry; workroom loss backoff 30s demotes the host                       |
| spawn/capability down | `ensureDocument` err / capability                               | `host-unavailable` ⇒ fallthrough, no loss note (it never held work)     |
| retry budget spent    | claim #4                                                        | `forceHeuristic` — the ladder collapses to the always-alive rung        |
| forced rung fails     | claim #4 failing                                                | terminal `attempts-exhausted`, counted, probe-visible                   |

The service's workroom-loss accounting (`consecutiveLosses`, `backoffUntil`) is
probe evidence (§12 `ai-lanes`), never a user surface — Principle 29.

## Tests (the row's evidence)

- `ops/tests/unit/infrastructure/ai-queue.test.ts` — 16 laws incl. Q12/Q12b
  (hinge throws on duplicate / stale lease ⇒ commit aborts in one fate),
  coalescing, lease CAS, reclaim idempotence, 7-day terminal retention purge.
- `ops/tests/unit/infrastructure/ai-jobs-service.test.ts` — 13 laws incl. S6/S7
  (§3.6 round trip, collapse fallthrough), **S8 THE GATE: offscreen silent
  kill ⇒ deadline abandon ⇒ lease reclaim ⇒ retry ⇒ exactly one artifact**,
  S3/S4 reject+count, S5 retry→forced-heuristic→exhaustion, S9/S10
  single-flight + lane windows, S11 inbox totality, P1/P2 wired §12 probe rows.
- `src/roots/roots.test.ts` — R1..R5 workroom executor proofs
  (offer⇒claim/beats/result, executor throw totality, hostile offers silent).
- `ops/tests/property/ai-artifact-schema.property.test.ts` — 10 properties:
  validator totality/soundness/class-monotony, §6.11 mapping verbatim,
  tier monotony + boundaries, subject-key determinism, honest-label totality.
- `ops/tests/chaos/ai-queue-kills.chaos.test.ts` — C1..C5 kill-point matrix:
  kill-after-enqueue, kill-after-claim (lease reclaim), zombie-SW duplicate
  completion, injected torn commit (typed/reversible), seeded latency
  invariance.

## Carry-forward

- The queue speaks job vocabulary only (`AiJobKind = 'mission-name'` today);
  E8-T04+ adds kinds + provider bindings without touching the mechanism.
- `builtin/clouddepth/ondevice` provider dirs stay `.gitkeep` shells — their
  lanes are provision-gated in `docs/ai-provider-matrix.md`.
- Chrome-lane contract drives (offscreen adapter against reference Chrome)
  remain env-gated `CHROME_LANE=1` (E3 residual, tracked in
  `docs/beta-soak-matrix.md`).
