# E8-T10 · Conclude flow + outcome notes — decision record

Milestone: EPIC E8 (INTELLIGENCE), tenth work package. Roadmap row: "E8-T10
Conclude flow + outcome notes | W12 with note + badge | E4-T06 | S | conclude
UI | Archive badge + export includes notes". Frozen anchors: Spec §38/§70
("concluded = flag + optional outcome note on an ARCHIVED mission, not a
fourth state"; "outcome notes become the richest retrieval material in the
entire archive"), W12 (the gesture), §214 (export includes notes), EES C14
(conclude implies archived), ADR-045/export covenant. Completion evidence:
`ops/tests/unit/application/conclude-notes.test.ts` (D/E series), the W12
quiet-page flows, the regenerated covenant examples in
`docs/export-format-v1.md`.

No design forks escalated: the row's criterion IS the design law. Rulings
pin persistence and reach, which the row left open.

## C-series rulings

**C1 · The gesture is ONE command — zero wire drift.** W12's
"archive-and-conclude (add outcome note, optional)" rides the SAME frozen
`ConcludeMission` row (payload already declared `'outcomeNote?': { text: {
maxLength: 2000 } }`). The surface never opens a second path; the domain's
C14 chain (`MissionConcluded` + `MissionArchived`) stays the only semantics.

**C2 · The projector persists the note WITH the flag; a note-less
re-conclude preserves.** MissionConcluded patches `{concluded, outcomeNote?}`
atomically. A conclude carrying no note key is never a wipe — correction
(§6.8's "correction on an outcome note reframes it") always arrives WITH a
note. Prior truth survives absent-mindedly repeated gestures.

**C3 · Absent-key law end to end.** Row → `MissionView.outcomeNote?` →
surface model → export model: every hop is absent-key, never null, never
whitespace-empty (`exactOptionalPropertyTypes` all the way; D1 pins it).

**C4 · The badge IS the note, verbatim, on every card surface.** The
`chip-outcome` renders user-authored data (no copy key — memory jogs where
it was hardest to earn); the quiet Archive and the guardian's archive-facing
cards both bind it. Verbatim is the whole point: retrieval material is the
user's own words.

**C5 · The UI is a note lane on the mission detail — no modal, no second
surface.** Conclude swaps detail content for the lane (house confirm idiom);
blank ⇒ note-less conclude; cancel sends NOTHING (closure never sneaks);
the lane feeds one command (W12-1/W12-2 pin both).

**C6 · Export carries the note in ALL THREE formats — additive, no V bump.**
Canonical model gains optional `outcomeNote` (§2.2 row added); MD renders a
notes-style `**Outcome:**` annotation, HTML a marked `.outcome` paragraph,
JSON the verbatim key. Covenant fixture mission became concluded+noted so
the examples PIN the note; covenant regenerated in the same commit (§9
discipline). `formatV` stays 1: optional keys are the format's own
minor-update law (§431 tolerance).

**C7 · The note rides the escaping law.** MD bracket/backslash/newline
flattening, HTML entity escaping, JSON verbatim-key: a hostile note cannot
fabricate structure in any renderer (E3 hostile fixture pins all three).

## Boundaries explicitly NOT taken

- No AI-drafted outcome notes (a note is user-authored memory; §6.8 puts
  inferred thesis BELOW it, always).
- No note editing lane separate from re-conclude (correction = conclude
  again with the new note — one path, append-only journal tells the story).
- No summary-text plumbing in this row (T04's artifact text joins export
  with its own covenant amendment when the artifact projection matures).
- No format-V bump, no new export document shape.
