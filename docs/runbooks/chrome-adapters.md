# Playbook: Chrome adapters (Blueprint §9 row 5)

**Truth law:** the browser is the only authority on browser state; APIs race,
and Ledge loses races gracefully.

## Detect

- Typed adapter errors on gestures (E_CAPABILITY class on restore/snapshot);
  precondition re-reads in executor logs; cross-check gap rows on recovery.
- Recovery card with missing candidate row ⇒ `chrome.sessions` degraded.

## Confirm

- Was the browser mid-restart, mid-profile-switch, or on a beta channel?
  Reproduce once; if it reproduces only there, it's channel drift.
- `pnpm test:contract` — adapter contract failures localise the drift fast.

## Act

- Transient (tab closed under us, window raced): ×3 backoff inside the same
  gesture, then skip-and-stitch with a disclosure — never strand an op
  silently.
- Structural (API removed/renamed): ship the degrade — feature-level fallback
  (e.g., group styles become plain tabs with honest copy; cross-check row
  simply absent).

## Repair

- Channel drift: contract suite on the affected channel pins the exact
  method; capability-detect at composition, not at call sites.
- Persistent E_CAPABILITY on stable Chrome: verify permissions baseline
  (`pnpm check:manifest`) before touching adapter code.

## Drill

- Witnesses: `ops/tests/contract/` adapter suites (5 beta-channel skips are
  the honest state), `ops/tests/e2e/recovery-w7.e2e.test.ts` for real-browser
  behavior, `ops/chaos/` IDB fault injection for the storage-adjacent paths.
