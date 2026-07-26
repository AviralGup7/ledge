# ADR note — E4 Surface Layer decision record

**Status:** accumulation of route-level decisions taken while building the E4
Surface Layer (guardian strip, reflex overlay, quiet page, shared surface
components, surface testkit). No ADR reversals; every item composes within
ADR-005 (single-writer — surfaces own no truth), ADR-007 (listener-first —
every surface detaches symmetric with attach), ADR-010 (frozen dual-read
contract window — surfaces validate against the registry they ship with),
ADR-022 (manifest baseline — no permission/key additions), ADR-026 (typed
`LedgeError` everywhere — surfaces transport, never mint). **Authored:**
2026-07-26, E4 close-out.

This note exists so no decision below lives only in a commit message or an
inline comment. Each entry: the question, the decision, the why. Items marked
**[follow-up]** name the milestone that owns the remaining work.

---

## 1. Wire session law (`components/session/*`)

### 1.1 Surface-side cid minting is correlation-only, never truth

Surfaces may import only `application/contracts`, `application/hub`, and
`surfaces/components` (depcruise `surfaces-are-authority-free`), so the
kernel's ULID mint is unreachable by import law — yet §3.1 requires every
envelope to carry a ULID-shaped `cid`.

**Decision:** `ids.ts` mints the wire-half locally (48-bit ms time + 80-bit
entropy, monotonic per ms by base-32 carry) with two explicit adaptations: the
clock above `TIME_MAX` **clamps** (the kernel _throws_; a rendering mint must
never throw) and entropy arrives through an injected `CidEntropy` seam.
Justification recorded: a cid correlates one send with its streams; it is
never persisted truth, so minting it outside the kernel cannot corrupt any
ledger. **Regression-pinned:** `ids.test.ts` (shape, ceiling clamp,
same-ms monotonicity, uniqueness).

### 1.2 Two-phase R1 honesty is enforced in the client, not by discipline

Every `command`/`query` returns `{ack, terminal}`: the ack resolves with the
synchronous dispatch answer; the terminal resolves **only** from a correlated
`CommandApplied`/`CommandFailed` stream (dispatcher exactly-one law). Between
the two, the op sits in a pending ledger the guardian/quiet strips render as
honest "Confirming…" chips. **Decision:** no surface code path can move a
heartbeat, a grid, or a close action off an ack — the affordances are
structurally unwired (heartbeat moves only on `HeartbeatUpdate`; overlay
closes only on Applied). **Regression-pinned:** guardian/overlay/quiet suites.

### 1.3 Pending ledger is fail-closed and bounded

A send whose terminal never arrives within `PENDING_TTL_MS` (600 s) resolves
failed with `E_DURABILITY_TIMEOUT`; the ledger is capped at 64 unsettled ops
and evicts **oldest-first with a terminal failure** — never silently dropped
(memory law + no-lies law in one). A **third** failure mode is
surface-discovered: transport unreachable (SW asleep/unregisterable) resolves
failed with an `E_CAPABILITY` pair. **Regression-pinned:** `client.test.ts`.

### 1.4 Watermark bookkeeping lives client-side; surfaces decide rejoin

`noteWatermark(view, seq)` answers `ok | duplicate | gap` (gap includes
regression); `resetWatermarks` re-bases after a full snapshot rejoin. The §3.5
gap law is thereby owned at one seam — a surface never hand-computes seq
arithmetic. **Regression-pinned:** `client.test.ts`.

---

## 2. Stream/view handling (`components/state/view-store.ts`)

### 2.1 ViewDelta application is deserialization, not projection

Ops arrive keyed (`upsert|remove|patch`); the store applies them mechanically
against the four frozen view pks (`missions→missionId`, `tabs→ledgeTabId`,
`sessions→snapshotId`, `recentlyClosed→entryId` — the E3 10.3 totality set,
mirrored). No derivation, aggregation, or merge inference — patches spread
onto existing rows, nothing more. **This is the load-bearing "surfaces are
thin" law:** anything smarter here is a second projection engine.

### 2.2 Gap or regression ⇒ nothing applies, full snapshot rejoin

`applyFrame` returning `'gap'` means _the frame was not applied_ — partial
truth is never rendered (duplicate ⇒ idempotent no-op; unknown view ⇒
`'reset'`). Surfaces respond to gap/death resyncs by disposing the store and
re-running bootstrap+peek queries (a full snapshot rejoin), with the resync
banner as the only visible state. **Regression-pinned:** `view-store.test.ts`

- guardian/quiet stream tests.

