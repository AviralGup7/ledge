# LEDGE — ENGINEERING EXECUTION SPECIFICATION
**Phase 5 · Implementation Contract · v1.0**
**Governing documents (locked):** Vision → Product Specification → ADR-001…046 → System Blueprint.
**Scope law:** This document defines *what must be built and how components agree to interact*. It prescribes no code, classes, or implementation techniques. Wherever this document is silent, consult the Blueprint; wherever both are silent, the ADR; wherever ambiguity would change user-visible behavior, **stop and write an ADR note** — do not improvise.

**Conventions used throughout:**
- Types: `Id` (ULID), `BrowserTabId` (platform integer), `Seq` (monotonic journal position), `HLC {seq, lamport, deviceId, wallClock}`, `ts` (epoch ms), `Confidence` (0.0–1.0), `Result<T>` (ok | TypedError).
- Naming: commands `VerbNoun` · events `PastTense` · stores `snake_case` · errors `E_CATEGORY_REASON` · copy keys `msg.area.name`.
- All contracts below are **v1** unless marked *(v1.1)*, *(v1.2)*, or *(v2-boundary)*.

---

# SECTION 1 — IMPLEMENTATION ORDER

## Tier 0 — Foundations ("the skeleton stands")
| Aspect | Contract |
|---|---|
| **Purpose** | Repository, build/manifest generation (ADR-036), dependency law enforcement, shared-kernel (identity, HLC clock, canonicalization v1, event registry skeleton, result/error taxonomy), storage adapter skeleton + schema v1 (ADR-013/014), journal appender core (append + readRange), message contract v1 (envelope + validators + handshake, ADR-010), composition roots, CI gates (bundle budget, egress-guard ∅, dep rules), port-contract test harness skeleton (ADR-032) |
| **Dependencies** | None (first tier). ADR-001/002/003/009/010/013/016/026/036/037 ratified — done. |
| **Completion criteria (exit gate)** | (1) Append→readRange→project round-trip green in CI via a trivial projector; (2) manifest builds for chromium target with exact ADR-022 permission set and no others; (3) dependency-cruiser rules fail a deliberately violating fixture; (4) egress-guard fails on a test fetch; (5) TabsPort/WindowsPort skeleton adapters pass contract suite against real Chrome profile (query/list only) |
| **Risk** | Toolchain churn (WXT quirks, MV3 module-SW packaging) — mitigated by keeping all platform logic behind ports from day one |
| **Test requirements** | Shared-kernel unit suite (ids unique/monotonic; clock merge correctness; canonicalization golden table incl. denylist rules & fragment preservation); validator fuzz seeds pass |
| **Blocking issues** | None may proceed below until exit gate green. Any ADR ambiguity discovered here (schema field, clock rule) must be resolved *now*, via ADR-note, not later |

## Tier 1 — The Truth Pipeline ("durability or nothing")
| Aspect | Contract |
|---|---|
| **Purpose** | Full journal (segmentation, sealing, CRC32, checkpoints, tail/full integrity scans), intent ledger + two-phase executor + boot reconciler (ADR-011), ingest adapters (tabs/windows/groups/native-sessions observations), projections engine (registry, watermarks, delta publication, snapshot+watermark subscription), recovery marker & W7 backend (storage.session crash detection, ADR-007), Snapshot mechanism (park-time capture), chaos harness v1 |
| **Dependencies** | Tier 0 complete. |
| **Completion criteria (exit gate)** | (1) Chaos suite: SW killed at **every** phase boundary of Park×Resume×Delete — zero tab loss, correct conservative branch (leave-open-and-disclose) provable; (2) corrupted-journal seed replay: truncate-to-last-good + SnapshotReconciled exactness; (3) property suite: random event streams → replay invariants hold (no-lost-tabs, counts reconcile); (4) crash simulation: marker-absent → BootReport with precise scope in ≤5s of relaunch; (5) park(100 tabs) durable ack ≤500ms on CI reference hardware |
| **Risk** | Highest in project: two-phase mutation correctness under kill. Consumes the largest test budget by design |
| **Test requirements** | Chaos (kill-points enumerated pre/post every txn), property-based replay (min 1k seeds CI), migration skeleton fixtures, perf gate on ack latency |
| **Blocking issues** | Tier 2 surfaces may scaffold in parallel but **may not merge** before chaos gate is green. Durability is not parallelizable with confidence |

## Tier 2 — The MVP Loop ("the nine workflows, flawless")
| Aspect | Contract |
|---|---|
| **Purpose** | Complete domain policies; MVP use cases (W1, W2, W4, W5, W6, W7, W13, W14, W15 + delete/undo); surfaces (guardian park gestures + heartbeat; overlay keyword search; quiet-page v1 incl. Recently Closed/Trash/rescue console); undo stack; exporters (json/html/md renderers); importers (onetab, sessionbuddy, netscape); heuristic naming/clustering via HeuristicProvider only (ADR-018 ladder rung 1 — no ML yet); calm-copy catalog + accessibility core; NFR budgets enforced |
| **Dependencies** | Tier 1 green. HeuristicProvider available from Tier 0/1 scaffolding |
| **Completion criteria (exit gate)** | (1) The nine MVP workflows pass acceptance scripted + manual on clean profile (§8.9); (2) crash-recovery e2e on real browser restart shows card ONLY on loss-risk (Blueprint §14.4 rule) with exact-copy match to catalog; (3) search p95 ≤100ms @10k corpus synthetic; (4) quiet-page FCR ≤300ms @1k missions; (5) bundle budgets green (§7.4); (6) accessibility audit checklist (§7.5) zero defects; (7) egress-guard ∅; (8) copy lint (Principle 22) zero violations |
| **Risk** | Surface polish scope creep; tokenizer edge cases (CJK, RTL) inflating search work — contained by golden corpus |
| **Test requirements** | Golden-flow e2e (puppeteer-class), import/export round-trip fixtures, a11y automated+manual, perf gates, regression seed corpus begins |
| **Blocking issues** | Any durability regression found here *stops the line* back to Tier 1 |

## Tier 3 — Intelligence & Polish (v1.1–v1.2)
| Aspect | Contract |
|---|---|
| **Purpose** | Offscreen workroom executors; AI durable job queue + lanes + leases/heartsbeats; OnDeviceML provider (naming→summaries order); BuiltInBrowserAI adapter (capability-detected); summaries v1 + resumption briefs; topics chips; dupe detection (canon + Jaccard); sprawl nudge (1/day budget, dismissal memory); conclude flow v1.2; delta ring + projector checkpoints (Blueprint §14.2); switcher + command palette door; morning resume card; morning-after correctness passes; 50k-corpus hardening |
| **Dependencies** | Tier 2 shipped; confidence constants frozen (§4.8) |
| **Completion criteria** | (1) AI jobs survive offscreen kill with exactly-once artifact semantics (lease reclaim tested); (2) with AI fully OFF, full e2e suite still green (Principle 29 gate); (3) summaries replace heuristics only when confidence ≥ high-tier on shadow-eval harness; (4) dupe false-positive rate ≤2% on crafted corpus; (5) 50k-corpus budgets green |
| **Risk** | Model packaging size & WASM CSP behavior across channels; offscreen reason-enum drift — capability detection absorbs |
| **Test requirements** | AI isolation lint (ADR-041), confidence law property tests, lane-shedding load tests, breaker behavior tests |
| **Blocking issues** | No cloud path in this tier (CloudDepth is Ledge+/v2 governance) |

