# Accessibility checklist — EES §7.4 zero-defect program (E7-T03)

**Target:** WCAG 2.2 AA. **Ground law (Spec §5.13):** a product built to reduce anxiety
must be operable while anxious — keyboard-reachable, screen-reader-labeled, calm under
every platform a11y switch. **Method (F1 ruling):** hand-rolled, dependency-free
invariants — the dependency diet (EES §7.5) is itself a release gate. **Lane (F2
ruling):** `ops/tests/a11y/**` rides the unit project — the gate is mandatory on every
`pnpm test`; the pre-existing mounted-tree invariants live in
`ops/tests/unit/surfaces/a11y.test.ts`. **Scope (F3 ruling):** remediation lands with
the suite (surface-law attributes + CSS mode blocks, no architectural change).

Legend for "proof": **auto** = executable in the unit lane; **manual** = protocol row
(run the named build + procedure; sign in the milestone review).

---

## Clause matrix — every surface, every §7.4 clause

| §7.4 clause                                 | guardian                                                                                  | overlay                                                                       | quiet-page                                                   | proof                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1. Full keyboard operability                | buttons native; `u`/`ctrl+z`/`meta+z` undo; `r` refresh                                   | combobox arrows/enter/escape; clamps; enter-with-no-selection activates first | buttons native; `u`/`ctrl+z`/`meta+z` undo                   | **auto** `ops/tests/a11y/keyboard.test.ts`                                       |
| 2. Screen-reader labels + live regions      | labelled sections; one polite region; role=alert on errors                                | dialog + combobox + listbox + aria-controls reciprocal; aria-activedescendant | nav landmark labelled; one polite region; labels/for resolve | **auto** `ops/tests/unit/surfaces/a11y.test.ts`                                  |
| 3. Heartbeat announced politely             | role=status pill; honest zero-state copy                                                  | — (not a heartbeat venue)                                                     | —                                                            | **auto** `ops/tests/a11y/heartbeat.test.ts`                                      |
| 4. 200% zoom, zero function loss            | rem layout, no px traps                                                                   | rem layout, no px traps                                                       | rem layout, no px traps                                      | **auto** `ops/tests/a11y/contrast-zoom.test.ts` + **manual** zoom protocol below |
| 5. Honor OS reduce-motion                   | `@media (prefers-reduced-motion: reduce)` kills animation/transition sheet-wide           | same sheet                                                                    | same sheet                                                   | **auto** `ops/tests/unit/surfaces/a11y.test.ts` (motion rows)                    |
| 6. Interactive targets ≥44px                | `.btn` class on every button; CSS 44px floor                                              | palette options ≥44px row boxes                                               | `.btn` on every button                                       | **auto** `ops/tests/unit/surfaces/a11y.test.ts` (44px rows)                      |
| 7. High-contrast mode (Spec §4.5 P0)        | `prefers-contrast: more` thickens borders/focus; `forced-colors` defers to system palette | same sheet                                                                    | same sheet                                                   | **auto** `ops/tests/a11y/contrast-zoom.test.ts` + **manual** HC protocol below   |
| 8. Calm copy (no urgency/shame/exclamation) | copy-lint wordlist                                                                        | copy-lint wordlist                                                            | copy-lint wordlist                                           | **auto** `pnpm check:copy` (pre-existing gate)                                   |
| 9. Focus visible                            | `:focus-visible` ring on the shared sheet                                                 | same sheet                                                                    | same sheet                                                   | **auto** `ops/tests/a11y/contrast-zoom.test.ts`                                  |
| 10. No positive tabindex traps              | asserted sheet-wide on the mounted tree                                                   | asserted                                                                      | asserted                                                     | **auto** `ops/tests/unit/surfaces/a11y.test.ts`                                  |
| 11. Document language + title + fallback    | `lang="en"`, `<title>`, `<noscript>`                                                      | same                                                                          | same                                                         | **auto** `ops/tests/a11y/contrast-zoom.test.ts` (shell rows)                     |

---

## Manual protocol rows (what code cannot prove)

**M-ZOOM — 200% zoom integrity (EES §7.4 row 4)**

1. Build (`pnpm build`), load the extension on a clean profile, set browser zoom to
   200% on each surface.
2. Every workflow stays operable: park from guardian, search in overlay, navigate
   quiet sections, complete a rescue scan, confirm/dismiss dialogs. No horizontal
   scroll traps; no clipped buttons; text wraps mid-word only on genuinely
   unbreakable tokens (URLs).
3. Sign-off: record surface × pass/fail in the milestone review notes; a defect
   lands as a seed regression test before the fix (E7-T04 discipline).

**M-CONTRAST — forced-colors / high-contrast (EES §7.4 row 7)**

1. Windows High-Contrast (e.g. Aquatic/Desert) or OS "increase contrast": reload
   each surface.
2. Every interactive control keeps a visible boundary; focus ring unmistakable;
   pressed state (toggled chips, primary actions) distinguishable; no content
   painted over by the system palette.
3. Sign-off as above; defects seed before fix.

**M-SR — screen-reader sweep (WCAG 2.2 AA SR coverage)**

1. One pass with any two of {NVDA, VoiceOver, TalkBack} on the four golden
   workflows (W2 park, W6 reflex search, W4 heartbeat read, rescue-console scan).
2. Expectations: landmarks announced; result counts change announced politely;
   heartbeat safe/quiet states announced; no silent state changes.
3. Sign-off as above; defects seed before fix.

---

## Zero-defect operating law

- The **auto** rows are release **gates**, not suggestions: a red a11y test blocks
  like any unit red. New interactive code must not land behind a skipped or
  weakened assertion.
- New surfaces join this matrix in the same PR that introduces the surface
  (rows + executable proofs + manual rows where the surface adds a modality).
- Manual protocol rows run at every milestone gate that touches a surface
  (E4 gates onward); the sign-off record lives in the milestone review notes.
- Copy posture is double-gated: `check:copy` (lexicon) and the live-region/
  alert tests (announcement semantics).
