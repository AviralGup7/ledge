# E3-T03 · NativeSessions adapter — decision record

Roadmap row: "NativeSessions adapter | Recovery cross-check reads (read-only law) |
E3-T01 | S | E6 | chrome/nativesessions | Contract suite; gap-degrade logged".
State: **shipped** (single package, sizes as roadmapped).

---

## Q1 — surface shape: how much of chrome.sessions does Ledge touch?

**Decision:** the smallest lawful read surface. The port
(`src/application/ports/sessions.port.ts` — `NativeSessionsPort`) carries exactly
ONE method, `recentlyClosedTabs(): Result<readonly RecentlyClosedTab[]>`; the
api-surface (`ChromeSessionsApi`) types only `getRecentlyClosed`. **READ-ONLY
LAW** per the roadmap row: `restore`/`getDevices` are deliberately absent from the
surface, so no code path can let the platform mutate session state on our behalf —
restoration stays Ledge-driven through the intent ledger (E6-T01's put-back),
never native-pass-through.

**Why:** the consumer seam already existed — the E2-T07 reconciler's optional
`crossCheck: () => Promise<Result<readonly string[], LedgeError>>` (EES §2.13
step 5). The adapter is the production binding for that seam, URL-projected at the
root (`sessionsCrossCheck` in `bg-root.ts`). Widening the surface before its
consumer exists would be speculative generality.

## Q2 — candidate shape and normalization?

**Decision:** `RecentlyClosedTab = { url, title }`. Tab-shaped sessions map 1:1;
window-shaped sessions FAN OUT per member tab (the cross-check matches URLs, and a
closed window is a bag of tab candidates). Rows with an unreadable/absent `url`
are dropped at the adapter boundary — unmatchable candidates are noise, not
evidence. Session order is chrome's (most-recent first), never rearranged.
Platform ceiling mirrored: `RECENTLY_CLOSED_CAP = 25` passed as `maxResults`
(window fan-out may exceed it by membership — chrome-bounded).

## Q3 — failure and absence law?

**Decision:** one typed failure class: `E_CAPABILITY_API` (via `error-map`),
produced both by API absence (chrome-less hosts — the lazy ambient binding answers
the typed error, never a throw) and by raw rejections. The reconciler's existing
law then holds: seam err ⇒ `crossCheck: 'degraded-unavailable'` + logged gap
(`cross-check:<code>`), loss-risk unchanged. The WP6 tests that assert the
sanctioned absence-token (`sessions-crosscheck-unavailable`) exercise the
seam-absent path and are untouched; production now binds the seam, so the token
retires for real boots — which the real-restart e2e proves (scenario A's card now
shows exactly ONE disclosure note, the deferred intent; both degraded-class notes
are gone).

## Q4 — proof ladder?

- **Contract suite** (ADR-032 parametric, 7 laws): tab order, window fan-out,
  url-less drop, empty-backlog ok, 25-cap, capability rejection, read-only surface
  (`sessions-port.contract.ts` + fake binding 7/7 green; chrome-lane stub runs in
  browser CI per the E3-T01 pattern).
- **Fake** (`fake-chrome.ts`): `sessions` seam + `seedRecentlyClosed` /
  `sabotageSessionsNext` hooks, mirroring the storage sabotage discipline.
- **Wiring:** `RecoveryBootPorts.crossCheck` seam with the production default;
  composition tests keep their factories untouched (unit 815/815 unchanged).
- **Real browser:** e2e lane rerun post-wiring — 2/2 green (the cross-check runs
  against a real Chromium's real `chrome.sessions` on every boot act).

## Follow-ups

- **E6-T02** (next): the cross-check panel UI consumes the same port reads for
  confirm-before-restore review; `crossCheck: 'applied'` boots stop emitting the
  `crosscheck-degraded` disclosure token, which the DTO already tolerates.
- Candidates currently fit the reconciler's `readonly string[]` face; if the panel
  needs titles at review time, the DTO projection widens additively (no port
  change — `title` is already carried).