## Tier 4 — v2 Boundaries ("build the doors, not the house")
| Aspect | Contract |
|---|---|
| **Purpose** | Sync package: relay/crypto/registry interfaces + **local loopback harness only** (no production relay); CryptoPort from recovery phrase (sealed segments round-trip locally); conflict replayer bridge using same projectors (ADR-043s) against synthetic two-device logs; licensing gate shape (capability checks against stub token, 30-day grace semantics, ADR-046 constraints); rules engine (prompt-permitted scheduled park, no auto-close per §1.3 ADR-011 law); share-link artifact schema (one-way); Firefox adapter family to contract-suite green; spec-eval spike: FTS5/SQLite projection for 200k tier |
| **Dependencies** | Tier 3 stable in field |
| **Completion criteria** | Two-emulated-device chaos reconciliation green; contract suite green on Firefox adapters; gate semantics proven against expired/valid token fixtures; zero shipping of v2 user features |
| **Risk** | Scope bleeding — v2 features are explicitly NOT delivered here; exit criteria are *boundary proofs*, not features |
| **Test requirements** | Sync property suite (merge=commutative/idempotent on permuted logs); conflict matrix tests (rename/rename, delete/edit, conclude/edit) |
| **Blocking issues** | Any sync pressure to degrade purge law or HLC rules → halt; ADR supersession required |

---

# SECTION 2 — PUBLIC INTERFACES (module contracts)

*Format: Responsibilities · Inputs · Outputs · Ownership · Invariants · Preconditions · Postconditions · Failure contract · Versioning/Compat. Ports get method-level detail in §6.*

## 2.1 shared-kernel/identity (OWNER: Core)
Generates collision-safe, sortable record IDs and provisions the deviceId. **Inputs:** none (entropy from platform CSPRNG). **Outputs:** `Id`, `deviceId`. **Invariants:** uniqueness within install statistically guaranteed; deviceId immutable once provisioned (sync v2 relies on it). **Preconditions:** none. **Postconditions:** returned Id is lexically sortable by creation time. **Failure:** entropy failure → `E_CAPABILITY_ENTROPY` (fatal, surface-first-run blocked with calm copy). **Versioning:** format frozen forever (IRREVERSIBLE register, ADR §Risk). **Compat:** parser accepts v1-format IDs on all future reads.

## 2.2 shared-kernel/clock (OWNER: Core)
Hybrid logical clock — issues and merges HLC stamps. **Inputs:** local event (advance) | remote HLC (merge). **Outputs:** strictly-increasing HLC per device. **Invariants:** `seq` monotonic per device; lamport never decreases within a device journal; wallClock is informational only and **no correctness rule may depend on it** (skew law). **Failure:** clock regression detection → mark segment suspect (integrity probe surfaces it). **Versioning:** HLC field set frozen v1; additions only via new optional fields (tolerated by old readers).

## 2.3 shared-kernel/canon (OWNER: Core)
URL canonicalization (matching only; never rewrites stored originals). **Inputs:** raw URL string; rule table (version `canonRulesV`). **Outputs:** `{canonForm, canonHash, domain, schemeOk}`. **Invariants:** idempotent (`canon(canon(x))==canon(x)`); scheme allowlist http/https only; fragments preserved; denylist-param strips only (ADR-016). **Failure:** unparsable → `{schemeOk:false, canonHash=hash(raw)}` (never throws; dedupe degrades to exact-match). **Versioning:** rule table data-versioned (independent of schema; user corrections whitelists take precedence).

## 2.4 shared-kernel/events (OWNER: Core)
Event registry + upcasters. **Inputs:** stored event bytes. **Outputs:** typed current-shape event. **Invariants:** registry append-only; stored events never mutated; upcasters are pure and total per version pair. **Failure:** unknown type/field → preserve-passthrough (forward tolerance, ADR-033); upcast gap → `E_SCHEMA_UPCAST_GAP` (blocks projection of that event; logged; never drop silently). **Compat:** chain must upcast any v1 event to current, tested by golden fixtures.

## 2.5 domain/lifecycle (OWNER: Core)
Legality engine for every lifecycle transition + policies (retention/purge/trash/conclude). **Inputs:** command payload + current projection state (passed by caller). **Outputs:** decision `{allowed, eventsToEmit[], inverseAtom?}` or DomainError. **Invariants:** (i) Park requires snapshot plan before intent acceptance proposal; (ii) system-decided deletion of KEPT content is unreachable — no code path exists; (iii) every destructive decision carries an inverse atom. **Preconditions:** projection state watermark ≥ last mutation for the subject. **Postconditions:** pure — no side effects; same inputs ⇒ same decision. **Failure:** illegal/unknown transition → `E_DOMAIN_LEGALITY` w/ recovery key. **Versioning:** policy constants (trash days, confirm thresholds) versioned with settings schema, not code-freeze.

## 2.6 application/hub — dispatcher, queries, subscription hub (OWNER: Core)
Sole mutation entry; read-model queries; surface streams. **Inputs:** validated envelopes. **Outputs:** Ack/Applied/Failed + snapshots/deltas. **Invariants:** single-writer (no other component may invoke mutation-capable ports); durability-first (Ack precedes browser mutation; never claims completion without completion event); priority classes (interactive > maintenance). **Pre:** sender context authorized for message kind per contract allowlist. **Post:** every accepted command yields exactly one terminal outcome (Applied|Failed) — *pending is never terminal*. **Failure:** dispatcher overload → interactive preserved, maintenance deferred (`E_RATE_LANESHED`, invisible to users). **Versioning:** contract hash handshake per port-open; dual-read window on kind-level changes (one release).

## 2.7 application/policy — flags & entitlements (OWNER: Core)
**Responsibilities:** flag evaluation (build→bundled→local), entitlement gate evaluation against licensing token (stub in v1; ADR-046 shape). **Invariants:** gates limit *capability*, never access to user data (charter; non-negotiable); cache grace ≥30d offline; flags expire at N+2 (lint). **Failure:** token unreadable/expired → entitlement=false, zero degradation to local truth features. **Versioning:** flag registry versioned per release.

## 2.8 infrastructure/journal (OWNER: Platform)
Append/scan/compact/checkpoint (ADR-004/020). **Inputs:** event payloads (append), scan ranges, compaction policy. **Outputs:** append ack `{seq}`, event streams, integrity reports. **Invariants:** ack ⇒ durable (txn committed); sealed segments immutable; compaction performs physical exclusion of purged bytes (purge law); checkpoint ⇒ restorable to that point with zero replay. **Pre:** caller is authority (hub) only. **Post:** acked events appear in readRange monotonically. **Failure:** ack timeout 250ms → caller treats as not-durable (abort path; idempotency key prevents double-append on retry). **Versioning:** segment format v1 + upcast on read; compaction baselines noted in meta.

## 2.9 infrastructure/storage (OWNER: Platform)
Sole IDB adapter (ADR-013). **Invariants:** no scan-path query (index-coverage enforced by adapter tests); unknown fields round-trip preserved (forward tolerance); migrations: checkpoint→migrate→assert→rollback-on-fail (ADR-034). **Failure:** quota → `E_QUOTA` (hub escalates to health; surfaces show calm notice); corrupted store → rescue path. **Versioning:** schema v1; version integer in `meta`; N-1→N fixture suite.

## 2.10 infrastructure/projections (OWNER: Platform)
Event→read models, watermarks, rebuilds, delta publication. **Invariants:** apply idempotent by eventId; per-aggregate order preserved `(seq, batchIndex)`; read models disposable (rebuild ⇒ identical output from same journal — determinism law). **Failure:** projector throw → mark dirty, others continue, health probe flags. **Versioning:** projector versions recorded with watermarks (rebuild-on-change).

## 2.11 infrastructure/search (OWNER: Platform)
Index projector + ranker + dupe matcher. **Invariants:** index is a projection (deletable/rebuildable); when lagging >LAG_THRESHOLD (2k events) query merges bounded tail-scan and flags freshness; correctness > freshness. **Failure:** absent/corrupt index → keyword-on-read-models fallback. **Versioning:** tokenizer version stamped; changes trigger background full reindex (maintenance lane).

