# Playbook: Exporters (Blueprint §9 row 10)

**Truth law:** verify-then-present — never a silent partial (Spec). A failed
export must be more honest than a successful one.

## Detect

- Chunk checksum mismatch in the stream; IDB read error mid-stream mapped
  typed; renderer stage check failures.

## Confirm

- Retry once (chunk governance ×2 is automatic; a manual retry covers a third
  class). Same chunk-id family failing ⇒ source truth row suspicion (a single
  hostile record); failing at random positions ⇒ IO layer.

## Act

- Chunk-level: regenerate is automatic; surface shows one calm line with the
  retry path (the user never sees a spinner die).
- Stream-level: abort + honest report of what was NOT exported — counts named.

## Repair

- Hostile record class: find the record by the chunk's id family, fix the
  renderer's hostile-input posture (safe-text law), seed the regression first.
- Post-export verification by round-trip: re-import the artifact against the
  fixture law — divergence is a renderer defect, byte-class.

## Drill

- Witnesses: portability rows in `ops/tests/unit/application/`, export-format
  covenant `docs/export-format-v1.md` (examples validated), stream bench in
  `ops/perf/scenarios/export.ts`.
