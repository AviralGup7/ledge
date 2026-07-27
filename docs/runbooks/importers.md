# Playbook: Importers (Blueprint §9 row 9)

**Truth law:** partial-good + rejects report (Spec W15) below threshold;
atomic abort above threshold. Nothing hostile reaches the model unvalidated.

## Detect

- Preview report: rejects count + classes (quarantine list + report file).
- E_FORMAT_UNKNOWN on detect; E_FILE_GUARD on mega-line/oversize rows.

## Confirm

- Re-pick the file once. Same result ⇒ the file is the problem; the preview's
  reject classes say exactly which grammar class broke.
- Corpus reference: `ops/fixtures/FIXTURES.md` names the 14 hostile classes
  — the wild file usually matches one pinned class.

## Act

- Corrupt rows ≤ threshold: user completes the import; rejects file links the
  quarantined rows with reasons (calm, specific).
- > threshold corrupt / unknown format: atomic abort already happened —
  > explain calmly; offer the supported-format doc; never coerce.

## Repair

- Grammar drift class (a real tool changed its export shape): ADR note
  (`docs/adr-notes/e7-fixture-corpus.md` §2) — corpus + parser fix land in the
  same PR, hostile fixture first (E7-T04 ritual).
- Bytes-stage unwired host: imports needing the shelf refuse honestly;
  moving the file through the extension page restores the path.

## Drill

- Witnesses: `src/infrastructure/importers/parsers.test.ts`,
  `src/infrastructure/importers/corpus.test.ts`,
  `src/infrastructure/importers/bytes-stage.test.ts`, hostile corpus + the
  byte-honesty tripwire `ops/tests/unit/fixtures/corpus-privacy.test.ts`.