## 2.12 infrastructure/ai (pipeline+providers) (OWNER: Memory)
Durable jobs, lanes, leases, provider ladder, redaction gateway. **Invariants (constitutional, ADR-041):** package cannot import mutation-capable symbols (build-verified); artifact requires `{value, confidence, provider, modelClass}` — missing ⇒ rejected pre-write; exactly-once artifact per job (lease+completion marker under job key); heuristic ladder rung always exists. **Failure:** provider error/timeout → circuit break + next rung; malformed → reject+count; queue backlog → lane shedding (background→maintenance). **Versioning:** provider capability matrix versioned; artifact `schemaV` stamped.

## 2.13 infrastructure/recovery (OWNER: Platform)
Boot reconcile, crash detection, repair drivers. **Invariants:** conservative resolution law — when completion is unprovable, choose the branch that cannot destroy user content (leave-open+disclose); BootReport always produced (even "clean"); recovery-card gating per Blueprint §14.4 (card only on loss-risk). **Failure:** SessionsPort unavailable → degrade cross-check with logged gap. **Versioning:** report schema v1.

## 2.14 infrastructure/importers / exporters (OWNER: Portability)
**Importers:** ImporterPort impls; two-phase (preview→commit); commit = one undoable batch; rejects quarantined never fatal. **Exporters:** canonical model → renderers; chunk-verify-then-present; never silent-partial; format majors read-forever (covenant ADR-045). **Invariants:** export contains full provenance (`formatV`, app build id, canonRulesV used); import preserves source timestamps as metadata (never masquerades as live activity).

## 2.15 infrastructure/diagnostics (OWNER: Platform)
Ring buffer (500), redactor, probes registry, export bundle. **Invariants:** redaction default-ON (hash URLs); include-addresses flip auto-decays ≤24h; redactor failure ⇒ entry dropped, never passed through. **Failure:** buffer full → drop-oldest. **Versioning:** probe registry versioned.

## 2.16 surfaces (guardian · overlay · quiet-page + components) (OWNER: Experience)
**Inputs:** snapshots/deltas/query results. **Outputs:** commands/queries only. **Invariants:** zero direct storage/browser/AI access (build-verified); acknowledged-pending states for truth verbs until Applied (no optimistic truth); all user-visible strings from copy catalog (no inline literals — linted). **Failure:** stream loss → ResyncRequired flow (snapshot+watermark rejoin). **Versioning:** contract hash handshake; refuses silent operation on major mismatch (calm prompt to update).

---

# SECTION 3 — MESSAGE CONTRACTS

## 3.1 Envelope (all contexts, ADR-010)
Fields: `v` (contract version) · `kind` (`command|query|event|stream`) · `name` · `cid` (correlation/client op id, ULID) · `senderContext` (`guardian|overlay|quiet|offscreen|sw`) · `payload` · `contractHash` (schema registry hash at build).
Rules: (a) boundary validators execute before dispatch; (b) unknown `name` ⇒ ignore + log (forward compat), never throw; (c) unknown fields inside payloads ⇒ tolerated on read, stripped on re-emit; (d) payload hard cap 256KB (larger ⇒ streaming contract); (e) arrays capped 10k items else stream; (f) Zone-1 (future content scripts) accepts **only** names in the Zone-1 allowlist (indexing submissions).

## 3.2 Error envelope (uniform)
`{code: E_*, retryable: bool, messageKey: "msg.*", recoveryKey: "msg.recover.*", details?: map(primitive only), watermarkHint?: Seq}`. User strings render from catalog via keys — **payloads never carry display copy**.

## 3.3 Command catalog (Surface → SW Authority)

| # | Name | Payload (contract fields) | Terminal response | Validation highlights | Retry |
|---|---|---|---|---|---|
| C1 | FirstRunIngest | – | Applied{missionsCreated:int, tabsCaptured:int} | first-run flag in meta | safe resend (idempotent by flag) |
| C2 | StartMission | name?:string(≤120) | Applied{missionId:Id, windowId:int} | collapse whitespace | safe |
| C3 | ParkTab | browserTabId:int | Applied{kept:Id}|{tabsSecuredText} | tab exists at dispatch | idempotency key=cid; duplicate ⇒ no-op ok |
| C4 | ParkGroup | groupId:int | Applied{missionId, keptCount} | group exists | as C3 |
| C5 | ParkWindow (Mission park) | windowId:int | Applied{missionId, keptCount, briefQueued:bool} | window bound to mission or forms one | as C3 |
| C6 | ParkAll | exceptWindowId?:int | Applied{missions:int, keptCount} | rate-limit 1/sec | as C3 |
| C7 | ResumeMission | missionId:Id; mode:full\|partial; tabIds?:Id[](≤10k) | Applied{windowId, restored:n, moved:n} | state is PARKED/ARCHIVED; partial ⊆ mission | resend-safe (idempotent by mission open-check) |
| C8 | RestoreRecentlyClosed | ids:Id[]; target:missionId\|new | Applied{restored:n} | ids in window | safe |
| C9 | RenameMission | missionId; name(≤120) | Applied{oldName?} | non-empty after trim | safe (last-writer local) |
| C10 | MoveTabs | tabIds:Id[]; toMissionId:Id | Applied{moved:n} | dest exists; tabs KEPT or LIVE | safe |
| C11 | MergeMissions | fromId:Id; intoId:Id | Applied{intoId} | distinct; user-confirmed (surface duty) | no auto-retry (confirm-gated) |
| C12 | SplitMission | tabIds:Id[]; newName? | Applied{newMissionId} | non-empty selection | safe |
| C13 | ArchiveMission | missionId | Applied | state ≠ TRASH | safe |
| C14 | ConcludeMission | missionId; outcomeNote?:string(≤2000) | Applied | state PARKED/ARCHIVED | safe |
| C15 | DeleteEntity | kind:tab\|mission; id; bulkSize?:int; confirmedLarge?:bool | Applied{trashed:n} | bulkSize>20 → confirmedLarge required | no auto-retry on confirm-required |
| C16 | RestoreFromTrash | kind; id | Applied{missionId resolved} | within 30d; parent resolution rule (§10-R13) | safe |
| C17 | EmptyTrash | confirm:true | Applied{purged:n} | confirm exact | irreversible — no retry semantics |
| C18 | Undo | actionId?:Id | Applied{undid:descriptor} | stack non-empty | **never auto-retry** (ambiguity; §10-R9) |
| C19 | SetSetting | key:string; value:schema-checked | Applied | whitelist of settings keys | safe (LWW) |
| C20 | ImportPreviewRequest | fileMeta{name,size}; parserHint?:enum | Applied{previewId} | size guard (ADR-040); then streaming | new preview per resend (harmless) |
| C21 | ImportCommit | previewId:Id; dedupeMode:skip\|import-anyway | Applied{batchId, imported:n, dupes:n, rejects:n} | previewId fresh (<1h) | idempotent by batchId |
| C22 | ExportRequest | scope:all\|mission(Id); formats:json\|html\|md[] | Applied{exportId} | mission exists | idempotent per exportId |
| C23 | RepairRebuild | scope:projectorId\|all | Applied{rebuilt} | health-probe only contexts | safe |
| C24 | RescueScanNow | mode:tail\|full | Applied{reportId} | full scan ≥7d apart unless rescue console | safe |
| C25 | ForgetEverything | confirm:true | Applied{artifactsPurged:n} | confirm exact; **tabs untouched** (spec) | irreversible |
| C26 | ExportDiagnostics | includeAddresses?:bool | Applied{bundleId} | flip ≤24h auto-decay | safe |
| C27 | NudgeDismiss / NudgeAccept(v1.1) | nudgeType:enum; action?:park-selection | Applied | cooldown counters update | safe |
| C28 | SwitchMission (v1.1) | parkCurrent:bool; targetMissionId | Applied{per 6.8 blueprint} | target PARKED | per C5+C7 chain (atomic via single intent) |

