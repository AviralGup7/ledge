# Playbook: Projections (Blueprint §9 row 4)

**Truth law:** read models are disposable; the journal is truth. Dirty is a
state, never an error page.

## Detect

- `projection watermark lag` probe row: dirty views + lag count.
- Staleness chips on surfaces (they are the probe's public face).

## Confirm

- Health card probe run: which views, lag size, watermark vs journal head.
- Sudden total divergence (all views, giant lag) after an update ⇒ registry
  growth mishap (new view seeded at watermark 0 — lawful, will catch up →
  watch one boot cycle first).

## Act

- Automatic path: chunked resumable rebuild (background). Interactive need:
  the rescue console `rebuild` action targets a view exactly.
- Projector throw class ⇒ engine marks view dirty + logs; nothing else halts.

## Repair

- Repeated throw on the same view family: capture the journal range from the
  watermark + the projector name; file as seed-corpus candidate — likely a
  hostile event shape a projector didn't expect (domain-parity class).
- Nuclear-but-lawful: reset watermarks (rescue action) ⇒ full rebuild — read
  models only, zero truth movement.

## Drill

- Witnesses: `src/infrastructure/projections/projections.test.ts` (mirror/twin
  digest determinism), replay-purge property mirror
  `ops/tests/property/replay-purge-law.property.test.ts`,
  seeds SEED-0001/SEED-0002 for the historical classes.
