# E7-T06 · Chrome beta-channel soak — decision record

Milestone: EPIC E7 (RELIABILITY OPS), sixth work package. Roadmap row:
"Chrome beta-channel soak | Beta-channel CI lane + monthly manual matrix |
E1-T13 | S (ongoing) | ci lane | Beta job red ⇒ named owner within 48h".
Frozen anchors: EES §8 lane table (soak lanes are nightly/weekly-class, never
PR), subsystem DoD row 7 ("contract suite runnable on beta channel"), EES
§7.5 (dependency diet — the lane must not grow the supply chain), README
prerequisites ("Chrome Beta (beta lane)" — planned since M0).

No forks escalated: every mechanism was already house precedent.

## Decisions

- **Binary source → the house browser bin.** Chrome beta installs via
  `@puppeteer/browsers` (`pnpm exec browsers install chrome@beta`) — the same
  pinned tool + cache path family the local e2e lane discovers. Zero new
  GitHub actions, zero new dependencies: the §7.5 diet holds, and the
  tripwire test hard-forbids new `uses:` entries in the soak workflow.
- **Targeting seam → `LEDGE_CHROME`, untouched.** The e2e harness already
  resolves its executable from this env seam (E6-T01 discovery law: env →
  tmp discovery → noop refuse). The soak sets the env; no code change in the
  lane itself. This is deliberately _not_ a second runner: one e2e project,
  two binaries (stable locally, beta in CI).
- **Cadence → weekly Monday 06:00 UTC + workflow_dispatch.** Beta ships
  roughly weekly; nightly would spend its life downloading browsers. The lane
  is a declared long-running lane, same class as chaos/perf/soak rows in the
  EES §8 table — never in PR gates.
- **48h owner rule → mechanical.** On red the lane files a GitHub issue
  assigned to @AviralGup7 with run links, classification classes (our drift /
  platform drift / flake) and first moves. "Named owner within 48h" is
  thereby enforced by the mechanism, not by goodwill.
- **Monthly manual matrix → `docs/beta-soak-matrix.md`.** CI catches crashes;
  humans catch awkwardness — five golden flows (W1/W2/W6/W7 + rescue console
  smoke) on a local beta profile with an append-only sign-off table.
- **Honest residual named:** the `*.chrome.test.ts` contract suites bind
  their reference-Chrome drive hooks _in-lane_ (E3 residual, by design
  comment in the suites). Until those hooks land, the soak's browser evidence
  is the e2e project; the matrix documents this state rather than faking
  contract coverage.

## Covenant tripwire

`ops/tests/unit/ci/beta-lane.test.ts` (6 proofs, unit lane): cron shape +
manual dispatch; house-bin install + diet allowlist of actions; LEDGE_CHROME
seam (never a hardcoded path); the mechanical 48h issue rule; matrix flows,
rule string, owner, sign-off law; workflow↔matrix cross-link. A lane or doc
edit that weakens the covenant goes red in `pnpm test`.

## Census note

Wire census untouched (30C/9Q/13S/17W/5S). No `src/` change; ops/ci + docs
only.