**Timeouts:** dispatch ack expectation ≤3s (else resend with same cid — dedupe by persisted cid cache, 10-min TTL); long operations (imports/exports/rebuilds) return Ack-immediately + progress stream; `pending` states render only with active heartbeat (stream liveness), otherwise surface escalates to ResyncRequired.

## 3.4 Query catalog
| Name | Payload | Returns | Notes |
|---|---|---|---|
| GetBootstrap | surface:enum | {snapshots:{views…}, watermark:Seq, settings, heartbeat} | first load per surface instance |
| GetLibrary | filter?:state/topics; sort:enum; cursor | page{missions[], nextCursor} | cursor ≤ 24h validity |
| GetMissionDetail | missionId | {mission, tabs, artifacts} | artifact presentation-tier pre-applied |
| GetRecentlyClosed / GetTrash | cursor | page | same paging contract |
| SearchQuery | q:string(≤200); scope?:open\|kept\|closed\|all; limit≤50 | {results[], freshness:flag, searchedScopes[]} | scope-widen law (Spec W6) server-side |
| GetHealth | – | probe registry dump | rescue console |
| PeekOpenTabs | windowId? | live inventory | guardian rendering aid |

## 3.5 SW → Surface streams (after GetBootstrap subscription)
`ViewDelta {view, watermark, ops:[upsert|remove|patch]≤500/frame}` · `HeartbeatUpdate {keptCount:int, liveRecoverable:int, asOf:ts}` (definition §10-R10) · `CommandAck {cid, intentId, state:accepted-pending}` · `CommandApplied/CommandFailed` (terminal) · `NudgeOffered`(v1.1){nudgeType, payloadRefs, dismissable:true} · `RecoveryAvailable {bootReportId, severity:loss-risk|clean-abnormal}` · `HealthChanged {probes}` · `ImportProgress/ImportReady` · `ExportProgress/ExportReady {fetchURL, manifestId, chunkChecksums[]}` · `ResyncRequired {reason:gap|schema|death}`.
**Ordering:** deltas per view strictly watermark-ordered; gap detection at surface ⇒ ResyncRequired ⇒ full snapshot rejoin. **Compat:** schema-major mismatch ⇒ ResyncRequired{schema} + calm update prompt (never silent partial rendering).

## 3.6 SW ↔ Offscreen (workroom contracts)
`EnsureWorkroom {reasonHint}`→`WorkroomReady {capabilitiesResolved}` · `JobOffer {jobId, kind, payloadRef, lane, deadlineMs}` →`JobClaimed {jobId, workerTag}` → progress `JobHeartbeat {jobId, pct}` (lease = 2 missed beats ⇒ reclaim) → terminal `JobResult {jobId, ok, artifact?{…validated}, failureClass?}` · `JobCancel {jobId}` (best-effort; terminal still authoritative) · `ParseRequest{previewId, fileRef}`→`PreviewChunk{model partial}`→`PreviewDone` · `IndexBuildRequest{scope}`→`ChunkDone{count}`→`IndexBuilt{tokenizerV}` · `RenderRequest{exportId, formats}`→`RenderChunkReady{fetchPart-url}`→`RenderReady{manifest}` · `WorkroomShutdown {reason:idle}`. **Ownership:** SW is sole spawner/closer; jobs are re-entrant-safe (artifact write is the single completion marker, §2.12). **Retry:** job retry ×2 max then lane-fallback (heuristic tier) per §9.

## 3.7 Future Sync (v2-boundary; sketch-fixed contracts)
`DeviceRegister {deviceId, sealedMeta}` · `KeyBundlePublish {deviceId, sealedKeyMaterial}` · `SegmentsPush {deviceId, segments[] sealed}` · `SegmentsPull {deviceId, sinceSeq}` · `RegistryList` → devices. All payloads opaque to relay; N-2 dual-read (ADR-033); conflict resolution = replay merge (no message-level negotiation). **Status:** interfaces frozen against replayer harness (Tier 4); production behavior contracted later via ADR-note.

---

# SECTION 4 — EVENT CONTRACTS

**Global laws (ADR-003/004/033):** events are immutable; stored form never rewritten; application idempotent by `eventId`; ordering = `(seq, batchIndex)` per device stream; replay = upcast-then-apply deterministically (same journal ⇒ identical projections, verified by property suite); compaction re-baselines with Checkpoint events and must preserve purge exclusions; migration = upcaster chain N-1→N w/ golden fixtures.

**Common envelope fields:** `eventId:Id · hlc:HLC · type:string@1 · payload · producerContext:sw · idempotencyKey?:string`.

| Event | Producer (use case) | Primary consumers | Payload schema (v1) | Ordering/idempotency notes | Replay/migration notes |
|---|---|---|---|---|---|
| TabObserved | Ingest | TabsView, ArchiveCounts, SearchIndex | {ledgeTabId, browserTabId, windowId, groupId?, url, urlCanon, canonRulesV, title, domain, ts} | idempotent by ledgeTabId | upcast path reserved for field adds (e.g., topicsRef v1.1) |
| TabUpdated | Ingest | TabsView, SearchIndex, MemoryTriggers | {ledgeTabId, changes{title?,url?,groupId?}} | supersedes by same-id; order matters for url→canon recompute | old events re-canon with their recorded canonRulesV |
| TabActivatedObserved | Ingest (throttled) | Recency projections, NudgeModel | {ledgeTabId, ts} | collapsible in compaction (keep latest per day) | safe to drop in compaction law? NO—compaction preserves purge only; activity events may be compacted by policy v1.1 w/ ADR note |
| TabClosedExternal | Ingest (chrome.tabs.onRemoved not from intent) | RecentlyClosedView, DupeIndex | {ledgeTabId, closedAt, lastMissionId?, snapshotRef?} | dedupe vs TabsParked pairs (§10-R2 rule) | — |
| WindowClosedExternal | Ingest | MissionsView | {windowId, missionId?, closedAt} | reconcile vs Park intents | — |
| GroupChanged | Ingest | MissionsView (style fidelity) | {groupId, name?, color?, collapsed?} | — | — |
| MissionFormed | UseCases (FirstRun, Formation, Split, Import) | MissionsView, Archive | {missionId, name, namedBy:heuristic\|ai\|user\|import, tabIds[], provenance?} | idempotent by missionId | — |
| MissionRenamed | UseCases + AI artifact application | MissionsView, SearchIndex | {missionId, name, namedBy, correctedFrom?} | last-writer for display; history retained | — |
| TabAssigned / TabMoved | UseCases | MissionsView, TabsView | {tabId, missionId, (fromMissionId?)} | per-tab linear sequence | — |
| SnapshotTaken | Park/Snapshot services | SessionsView, Recovery | {snapshotId, missionId, partCount, tabRecordRefs[], groupStyles[], takenAt} | parts share snapshotId; ordered partIndex | chunking rule §10-R5 |
| ParkIntentAccepted | Park use cases | Intent ledger, Recovery | {intentId, scope{tabIds[], groupStyles, snapshotId}, issuedAt} | dedupe by intentId | — |
| TabsParked | Park executor | MissionsView, RecentlyClosed(excluded), ArchiveCounts | {intentId, secured:n, failedRefs[]?} | terminal-for-intent; reconcile with TabClosedExternal race (§10-R2) | — |
| ParkAborted | Park executor | Intent ledger, Guardian | {intentId, reason, liveLeftOpen:n} | terminal | — |
| ResumeAccepted / MissionResumed | Resume | MissionsView, Intents | {missionId, mode, restoredMapping[{tabId→browserTabId}], movedRefs[]?} | mapping recorded once per resume (traceability §10-R3) | — |
| RestoreAccepted (RecentlyClosed/Browser-ross-check) | Resume variants | same | per C8 path | — | — |
| MissionArchived / MissionConcluded | UseCases | ArchiveView, MemoryJobs | {missionId, (outcomeNote?, concludedAt?)} | conclude implies archived | — |
| EntityTrashed | Delete | TrashView, PurgeChains | {kind,id, inverseAtom, bulkId?, deletedAt} | inverse atom embedded (undo law) | inverse atom versioning tied to schema v |
| TrashRestored | Restore | all views | {kind,id, resolvedMissionId} | purge-chain cancelled same-txn | — |
| TrashPurged | Sweeper | PurgeChains, Journal compaction feed | {kind,id, purgedAt, purgeEpoch} | **authoritative delete**; compaction must physically exclude | purgeEpoch recorded in meta |
| MemoryArtifactWritten | Memory application (from AIQ results) | MemoryView, MissionsView (presentation), SearchIndex(topics) | {artifactId, subjectId, kind:name\|summary\|brief\|topics\|link, value, confidence, provider, modelClass, schemaV, derivedFromSeqRange} | one live artifact per (subject,kind) — supersede by seq | rebuild from journal OK (derived) |
| MemoryArtifactInvalidated | Corrections | same | {artifactId, cause} | — | — |
| MemoryWiped | ForgetEverything | Memory context | {purgedCount, wipeId} | idempotent by wipeId | — |
| ImportPreviewed | Importers | (transient surface only) | {previewId, modelSummary} | TTL 1h | — |
| ImportCommitted | Import commit | all views (batch) | {batchId, batchManifestRef{counts, idsRange}, source, dupesMode, canonRulesV} | **chunked txn application; single inverse via batchId** (§10-R11) | manifest format v1 |
| ExportCompleted | Exporters | audit feed (journal) | {exportId, scope, formats, manifestChecksum} | — | — |
| SettingsChanged | Policy | all (fan-out) | {key, value, schemaV} | LWW per key | settings NOT journal-derived truth (ADR-035): event is fan-out hint only |
| SnapshotReconciled | Recovery | Recovery, Views | {basisSeq, capturedProjectionHash, scopeDescription} | one per corruption incident | — |
| ProjectionRebuilt | Projections | Health | {projectorId, toWatermark, durationMs} | — | — |
| *(v2 reserved)* RuleCreated, RemoteEventsApplied, DeviceRegistered | Sync/Rules | per ADR-043s | frozen at Tier 4 harness | — | — |