### 2.3 Schema-major resyncs are calm, never silent partials

`ResyncRequired{reason:'schema'}` (recovery-owned, E3 5.5) renders the generic
`E_OUTPUT_MALFORMED` error+recovery **pair** in the banner lane — the user
keeps their section; no automatic rejoin, no half-applied schema.

---

## 3. Copy/error-law compliance (catalog + ERROR_MAP triangulation)

### 3.1 Surfaces never invent error copy — not even locally

The first E4 draft minted catalog keys (`msg.error.sent`, `msg.error.update`,
`msg.recover.reload`) for surface-synthesized failures and schema banners.
`error-map-lint` (CI) rejected them as **orphan copy**: error prose may exist
only where a declared `E_*` code maps to it.

**Decision:** every surface-emitted pair rides pairs the frozen `ERROR_MAP`
already owns — unreachable SW ⇒ `E_CAPABILITY` (`msg.error.capability` +
`msg.recover.retry`); ledger TTL ⇒ `E_DURABILITY_TIMEOUT` pair; malformed
wire ⇒ `E_OUTPUT_MALFORMED` pair; schema banners render the `E_OUTPUT_MALFORMED`
pair in-banner. **Triangulation gate:** `contract-compat.test.ts` "error copy
triangulation" re-checks those pairs against `error.catalog.ts` + catalog, so
this class of divergence now fails in the surface lane before CI sees it.

### 3.2 Undo labels are currency-constrained — and the enumeration is emitter-derived

Surfaces announce undo results via `copyOf(result.undid)` where SW returns a
`msg.undo.*` key (E3 2.3). **The first E4 draft pinned the label set with a
hand-written list that mirrored the catalog, not the emitters — and the
verification audit (E4-F1) caught the consequence: the frozen Domain emits
`msg.undo.archived` (`transitions.ts`) while the catalog carried orphans
(`unarchived`, `restored`) instead, so undo-of-archive would have rendered the
raw key.** Fixed in E4-FIX-01: the catalog now carries `undo.archived`, the
orphans are gone, and the label law is **emitter-derived** — the copy suite
scans `src/**` production source for `'msg.undo.*'` literals and requires every
emitted label to resolve, plus every catalog undo label to have an emitter or a
surface consumer (both directions; the hand-mirrored class cannot recur).

### 3.3 The `no-raw-copy` eslint law held zero exceptions

All prose in `src/surfaces/**` flows through catalog keys — including state
chips, aria labels, hints, dialogs, and every error path.

---

## 4. Registry-shape defects caught by contract-compat (fixed in E4)

The compat suite validates every literal payload the surfaces send against the
frozen registry validator. It caught — at test time, before any runtime —

1. **`ResumeMission` missing required `mode`** (4 call sites across all three
   surfaces; the registry requires `mode: 'full' | 'partial'`). Fixed: full
   resume is the UX, `mode: 'full'` is explicit everywhere.
2. **`RestoreRecentlyClosed` missing required `target`** (quiet-closed row
   restore). Fixed: `target: 'new'` — restore lands in a fresh mission; no
   picker exists in v1 UX.
3. **`ExportRequest` missing required `formats`** (quiet export button).
   Fixed: `formats: ['json', 'html', 'md']` — one-button all-in export.

Each would have been rejected by the SW boundary validator at runtime
(`E_OUTPUT_MALFORMED`). The guard posture is precise (amended after audit
E4-F2): the compat suite validates **transcribed** payload fixtures (scan →
fixture-exists → fixture validates), which catches fixture drift but not a
call-site-only shape edit. **E4-FIX-01 closed that gap at the boundary: the
fake transport now fail-fast validates every envelope any surface test sends —
name resolution, wire-kind parity, `senderContext` enum, and the payload
through `validateObject` — and surface-suite fixtures carry ULID-honest ids, so
a shape drift at any executed call site throws in the suite that caused it.**
The boundary validator is self-pinned by `fake-transport.test.ts` (a validator
that stops throwing fails there).

---

## 5. DOM/test posture

### 5.1 No jsdom/happy-dom — fakes assert the injected-Document seam

The unit lane runs DOM-free on purpose. `fake-dom.ts` implements exactly the
vocabulary surfaces use (attributes, textContent, tree queries incl.
`getElementById` semantics, target-scoped listeners, input values); surfaces
receive `doc: Document` and must not touch globals — the fake doubles as a
conformance proof of A-02 (roots give real DOM in production).

### 5.2 Duck-typing law inside components

