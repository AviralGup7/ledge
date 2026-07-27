# Degradation matrix (E7-T05) — what Ledge does when a dependency is degraded

**Law:** 100% of v1 features work with the network disabled (EES §7.6). Beyond
that, every dependency failure degrades **honestly and calmly** — the user sees
the honest state (staleness chip, calm notice, honest no-op), never a frozen
spinner and never a fake success (ADR-026: fail-closed on truth, fail-open on
cosmetics). Fallback semantics are frozen by Blueprint §9 (column "Fallback /
degradation"); this matrix is the per-row executable witness map. "Witness"
paths are test files in the repo whose red state means the row's law broke —
the docs-gate census keeps every citation on-disk.

The matrix is also the a11y/quiet-page contract of _how bad news looks_:
state chips + one calm sentence with the recovery path in it (Spec §5.11).

---

## Engine tier

| #   | degradation                                    | trigger / probe                              | user-visible behavior                                                                  | recovery path                                                           | witness                                                                                |
| --- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | Journal append timeout / transient write fault | append ack >250ms; txn error class transient | affected act refutes with calm copy; tabs left open (Spec W4) — never faked durability | retry ×2 transient-class; read-only calm banner below                   | `src/infrastructure/journal/core/journal.test.ts`                                      |
| D2  | Journal CRC mismatch / torn segment            | tail scan on wake; integrity probe in rescue | core goes read-only mode with calm banner; nothing pretends to be safe                 | truncate-to-last-good + SnapshotReconciled (`docs/runbooks/journal.md`) | `src/infrastructure/journal/core/journal.integrity.test.ts`                            |
| D3  | Storage quota pressure / persistence denied    | storage probe (health card)                  | calm notice on quiet page; standby posture; no silent eviction                         | rescue console → export offer (`docs/runbooks/storage.md`)              | `src/roots/roots.test.ts` (§5 law-6 rows)                                              |
| D4  | Migration failure                              | schemaV assertion on open                    | writes blocked; calm direct-to-rescue notice with export offer                         | checkpoint restore, then rescue console                                 | `ops/fixtures/migrations/` goldens + `ops/tests/contract/storage-engine.dexie.test.ts` |
| D5  | Memory-engine vs Dexie divergence              | ADR-032 parametric contract suite            | (dev-only surface) — contract lane red before any behavior change                      | fix the unfaithful fixture, never the shipped adapter                   | `ops/tests/contract/storage-engine.memory.test.ts`                                     |

## Application tier

| #   | degradation                             | trigger / probe                           | user-visible behavior                                                                                    | recovery path                                   | witness                                              |
| --- | --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| D6  | Projection dirty / rebuild pending      | dirty flags; watermark-gap probe          | staleness chip on affected views; queries keep answering (read models disposable)                        | projector reset+rebuild, resumable chunked      | `src/infrastructure/projections/projections.test.ts` |
| D7  | Search index lagging / stale tokenizerV | freshness row on health card              | keyword fallback over read models, honestly flagged (§2.11 law) — results still arrive                   | background resumable rebuild                    | `src/infrastructure/search/search.adapter.test.ts`   |
| D8  | Intent ledger dangling after SW death   | boot ledger scan                          | recovery discloses conservative branch (complete-safe or leave-open+mark) on the card                    | two-phase reconcile at boot                     | `src/infrastructure/intents/intents.ledger.test.ts`  |
| D9  | Messaging resync (cid gap / dead port)  | watermark gap on rejoin                   | surface resyncs snapshot+watermark (SOP); missed window re-sent whole                                    | automatic; no banner unless persistent          | `ops/tests/unit/surfaces/fake-transport.test.ts`     |
| D10 | Diagnostics seam unwired                | adapter absent (deps injected without it) | legacy ring/dump answers; health card skips probe rows — product unaffected (Blueprint §9: "no-op mode") | wire the adapter (composition)                  | `ops/tests/unit/application/queries.test.ts`         |
| D11 | Diagnostics redactor degraded           | boot self-test                            | entries fail-drop (never raw); `diag-selftest` probe row reports degraded                                | restart; if persistent, rescue export + support | `ops/tests/unit/infrastructure/diagnostics.test.ts`  |

## Platform tier

| #   | degradation                                           | trigger / probe                         | user-visible behavior                                                                                       | recovery path                            | witness                                                                        |
| --- | ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| D12 | chrome.sessions unavailable (cross-check)             | E_CAPABILITY on candidate snapshot      | recovery card renders without the candidates row — gap disclosed, card still lawful                         | next boot retry (API returns)            | `ops/tests/e2e/recovery-w7.e2e.test.ts` (declared long-running; run on demand) |
| D13 | Chrome adapter rejection mid-gesture (tab raced away) | typed API errors; precondition re-reads | skip-and-stitch disclosure on chips/toasts; nothing stranded silently                                       | next reconcile pass stitches             | `ops/tests/contract/` (adapters) + `ops/tests/unit/surfaces/quiet.test.ts`     |
| D14 | Recovery marker write fault                           | write ack error at shutdown path        | boot classifies from journal+ledger truth anyway (marker is a hint, never the authority); conservative copy | subsequent clean shutdown restamps       | `ops/tests/e2e/recovery-w7.e2e.test.ts`                                        |
| D15 | Offscreen workroom spawn failure                      | spawn error / lease expiry              | interactive tiers continue in SW (v1); v1.1 AI lanes collapse to heuristic (Principle 29)                   | respawn with capability-resolved reasons | `src/roots/roots.test.ts` (workroom liveness rows)                             |
| D16 | Favicon fetch failure                                 | `_favicon` API miss                     | neutral placeholder glyph — no broken image, no network retry storm                                         | TTL cache retry next day                 | surfaces lane (`ops/tests/unit/surfaces/quiet.test.ts`)                        |

## Import / export tier

| #   | degradation                                      | trigger / probe        | user-visible behavior                                                                   | recovery path                        | witness                                                         |
| --- | ------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| D17 | Import file corrupt rows ≤ threshold             | streaming parse guards | good rows staged; rejects listed with honest counts (Spec W15)                          | re-pick file; rejects review file    | `src/infrastructure/importers/parsers.test.ts` + hostile corpus |
| D18 | Import file > threshold corrupt / unknown format | detect guards          | atomic abort — zero partial imports committed; calm explanation                         | re-pick; supported-format doc linked | `src/infrastructure/importers/corpus.test.ts`                   |
| D19 | Import bytes stage unwired (no IDB in host)      | stage seam absent      | bytesRef-less imports refuse E_FORMAT_UNKNOWN 'import-bytes' honestly rather than crash | retry in the extension context       | `src/infrastructure/importers/bytes-stage.test.ts`              |
| D20 | Export chunk checksum mismatch                   | verify-then-present    | chunk regenerated ×2 then calm fail; **never** a silent partial export (Spec law)       | retry; rescue console if persistent  | `ops/tests/unit/application/` portability rows                  |
| D21 | Bundle/diagnostics export degraded               | exportBundle E_*       | calm refusal with reason; health card still honest                                      | run probes, read probe rows          | `ops/tests/unit/infrastructure/diagnostics.test.ts`             |

## AI tier (v1.1 provisions — posture shipped, lanes future)

| #   | degradation                     | trigger / probe        | user-visible behavior                                                                                       | recovery path                 | witness                                                      |
| --- | ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| D22 | AI fully OFF (global toggle)    | settings toggle        | heuristic naming/clustering, keyword search, honest labels — the product stays coherent (Principle 29 gate) | re-enable                     | `src/infrastructure/ai/providers/heuristic/` (ladder rung 1) |
| D23 | Provider failure / breaker open | circuit breaker (v1.1) | next ladder rung, then heuristic; briefs prefer ABSENCE to guessing (Spec §5.13)                            | breaker cooldown              | Tier-3 milestone rows (E8)                                   |
| D24 | Sync (v2) relay down            | sync status probe (v2) | queue-and-wait with plain-language notice; local-first = fully functional                                   | exponential backoff, jittered | Tier-4 boundary rows (E9)                                    |

---

## Operating law for new degradations

1. A new failure mode lands only with its matrix row + honest-copy mapping +
   executable witness in the same PR (docs-gate census enforces citations).
2. Probe names in this file are the §12 diagnostics probe names — the rescue
   console renders exactly these states (grey for unwired, never fake green).
3. Every user-visible state here must pass through the calm-copy catalog
   (`pnpm check:copy`) and the a11y suite (announced politely).