---

# SECTION 5 — STORAGE CONTRACTS

| Store | Record (key → fields) | Indexes | Retention / purge | Integrity checks | Migration guarantees |
|---|---|---|---|---|---|
| `events` (journal) | segmentId → {sealed:bool, entries:[{seq,batchIndex,hlc,type,payload,crc}]} ; index entries {deviceId,seq} → segmentRef | (deviceId,seq) | permanent subject to compaction law; sealed immutable | CRC per segment (walk = tail each wake, full weekly); checkpoint hash in meta | upcast-on-read; physical exclusion on purge (property-tested); formatV stamped |
| `intents` | intentId → {state:intent|done|aborted, scope, issuedAt, resolvedAt, retryCount} | state | resolved intents archived after 30d (reconciler ignores) | boot scan detects dangling≠0 | same-txn as related journal append (durability hinge) |
| `missions` | missionId → {name,namedBy,state,concluded,outcomeNote,createdAt,lastActiveAt,tabIds[],windowBinding?,topicsRef?} | state · lastActiveAt · (state,lastActiveAt) | never auto | referential probe: every tabId exists in tabs | additive fields only; unknown preserved |
| `tabs` | ledgeTabId → {missionId,url,urlCanonHash,canonRulesV,title,domain,state:LIVE\|KEPT\|TRASH, firstSeenAt,lastActiveAt, scroll?, note?, contentIndexFlag, deletedAt?} | missionId · state · urlCanonHash · domain · (state,lastActiveAt) · deletedAt | KEPT: forever; TRASH: purge at deletedAt+30d | orphan-tab probe (mission alive) | unknown preserved; canonRulesV per record |
| `sessions` (snapshots) | snapshotId+partIndex → {missionId, tabRecordIds[], groupStyles[], takenAt, trigger:auto\|park\|crash\|manual} | (missionId,takenAt) | rolling 30d per mission (newest preserved) | part-count completeness | — |
| `recently_closed` (view-materialized) | entryId → {tabSnapshot, closedAt, source:external\|reconciled} | closedAt | 7/30/90d setting (30 default; unlimited Ledge+) | sweep probe | fold-out from tabs projection? NO — separate store per Blueprint (explicit refresh semantics) |
| `memory_artifacts` | artifactId → {subjectId,kind,value,confidence,provider,modelClass,schemaV,derivedFromSeqRange,createdAt,supersededBy?} | (subjectId,kind) · kind · derivedFromSeqRange | die-with-source (purge chain) | orphan-artifact probe | schemaV per record; rebuildable always |
| `search_index` | token → posting lists {tabId,field,tf} ; docMeta for BM25 norms | computed store | rebuildable | watermark lag probe | rebuilt on tokenizerV change |
| `dupe_index` | canonHash → tabIds[] | canonHash | rebuildable | — | — |
| `settings` | key → {value,schemaV,updatedAt} | key | permanent | schema validation per key | settings migration map |
| `ai_jobs` | jobId → {kind,subjectKey(=hash(kind,subject,stateHash)),payloadRef,lane,state,attempts,lease{workerTag,expires},artifactRef?} | state · lane · subjectKey(unique active) | terminal jobs 7d then purge | lease-expiry sweeps | — |
| `logs` (diagnostics) | seq# mod 500 → {level,msg(ctx redacted),ctxHash,ts} | ring | 500 rolling | redactor self-test on boot | — |
| `favicons` | domainHash → {blobRef, fetchedAt} | domainHash | TTL 30d | — | — |
| `delta_ring` (v1.1) | ringId → {watermark, view, ops} | watermark desc | last 500 deltas | gap detect | additive |
| `meta` | key → value (schemaV, deviceId, canonRulesV, tokenizerV, checkpointPtrs, purgeEpoch, undoStack(cap 20), nudgeCounters, firstRunDone) | key | permanent | invariant probe: checkpointPtrs valid | migration ledger (list of applied migrations) |

**Global storage laws:** (1) All multi-record mutations in a single txn; (2) journal/intent hinge: intent append + related snapshot in one txn (Tier-1 gate); (3) read models rebuildable — deleting any projection store is a supported operation; (4) purges are physical rewrites at journal level (compaction w/ exclusion); (5) every store has a fixture for migration N-1→N; (6) quota probe <80% capacity with persistence request at first-run.

---

# SECTION 6 — PORT CONTRACTS

*All ports: implemented in `infrastructure/*`, consumed only via application. Context ownership column says where the adapter executes. Contract suite conformance is a release gate (ADR-032).*

