# Beta-channel soak — lane + monthly manual matrix (E7-T06)

**Roadmap row:** "Chrome beta-channel soak | Beta-channel CI lane + monthly
manual matrix | E1-T13 | S (ongoing) | ci lane | Beta job red ⇒ named owner
within 48h". **Why beta:** Chrome beta ships ~4–6 weeks ahead of stable — it
is the cheapest possible early-warning for platform drift in exactly the APIs
Ledge's truth engine rides (tabs/windows/sessions/storage areas).

## The lane (mechanical soak)

`.github/workflows/beta-soak.yml` — **weekly Monday 06:00 UTC** + manual
`workflow_dispatch`.

1. Installs Chrome **beta** via the house browser bin (@puppeteer/browsers,
   pinned in the dev dependency set from E1 — zero new supply-chain surface,
   §7.5 dependency diet holds).
2. Runs the full e2e project against that binary through the e2e lane's
   `LEDGE_CHROME` executable seam (`pnpm test:e2e`) — real browser, real
   SIGKILL/relaunch recovery flow, real SW. The lane is declared long-running;
   it never joins PR gates.
3. **Red ⇒ 48h owner rule (mechanical):** on failure the lane files a GitHub
   issue assigned to **@AviralGup7** with run links and first moves. Owner
   investigates within **48h** of the red — classify as (a) our drift, (b)
   beta-channel platform drift, (c) flake. Outcomes: our drift → seed-corpus
   graft first (E7-T04 ritual), then fix; platform drift → capability-detect
   - degrade law (see `docs/runbooks/chrome-adapters.md`), never a revert of
     truth law; flake → harden or mark the flake class honestly.

Full **chrome-reference contract suites** (`ops/tests/contract/*.chrome.test
.ts`) bind their drive hooks _in-lane_ — until those hooks land (E3 residual),
the lane's browser evidence is the e2e soak; this is the honest current state,
not a gap to paper over.

## Monthly manual matrix (human pass, first week of the month)

CI catches crashes; humans catch _awkwardness_. Once a month on a local
Chrome **beta** profile with the current build (`pnpm build`, load unpacked):

| flow             | what to walk                                                  | pass law                                             |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| W1 first run     | clean profile → onboarding → first park feels calm            | no stutter in first paint; heartbeat settles         |
| W2 park+resume   | 30-tab window → park → resume next day                        | all tabs back, order kept, no dupes                  |
| W6 reflex search | overlay search across a busy profile                          | p95 feels instant; fallback note honest when lagging |
| W7 recovery      | real crash (`chrome://inducebrowsercrashforrealz`) → relaunch | card ONLY on loss-risk; cross-check panel lawful     |
| rescue console   | quiet page → probes → tail scan → export bundle               | probes honest (unwired grey), bundle redacted        |

Sign-off row per month — append, never edit history:

| month   | owner      | beta build | W1  | W2  | W6  | W7  | rescue | notes              |
| ------- | ---------- | ---------- | --- | --- | --- | --- | ------ | ------------------ |
| 2026-08 | AviralGup7 | _fill_     | ☐   | ☐   | ☐   | ☐   | ☐      | _initial baseline_ |

## Cadence archaeology

- Weekly CI soak: broad regression net, zero human attention until red.
- Monthly human matrix: awkwardness net, ~30 minutes, sign-off row.
- Release: beta soak green is part of the release-gate story (EES §8
  release-gating lanes); a red at release time triggers the 48h rule,
  upgraded to release-blocking until classified.
