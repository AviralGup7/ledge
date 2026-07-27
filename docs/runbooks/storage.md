# Playbook: Storage / IDB (Blueprint §9 row 3)

**Truth law:** quota posture is observability, not shame; corruption routes to
checkpoint-restore, writes gate calmly, rescue offers export before surgery.

## Detect

- `storage quota % + persistence` probe row (health card): ≥80% pressure ratio
  ⇒ warn; estimate API absent ⇒ honest `warn` (never faked numbers).
- E_QUOTA / E_CORRUPT_STORE mapped errors from the txn layer.
- Migration assertion failure on open (post-build-update boot).

## Confirm

- Quiet page → rescue → probe run: quota row detail fields; persistence flag.
- Bundle: storage block `{persisted, apiAvailable}`.

## Act

- Quota pressure: standby posture already active (§5 law 6) — inform via the
  quiet-page notice; ask the user to archive/conclude finished missions; offer
  the export before any sweep (Trash is the reclaim path, never a first move).
- Migration failure: checkpoint restore is automatic and blocks writes — do
  NOT retry the migration by hand; rescue console offers the export bundle,
  then a re-open attempts the gated path again.

## Repair

- Corrupt store row: E_CORRUPT_STORE is integrity-tagged — the store is
  rebuilt from journal truth (projections are disposable); the mission/tab
  truth rows are never hand-edited.
- Persistent quota on a small profile: suspect standing-footprint drift —
  compare `persisted` vs estimate; compaction runbook follows.

## Drill

- Witnesses: §5 law-6 boot rows in `src/roots/roots.test.ts`,
  `ops/tests/contract/storage-engine.dexie.test.ts`,
  `ops/fixtures/migrations/` goldens, memory-engine twin
  `ops/tests/contract/storage-engine.memory.test.ts`.