| Port | Purpose | Method inventory (behavior contract) | Typed failures | Context | Perf expectations |
|---|---|---|---|---|---|
| **TabsPort** | Live tab control | query(filter)→TabInfo[] · get(id) · remove(ids)→removed[] · create({url,windowId,index,active})→browserTabId · move(ids,{windowId,index}) · onEvents(stream) | E_CAPABILITY_API · E_NOT_FOUND_TAB (race-tolerant: remove already-gone = ok) | SW | query(all) ≤50ms @500 tabs; create/remove batched ≤1s per 100 |
| **WindowsPort** | Window control | list() · create({tabSpecs,focused})→windowId · remove(id) · focus(id) · onEvents | same class | SW | create(30-tab window) ≤1.5s |
| **TabGroupsPort** | Group fidelity | list(windowId) · create(tabIds,{name,color}) · update(groupId,style) · onChanged | style degrade-ok (warn, continue unstyled) | SW | ≤20ms/op |
| **NativeSessionsPort** | Recovery cross-check ONLY | getRecentlyClosed(max)→sessions[] (read-only; restore-by-Ledge only — no delegate restore) | E_CAPABILITY → degrade cross-check with logged gap | SW | ≤100ms |
| **RuntimeEventsPort** | onStartup/onInstalled/message/port lifecycle | subscribe(handler) registering synchronously at top-level (MV3 hard req) | — | SW | zero-latency registration |
| **AlarmsPort** | Maintenance scheduling | schedule(name,{periodMin≥0.5 Chrome floor}) · clear(name) · onFire | granularity floor abstracted (caller must not assume finer) | SW | drift tolerated ±20% |
| **OffscreenPort** | Workroom lifecycle | ensure(reasonHint)→docHandle · isAlive() (doc ping) · close(reason:idle) · resolveReasons() capability map | E_OFFSCREEN_SPAWN (retry ×1 with next reason candidate) | SW owns; doc executes | spawn ≤300ms warm-path amortized |
| **PermissionsPort** | Minimal-permission discipline | contains(scope) · request(optionalScope)→granted:bool (only post-consent-sheet) | E_CONSENT_DENIED (calm path) | SW/page (gesture-bound for request) | — |
| **StorageAreaPort** | chrome.storage local/session (markers, hot flags) | localGet/Set · sessionGet/Set (crash-marker semantics documented: session survives SW recycle, not browser restart) | E_CAPABILITY (Firefox parity check) | SW | sessionGet ≤2ms hot |
| **FaviconPort** | Icon URLs | iconURL(pageUrl)→chrome-extension://_favicon/… URL (no fetch by Ledge; render-bound) | — | surfaces | zero-cost |
| **CommandsPort** | Keyboard | register(map w/ conflict audit) · onCommand | conflict → reassign + one-time user note (Spec §5.3 law) | SW→surface relay | — |
| **ContextMenusPort** | Right-click verbs | registerMenu(stateSpecific set) · onClick | — | SW | — |
| **IdlePort** | Battery/heat governance | queryState(thresholdSec)→active\|idle\|locked | — | SW | — |
| **StorageEnginePort** | §5 stores | txn(scope[],mode)→tx · stores: missions/tabs/… typed CRUD · migrate(version,map) · quota() · persist() | E_QUOTA · E_CORRUPT_STORE · E_MIGRATION (checkpoint-restored) | SW + offscreen | write txn p95 ≤8ms @10k; index-coverage lint suite must pass |
| **JournalPort** (internal sub-port of storage family) | append/readRange/scan/compact/checkpoint per §2.8 | append(batch)→ack · readRange(fromSeq,toChk) · scanTail() · scanFull() · compact(policy) · checkpoint() | E_DURABILITY_TIMEOUT(250ms) · E_JOURNAL_INTEGRITY(segmentId) | SW (scan chunks may run offscreen) | append batch(20) ≤5ms p95 |
| **SearchRankPort** | §2.11 | query(q,scope,limit)→{ids,scores,freshness} · dupesFor(canonHash) · freshness()→lag | none-throwing (fallback law) | SW query; offscreen build | p95 ≤100ms @10k corpus |
| **ImporterPort** | §2.14 | detect(fileMeta)→parserId · preview(fileRef,progressCb) · commit(previewId,opts)→batchId | E_PARSE_REJECTS(threshold) · E_FORMAT_UNKNOWN · E_FILE_GUARD (size/time caps) | offscreen | 100k-line bookmark file streamed; memory ≤40MB |
| **ExportRendererPort** | §2.14 | buildModel(scope)→canonicalRef · render(format,canonicalRef,chunkCb)→manifest(verified) | E_RENDER_CHUNK(checksum) → regen ×2 → E_RENDER_FATAL | offscreen | 100k-tab export streams; ≤60s worst |
| **AIProviderPort (per capability: Namer/Clusterer/Summarizer/Embedder)** | ADR-018 ladder | capabilities()→{modelClass,langs} · estimate?(job)→costHint · execute(job,abortSignal)→candidate{value,confidence} | E_PROVIDER_DOWN · E_PROVIDER_TIMEOUT(breaker) · E_OUTPUT_MALFORMED | offscreen | interactive-lane p95 ≤2.5s heuristic; ≤8s ML |
| **RedactionGatewayPort** | Cloud egress consent boundary (v2-class; interface now) | sanitize(payload,category)→cleaned (param strips, title drop for private missions, denylist categories blocked) | E_REDACTED_BLOCK → caller must treat as skip | offscreen | pure, ≤1ms |
| **DiagnosticsPort** | §2.15 | log(level,msg,ctx) (async, drop-safe) · probeRegister(name,fn) · exportBundle(opts)→bundleRef | none-throwing | all contexts | ≤1ms/log amortized, batched flush |
| **CryptoPort (v2-boundary)** | phrase-derived sealing | deriveKeypair(phrase) · seal(deviceKey,segment)→blob · open(blob) → segment | E_KEY_MISMATCH (fatal for that device) | offscreen | ≥50k events/s seal throughput ref |
| **RelayPort (v2-boundary)** | encrypted replication | push(sealedSegments) · pull(sinceSeq) · registry ops | E_RELAY_DOWN (queue-and-wait) | SW | loopback harness at Tier 4 |

---

# SECTION 7 — NON-FUNCTIONAL REQUIREMENTS (measurable, gated)

## 7.1 Performance / Latency (CI-gated on reference hardware profile)
| Metric | Target | Corpus/Tier | Gate |
|---|---|---|---|
| SW cold wake → hub ready | ≤200ms p95 | any | perf suite |
| Park(100 tabs) durable ack | ≤500ms p95 | any | chaos+perf |
| Reflex search | ≤100ms p95 / ≤250ms p99 (freshness-fallback included) | 10k; warn-reeval 50k | perf suite |
| Quiet-page first contentful render | ≤300ms | 1k missions | perf suite |
| Resume(30 tabs) → first tabs visible | ≤1s; full ≤3s | any | e2e |
| Ingest projection cost | ≤5ms/event amortized | burst 500 | perf |
| Journal append batch(20) | ≤5ms p95 | — | perf |
| Compaction chunk | ≤30s CPU bursts, background-only | 200k | soak |
| Interactive-lane AI (rename on gesture) | ≤2.5s heuristic p95 | any | perf |

## 7.2 Memory (steady-state, CI sampled)
SW ≤30MB · offscreen ≤40MB idle (models unloaded within 60s idle) · per-surface ≤60MB active · **total standing footprint <75MB** · 24h soak leak delta <5MB.

## 7.3 Bundle budgets (build-gated)
Core SW entry ≤300KB gzip (excl. ML models) · quiet-page chunk ≤150KB gzip · overlay+guardian combined ≤80KB gzip · importers/exporters chunks lazy ≤120KB gzip · WASM vendored separately, loaded on-demand only · runtime deps ≤5 (ADR-044h) with audit-clean report.

## 7.4 Accessibility (spec §4.5/§5.13 — zero-defect gate)
WCAG 2.2 AA target · full keyboard operability of every surface & workflow · screen-reader coverage incl. heartbeat via polite live-region · 200% zoom no function loss · honor OS reduce-motion · all interactive targets ≥44px · copy lint: no exclamation marks, no urgency/shame lexicon (CI wordlist).

## 7.5 Security / Privacy (gates)
Manifest permission set **exactly** ADR-022 (diff review sign-off) · zero host permissions · zero remote code · egress-guard: network allowlist = ∅ in CI · CSP audit incl. documented wasm exception · boundary-validator fuzz suite zero crashes/leaks · dependency audit clean (≤5 deps, pinned) · redaction self-tests · purge-law property tests (bytes physically absent) · incognito: not requested.

