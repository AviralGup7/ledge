# Playbook: Search (Blueprint §9 row 8)

**Truth law:** freshness-fallback is a correctness contract, not a consolation
prize — a lagging index answers from read models and says so (EES §2.11).

## Detect

- `search index freshness` probe row: `{lag, dirty, tokenizerV}` — tokenizerV
  skew ⇒ rebuild class, not lag class.
- Overlay/quiet search note honestly flagging the fallback sweep.

## Confirm

- Health card: freshness row fields; a large lag with dirty=false points at
  projector stalls (see [projections.md](projections.md)); dirty=true ⇒ the
  index itself is marked for rebuild.

## Act

- Nothing manual: queries route keyword-on-readmodels automatically; the
  background resumable rebuild drains the backlog (ADR-015 maintenance lane).
- Interactive path NEVER waits on the index: §7.1 p95 includes the fallback.

## Repair

- Persistent dirty after two boots: the rebuild keeps faulting — capture the
  rebuild row + tokenizerV; suspect a pathological corpus token (property
  goldens cover CJK bigram class; extend if the failing token is new).
- Rebuild-with-checkpoints over a 200k corpus must stay inside the §7.3 soak
  window — if not, that is a perf regression (E7-T02 harness row, not this
  page's patient).

## Drill

- Witnesses: `src/infrastructure/search/search.adapter.test.ts`
  (freshness-merged ranked∪sweep), `src/infrastructure/search/tokenizer.test.ts`,
  recall goldens in `ops/tests/contract/`.
