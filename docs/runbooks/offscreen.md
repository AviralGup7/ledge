# Playbook: Offscreen workroom (Blueprint §9 row 6)

**V1 posture:** the workroom exists as the capability-resolved host (spawn,
liveness probe, message lattice); AI _jobs/artifacts_ are the v1.1 register.
Interactive-grade work never depends on the offscreen document in v1.

## Detect

- `offscreen spawn success-rate` probe row (unwired ⇒ grey, v1.1 wiring).
- EnsureWorkroom probe timeouts; lease-expiry heartbeats in the workroom lane.

## Confirm

- chrome://extensions → offscreen document presence; spawn reasons in the
  workroom liveness protocol (roots tests pin the contract).

## Act

- Spawn failure: classify reason (browser policy vs our request); interactive
  tiers proceed in SW — fail-open cosmetic law; v1.1 lanes collapse to
  heuristic (Principle 29).
- Killed mid-job (live since E8-T01): the lane deadline abandons the attempt
  (JobCancel best-effort), the lease expires (2 missed beats), reclaim is
  idempotent; retry ×2 then the forced-heuristic lane-fallback; the exactly-once
  artifact law is the completion check — chaos C2/C3 + unit S8 are the green
  witnesses.

## Repair

- Respawn with capability-resolved reasons (never a blind retry loop);
  structured spawn failures are facts the probe carries, not banners.

## Drill

- Witnesses: workroom liveness rows in `src/roots/roots.test.ts`
  (EnsureWorkroom contract, dispatch totality, direction law) plus the E8-T01
  §3.6 executor rows R1..R5 (offer⇒claim/beats/result, hostile-offer totality).
- The offscreen-kill exactly-once drill is shipped evidence, not a future row:
  unit S8 (`ai-jobs-service.test.ts`) + chaos C2/C3
  (`ops/tests/chaos/ai-queue-kills.chaos.test.ts`).