No `instanceof HTMLElement`/`HTMLInputElement`/`Element` anywhere in
`src/surfaces/components` — identity rides marker attributes, a string-valued
`value` slot, or a `tagName` string. DOM constructors do not exist in Node;
entanglement would be both a test bug and an architecture smell (one more
ambient-DOM reach).

### 5.3 Fake transport scripts the wire, never mocks the client

`fake-transport.ts` records every envelope (the compat + surface suites assert
`senderContext`, `kind`, `payload`, `contractHash` against the registry) and
answers acks through a scriptable responder; streams emit exactly like the
outbox's broadcast shape — sequences follow **real wire order**: send → ack →
`CommandAck`(optional) → terminal. Nothing about the SW is mocked by contract;
only the transport is faked. Since E4-FIX-01 the fake **also** plays the SW's
boundary-validator role (fail-fast, §4 above) — the suites therefore verify the
surface against the same shapes the runtime enforces.

---

## 6. Roots and composition

### 6.1 Surface roots are self-contained (root→root import is illegal)

`roots-are-terminus` forbids one root importing another; each surface root
therefore carries its own thin chrome bindings (transport send/listen,
entropy, wake list) instead of delegating to a shared root helper. The
duplication is ~15 lines per root and buys the terminus law: composition
never becomes a second dependency graph.

### 6.2 Quiet-page root extension was additive

`bootstrapQuietPageApp` joins the pre-existing `bootstrapQuietPage()` (E3
skeleton path, still intact + tested by `roots.test.ts`) instead of replacing
it; the E4 entrypoint dispatches between them by flag in the root module.

### 6.3 `composeSurfaceChannel` binds SW-side once

bg-root builds the channel inside `bootstrapBackground()` on the **same**
graph instance it returns (a double-compose bug was caught and fixed); the
onMessage listener answers `{outcome:'ack'|'ignored'|'rejected'}` and returns
`true` for the async MV3 response law.

---

## 7. Overlay form factor **[follow-up: ADR-022 sign-off]**

### 7.1 v1 overlay is an extension page, not an in-page palette

Host permissions are forbidden (ADR-022 baseline), so an overlay injected into
arbitrary pages is impossible at this manifest. The v1 overlay is a WXT
extension page (own `.html`, own bundle, `/surfaces.css`), mounted on demand —
all search behavior, palette a11y semantics, and close-on-Applied semantics
are identical to the in-page design.

### 7.2 Deferred, sign-off-gated

Global `⌘⇧K` (commands manifest key) and `action.default_popup` are manifest
deltas requiring ADR-022 sign-off; neither was silently shipped. The
surfaces-keyboard action stays documented in the final report's remaining
work.

---

## 8. Bundle/check ratchets

### 8.1 overlay+guardian budget flip

`ops/ci/budgets.json` flipped `overlay+guardian` from `required:false` to
`required:true` — the ratchet comment prescribes the flip "rides with the PR
that ships the entry"; E4 ships it. Measured: 6.0 KB gzip against the 80 KB
budget (all surface chunks incl. shared widgets).

---

## Post-audit fix register (E4-FIX-01 · 2026-07-26)

The independent E4 verification audit (`E4-VERIFICATION-AUDIT.md`, workspace)
returned two findings; both fixed in this milestone, no silent edits:

- **E4-F1 (Medium):** `msg.undo.archived` 404 → catalog key added, orphans
  pruned, label law became emitter-derived (§3.2). The guardian suite now
  narrates undo-of-archive end-to-end and asserts the live region never shows
  a raw key.
- **E4-F2 (Low):** payload guard was transcription-backed → fake transport
  became a fail-fast boundary validator (§4/§5.3). The ratchet immediately
  re-caught the exact trap class it was built for (shape-invalid fixture ids
  flowing through real call sites); fixtures are now ULID-honest, which the
  boundary enforces permanently.
- **E4-O1 (trivial):** report line-count figures are approximations; no code
  action, noted for the report's next revision.

## Consequences

- Every surface action traces to a registry command + every surface message
  to a DTO/§3.5 name; the compat suite makes this mechanical, so a future
  surface cannot silently drift the wire.
- Nothing in `src/surfaces/**` holds authority, storage, business rules, or
  ambient browser access; the depcruise `surfaces-are-authority-free` rule +
  the Node-DOM-free lane keep it that way without review effort.
- Follow-ups are milestone-owned: global command key + popup (ADR-022),
  in-page overlay on host-permission grant, favicon tier (letter tile is the
  v1 placeholder), and the E5 browser-adapters work the surfaces are now
  wired to consume.
