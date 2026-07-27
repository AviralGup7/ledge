# Threat model (E7-T05) — boundaries, attacker classes, mitigations, gates

**Stance:** Ledge is a local-first vault for browsing truth. Its security story
is structural, not heroic: the smallest possible privilege set (ADR-022),
network egress **∅** by gate (A-10), hostile-input validation at every scanner
boundary, and fail-closed truth law. Blueprint §11 is the frozen security
model; this document makes it operational: who attacks through which boundary,
what mitigates them, and which CI gate proves the mitigation is still on.

Version lineage: v1 surfaces only (guardian/overlay/quiet + SW + offscreen).
Sync/relay (v2, ADR-021/042s) and AI cloud depth-mode (v1.1+) are future
registers — their rows are marked and must not be read as shipped behavior.

---

## 1. Trust boundaries (Blueprint §11)

| boundary                    | sides                            | never crosses it                                                                                                  |
| --------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| B1 message bus (SW lattice) | surfaces ↔ SW hub                | authority: surfaces hold no storage, no browser mutation — messages only, boundary-validated per contract version |
| B2 browser storage (IDB)    | SW/offscreen ↔ IDB               | raw tab data never leaves the device tier; sealed segments are append-only (ADR-004/013)                          |
| B3 import parsers           | user-picked files → model        | hostile bytes never reach view code unvalidated (stream guards, size caps, structural schema validation)          |
| B4 chrome.* adapters        | hub → browser                    | re-issued navigations only via scheme allowlist (http/https); title string never becomes HTML                     |
| B5 diagnostics bundle       | device → user-chosen destination | unredacted addresses unless the 24h-decay include-flip is on; nothing leaves device otherwise (ADR-027/028)       |
| B6 supply chain             | deps → build                     | ≤5 pinned audited deps (Dexie-only runtime v1), dep-policy gate, manifest diff sign-off                           |

---

## 2. Attacker classes & mitigations

### A. Hostile content (untrusted page data)

**Attacker:** a web page (or hijacked tab) planting payloads in titles/URLs —
XSS-through-title, scheme smuggling, oversized strings.
**Mitigations:** safe-text renderers only (no innerHTML anywhere — CI lint);
URL scheme allowlist at every open/restore; canonicalization preserves but
never interprets (E2-T01). **Gates:** `pnpm test:security` (boundary fuzz +
injection firewalls), egress/cops lints, contract validators
(`src/application/contracts/contracts.test.ts`).

### B. Hostile import files (Zone-2 bytes)

**Attacker:** crafted OneTab/SessionBuddy/Netscape files: parser bombs,
mega-lines, scheme quarantines, truncated JSON, hostile encodings.
**Mitigations:** streaming parsers with byte/mega-line guards (E_FILE_GUARD);
structural validation before preview; quarantine of bad rows; atomic abort
past threshold; two-phase commit with batch-undo legal only on complete
(EES-R11, ADR-044). **Gates:** 14-class hostile corpus
(`ops/fixtures/import/`, privacy-clean per `ops/tests/unit/fixtures/
corpus-privacy.test.ts`), parser suites
(`src/infrastructure/importers/parsers.test.ts`).

### C. Renderer/page injection into the bus

**Attacker:** a compromised or spoofed extension page sending forged commands
(schema-mismatched, wrong-context verbs, replayed cids).
**Mitigations:** envelope contract v1 + handshake (ADR-010); sender-context
allowlists per verb (Zone law: §11 reject-unknown on Zone-1); capability
checks envelope-derived, never payload-claimed (the E6 forced-scan law:
rescue-console capability verified from `senderContext`, not a flag); cid
dedupe + idempotency keys; command validation fuzz. **Gates:** contract suite
51 (+5 beta-channel skips), boundary fuzz in `pnpm test:security`, census law
(30C/9Q/13S/17W/5S pinned in `ops/tests/unit/surfaces/contract-compat.test.ts`).

### D. Local attacker with profile access

**Attacker:** someone with the user's Chrome profile directory — reads the
IDB bytes directly.
**Stance (honest):** v1 stores browsing truth **unencrypted** on-device —
same exposure class as the browser's own history/session stores (they are
equally readable). Purge law is therefore physical, not logical: purge-bytes-
absent is proven (compaction-with-exclusion, ADR-020), private-window tabs are
never recorded (incognito not requested, not seeable). **Gates:** purge-law
property suites (`src/infrastructure/journal/compact/compact.property.test.ts`),
`pnpm test:property`.

### E. Extension-store social + updater

**Attacker:** fake lookalike listing; hostile update review.
**Mitigations:** manifest baseline diff gate — shipped manifest must equal the
signed baseline (`ops/ci/manifest-baseline.json` via `pnpm check:manifest`);
permissions exactly ADR-022 with per-permission port justification
(`docs/permissions.md`); zero remote code by CSP (`script-src 'self'`,
documented wasm exception ADR-040); store-listing posture is ops-playbook
(outside code scope). **Gates:** manifest guard, bundle budgets, egress ∅.

### F. Dependency supply chain

**Mitigations:** ≤5 pinned runtime dependencies, Dexie-only v1, lockfile
frozen; `pnpm check:dep-policy` audits licenses + growth class; no postinstall
network (mirror store WXT). **Gates:** dep-policy in `pnpm ci:all`.

### G. Self-inflicted exfil via diagnostics

**Attacker model:** the user themselves, socially pressured to share data.
**Mitigations:** redaction default-ON (URLs/domains hashed); include-addresses
flip off-by-default, auto-decays ≤24h (read-side, no timers); redactor
fail-drop (a redactor fault DROPS the entry, never passes raw); bundle is
assembled locally, handed to a user-chosen Blob download — no telemetry
endpoint exists (ADR-028: "nothing leaves your device unless you choose to
send it"). **Gates:** diagnostics suite incl. sabotage fixtures
(`ops/tests/unit/infrastructure/diagnostics.test.ts`) + boot self-test.

### H. Future registers (not shipped)

- **Sync relay (v2):** zero-knowledge sealing — relay sees ciphertext +
  opaque ids only; key mismatch ⇒ paused queue with plain-language notice.
- **AI cloud depth-mode (v1.1+):** redaction gateway (ADR-018) strips denylist
  params, drops titles of private-flagged missions; per-day budget caps;
  breakers; absence-of-brief posture.
- **Consent-gated content indexing (Zone-1):** separate reduced schema,
  reject-unknown validation, no high-trust commands.

---

## 3. Gate census (§7.5 rows → executable homes)

| §7.5 gate                                  | executable witness                                  |
| ------------------------------------------ | --------------------------------------------------- |
| manifest exact (ADR-022)                   | `pnpm check:manifest` + manifest baseline in CI     |
| zero host permissions / zero remote code   | wxt.config CSP + bundle guard (`pnpm check:bundle`) |
| egress allowlist ∅                         | `pnpm check:egress`                                 |
| CSP audit incl. wasm exception             | ADR-040 wxt config comments + bundle guard          |
| boundary-validator fuzz zero crashes/leaks | `pnpm test:security`                                |
| dependency audit ≤5 pinned                 | `pnpm check:dep-policy` (in `pnpm ci:all`)          |
| redaction self-tests                       | diagnostics boot self-test + unit fail-drop proof   |
| purge-law bytes physically absent          | `pnpm test:property` (compaction exclusion)         |
| incognito not requested                    | manifest baseline (absence pinned)                  |

**Review cadence:** this model is re-walked at any epic touching B1–B6
(messaging, storage/adapters, import/export, sync, AI lanes, dependency set)
and at milestone gates; changes land with matching gate updates in the same PR.