## 7.6 Offline / Degradation
100% of v1 features functional with network disabled (offline E2E pass) · degradation matrix executed as tests: AI off → e2e green; offscreen unavailable → heuristic tier; sync stub absent → no user-visible difference.

## 7.7 Battery / Politeness
Background wake budget: ≤6 alarm-driven wakes/hour steady-state (excluding user-triggered) · AI background lane requires idle+battery-ok signals · no periodic keep-alive tricks (hard rule, reviewed in manifest/code audits).

## 7.8 Reliability (the charters, measured)
Zero tab loss in full chaos matrix (kill at each enumerated phase boundary × jitter seeds) · Park guarantee: no `TabsParked` recorded without prior committed `ParkIntentAccepted`+snapshot (invariant asserted in tests and in runtime probe) · recovery RPO = last committed intent; RTO ≤5s boot reconcile; W7 card latency ≤2s after first paint · health-probe false-positive rate on clean systems ≈0 (fixture-verified).

## 7.9 Scalability tiers
10k (target smooth) · 50k (budgets hold; index reeval note) · 200k (load: UI virtualization verified, compaction soak ≤ budgeted window, rebuild-with-checkpoints ≤ documented time) · 1M events/yr/user projection: compaction+checkpoint cadence keeps tail scans ≤50ms.

## 7.10 Recovery & supportability
Rescue console flows complete ≤ user-guidable 3 steps each · diagnostics bundle generation ≤10s · every TypedError maps to copy keys (no-unmapped lint) · playbook coverage: each §9 failure row has a runbook doc.

---

# SECTION 8 — TEST STRATEGY

| Suite | Scope & requirements | Tooling class | Gate level |
|---|---|---|---|
| **Unit** | domain deciders/policies 100% line+branch on invariants; kernel (clock/canon/id) golden tables; upcasters pure & total | standard TS runner | PR-blocking |
| **Property** | replay invariants (no-lost-tabs; referral counts; determinism same-seed); canonicalization idempotence; purge-law byte-absence (compaction w/ exclusion); undo round-trips; sync merge commutativity/idempotency (Tier 4) | fast-check-style; ≥1k seeds CI, 10k nightly | PR-blocking |
| **Contract (ports)** | ADR-032 law: identical suite passes per adapter; index-coverage lint for StorageEnginePort; scheme-allowlist fuzz on TabsPort.create | harness in ops/tests | PR-blocking |
| **Integration (e2e golden flows)** | W1, W4, W5, W6, W7(with real restart), W13, W14(round-trip), W15 + delete/undo; runs real Chrome profile via automation; screenshots attached | puppeteer-class, load-unpacked | PR-blocking (smoke), full nightly |
| **Chaos** | kill SW at every two-phase boundary (enumerated list maintained in ops/chaos/points.txt); offscreen kill mid-job (exactly-once artifact law); corrupted journals (seeded truncations/bit-flips → truncate+reconcile exactness); IDB latency injection; crash-marker absence flows | custom driver + fixtures | nightly + release |
| **Migration** | every store N-1→N fixtures incl. unknown-field preservation; rollback-on-failure path test | fixture suite | per schema change |
| **Performance** | §7.1–7.3 budgets on reference profile; corpus generators (10k/50k/200k synthetic realistic entropy); regression compare vs baseline build | headless harness | nightly; release-gating |
| **Security** | boundary validator fuzz; innerHTML sink audit (lint + grep denylist); CSP verifier; egress-guard; scheme smuggling corpus (javascript:, data:, chrome:); dependency audit | CI scripts | PR-blocking |
| **Acceptance** | spec-derived checklists per workflow (Spec §8.5 adapted); a11y checklist (§7.4); copy lint (Principle 22) | scripted + manual sign-off | release-gating |
| **Regression** | every field bug → failing test first, fix second; seed corpus curated | all suites | PR-blocking |

**Release gates (all must pass, recorded in release manifest):** PR suites green · chaos 0-loss · perf budgets green · bundle budgets green · egress ∅ · manifest diff approved · a11y zero-defect · copy lint pass · migration fixtures green · rescue-console smoke on clean profile · release notes generated from ADR-note list + changelog.

---

# SECTION 9 — BUILD CHECKLIST (per subsystem)

Format: **DoD** (definition of done) · **Acceptance criteria** · **Required docs** · **Required tests** · **Required benchmarks**.

1. **shared-kernel** — DoD: pure, zero-deps outward. AC: golden tables (ids/clock/canon) green; upcaster fixtures. Docs: schema registry README. Tests: unit+property. Bench: canon ≤50µs/op.
2. **domain/lifecycle** — DoD: invariants §2.5 test-locked. AC: illegal-transition matrix yields correct E_DOMAIN_LEGALITY/messages keys. Docs: transition×state table. Tests: unit 100% invariants. Bench: decider ≤0.1ms.
3. **application/hub** — DoD: single-writer enforced (no other context importing mutation ports — lint). AC: pending→terminal exactly-once across kill-sim; priority classes respected under synthetic load. Docs: message registry page. Tests: integration+chaos join. Bench: dispatch p95 ≤20ms non-browser ops.
4. **journal** — DoD: durability+CRC+compaction-exclusion property-proven. AC: ack persistence across immediate kill; truncate+SnapshotReconciled exactness; purge-bytes-absent proof. Docs: segment format spec. Tests: property+chaos+soak. Bench: append ≤5ms/20; tail scan ≤50ms.
5. **storage** — DoD: schema v1 + migrations + quota discipline. AC: unknown-field round-trip; migration restore-on-fail. Docs: schema doc per §5. Tests: migration/property. Bench: §6 perf rows.
6. **projections** — DoD: determinism (same journal ⇒ identical read models) proven. AC: rebuild-on-dirty auto-recovery; watermark gap detection. Docs: projector catalog. Tests: property+integration. Bench: ≤5ms/event.
7. **chrome adapters** — DoD: every method contract-passing on reference Chrome; contract suite runnable on beta channel. AC: race-tolerant removals; graceful group-style degrade; conflict-audit for commands. Docs: port map + permission justifications. Tests: contract suite. Bench: §6 rows.
8. **messaging/validators** — DoD: envelope+registry+handshake; both dual-read windows demonstrable. AC: fuzz zero-crash; unknown-name ignore law; Zone-1 allowlist enforcement (fixture). Docs: contract v1 doc. Tests: fuzz+integration.
9. **recovery** — DoD: marker semantics + reconciler + cross-check + gating rule (card only on loss-risk). AC: update-vs-crash disambiguation copy path; precise-scope BootReports on seed corpus. Docs: runbook. Tests: chaos+e2e browser-restart.
10. **search** — DoD: index projection + ranker + fallback laws. AC: freshness-fallback correctness on lag; CJK bigram recall on golden corpus; dupe FP ≤2% crafted corpus. Docs: tokenizer notes. Tests: property (index=projection), recall sets, perf. Bench: §7.1 rows.
11. **ai pipeline+providers** — DoD: queue/lanes/leases + isolation lint green. AC: exactly-once artifact under offscreen kill; AI-off e2e pass; confidence-law presentation on fixtures; lane shed order correct. Docs: provider matrix + budgets doc. Tests: chaos, property (artifact schema), shadow-eval harness (Tier 3). Bench: interactive-lane p95 targets.
12. **importers** — DoD: three parsers, two-phase, batch-undoable. AC: rejects quarantine + report file; >threshold corrupt abort path; provenance timestamps preserved. Docs: supported-format doc + rejects semantics. Tests: golden fixtures incl. hostile files. Bench: 100k-line stream ≤ memory budget.
13. **exporters** — DoD: three renderers streamed+verified. AC: HTML renders standalone offline from export alone; checksum failure path exercised; no silent partials. Docs: **export-format spec v1 (public covenant)**. Tests: round-trip, adversarial-corruption. Bench: 100k-tab stream ≤60s.
14. **surfaces** — DoD: message-only authority, pending-honest states, catalog-only strings, a11y §7.4 zero defects. AC: resync flow on forced gap; heartbeats match §10-R10 definition exactly; empty states per Spec §5.9. Docs: surface→contract map. Tests: e2e+a11y+copy lint. Bench: §7.1/7.3.
15. **diagnostics** — DoD: redaction default, probes registry, bundle export. AC: include-flip auto-decay; redactor-fail-drop proof; probes self-test. Docs: playbook index. Tests: unit+integration.
16. **roots/CI** — DoD: composition-only roots; all §8 gates wired (block on red). AC: dep-law fixture fails build; egress fixture fails build; bundle budget fixture fails build. Docs: pipeline README + release checklist.

---

# SECTION 10 — ENGINEERING REVIEW (ambiguity hunt & resolutions)

*Method: reviewed §2–§9 as two fictional teams (Team A platform, Team B experience) building independently; every disagreement point resolved here as binding law (**R#**).*

**R1 — Ack-of-durability semantics.** Ambiguity: is C3–C6 terminal "Applied" after tabs actually close, or after intent commit? **Resolution:** `CommandAck{accepted-pending}` follows durable intent commit; `CommandApplied` follows browser close completion (or conservative abort). Surface must render pending until Applied; Guardian heartbeat updates only on Applied (never on Ack) — prevents "safe" claims pre-truth (Spec W4/§5.11).

**R2 — Race: user manually closes a tab while its Park intent is in flight.** Chrome `onRemoved` fires external-close for an intent-covered tab. **Resolution:** reconciler treats `TabClosedExternal` referencing a tabId inside an in-flight intent as *completion evidence for that tab* (secured = already-in-snapshot by two-phase law); `TabsParked.secured` counts it once. Double-counting forbidden; dedupe key `(intentId, browserTabId)`.

**R3 — Browser tab identity volatility across resume.** **Resolution:** Ledge `ledgeTabId` is the only durable identity; `browserTabId` re-issued per resume and recorded in `MissionResumed.restoredMapping` (traceability). No contract may carry browserTabId outside live-window contexts.

**R4 — Group-style fidelity.** **Resolution:** `SnapshotTaken.groupStyles[{groupId,name,color,collapsed,tabOrder[]}]` is mandatory payload; restore must reproduce styles best-effort and degrade with a `moved/styled-lost` note in the resume outcome only — never block restore on style failure (§6 TabGroupsPort degrade law).

**R5 — Oversize missions.** **Resolution:** snapshots chunked at 500 tabRecords/part (ordered parts, same snapshotId); imports/exports stream regardless of size; contracts capped per §3.1(f).

**R6 — "Seen" scope from the Vision vs. SearchQuery scopes.** Vision implied semantic history search; ADR-022 forbids `history` permission. **Resolution:** v1 scopes = `open|kept|closed|all`. "History-adjacent" behavior (Spec W6 failure widen) = Recently-Closed scope only. Semantic recall beyond this is Ledge+/v2 with explicit consent design. Any implementation touching chrome.history is a release-blocker violation.

**R7 — Confidence tier constants.** **Resolution:** tiers are contract constants: HIGH ≥0.85 · MED 0.60–0.85 · LOW <0.60; presentation mapping (Spec §6.11) applied server-side in Memory application (GetMissionDetail serves pre-mapped tiers). Constants tunable via flag until Tier-3 freeze, after which changes require ADR note.

**R8 — HLC & wallClock.** **Resolution:** correctness never depends on wallClock (skew law §2.2); wallClock is display-only and may be null on imported/legacy events.

**R9 — Undo without actionId.** Ambiguity: auto-retry could double-undo. **Resolution:** C18 is never auto-retried by any transport logic; surfaces disable repeat-submission until terminal; undo stack cap 20 persisted in meta; inverse atoms validated against current state, conflict ⇒ E_DOMAIN_UNDO_CONFLICT w/ recovery key (offer trash-based path).

**R10 — Heartbeat exact semantics.** **Resolution:** `heartbeat.keptCount` = count of tabs in KEPT state (all missions) ; `liveRecoverable` = LIVE tabs covered by journal snapshots/intents (i.e., restorable); displayed phrasing from catalog `msg.heartbeat.safe` with both numbers; computed from read models post-Applied events only (R1).

**R11 — Import atomicity vs 100k-row files.** **Resolution:** commit applies per-tab events in chunked txns **under one batchId**, preceded by `ImportCommitted` marker (stage=begin) and followed by stage=complete marker; undo targets batchId and is legal only if stage=complete exists (else auto-cleanup of partials under same batchId). Determinism: identical input file + identical dedupeMode ⇒ identical outcome set, tested.

**R12 — Hidden coupling: search topics join when Memory artifact absent.** **Resolution:** search projector treats topics as optional denormalized hints; absence never downgrades results to fallback; topics appear after artifact application without reindex (posting-field patch op) — else Team B would have coupled topics-gating into query law.

**R13 — Trash restore with dead parent mission.** **Resolution:** restoring a tab whose mission was hard-purged (only possible post-trash-purge of mission, mission purge cascades only after its own trash period): resolve by re-creating a minimal mission (`name=tab.domain`, namedBy=system) with restoration note; rule documented in C16 contract (parent-resolution).

**R14 — Sweeper vs. concurrent restore.** **Resolution:** single-writer hub serializes sweeps with restores by `deletedAt` cutoff evaluated at sweep transaction start; item restored in same txn-window is excluded from purge set. No locks beyond hub serialization (documented so clients don't invent client-side coordination).

**R15 — Morning/nudge counters timezone.** **Resolution:** counters in meta keyed by local-midnight bucket of device (timestamp floored), no cross-day carry; dismissal memory per nudgeType: 14-day suppression, third dismissal ⇒ forever (Spec §6.10 law). Timezone changes simply lengthen/shorten a day — no correction logic.

**R16 — Crash-signal false positive on update.** **Resolution:** version-change marker (set in onInstalled) disambiguates; copy path `msg.recovery.updated` vs `msg.recovery.crashed`; card eligibility per Blueprint §14.4 gate (loss-risk only).

**R17 — Two ambiguous priorities: dupe-whisper vs. resume flows spawning same URL.** **Resolution:** whispers are informational markers only; never block or alter restore (Spec law: restore is user-invoked truth; dupes are gossip).

**R18 — Ownership ambiguity: who computes presentation tiers (§6.11)?** **Resolution:** Memory application layer (R7) — surfaces must not contain threshold logic; keeps confidence law single-sourced.

**R19 — Build ambiguity: dynamic imports.** Allowed ONLY for bundled chunks (surfaces entry chunks, importers, exporters, ML models) per §7.3; remote/URL-based dynamic import is classified as remote code = security gate violation (lint-enforced).

**R20 — Contract-hash rollout.** Two builds with different `contractHash` must negotiate: minor → dual-read; major → ResyncRequired{schema}+update prompt. Window: one release for surface-side tolerance of SW-major changes (auto-update cadence makes longer windows meaningless).

**Post-review certification:** with R1–R20 applied, the interface set is ambiguity-closed for two independent teams: identical message tables, identical event laws, identical storage semantics, identical budgets, identical gates. Any NEW ambiguity discovered in build follows the same register (append as R21+) via ADR-note process — the register is the contract's changelog.

---

*Specification ends. This document, with its four locked parents, constitutes the complete engineering contract for Ledge. Next sanctioned artifact: the **Tier 0 task board** — decomposed work items with owners and exit-gate links, generated directly from Section 1 and Section 9.*
