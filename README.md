# Ledge
**Never lose a thought.** An AI-powered tab & session manager — park without loss, resume with context, find anything. Local-first, private, MV3-native.

> Pre-production scaffold (M0). Governing documents are LOCKED and live in `docs/governance/` — read them before writing code:
> Vision → Spec → ADR → Blueprint → Execution Spec → Roadmap → **Constitution (read this one twice)**.

## Prerequisites
- Node.js ≥ 22 (`.nvmrc` — `nvm use`)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Google Chrome stable (dev) + Chrome Beta (beta lane)
- GitHub CLI `gh` (repo automation scripts)

## 30-minute onboarding (the law, §9)
```bash
git clone https://github.com/AviralGup7/ledge.git && cd ledge
corepack enable && pnpm install          # wxt prepare runs automatically
pnpm dev                                 # hot-reload dev mode → chrome://extensions → load .output/chrome-mv3-dev
pnpm ci:all                              # the full local gate — must be green before every PR
```
If step-by-step takes >30 minutes on a clean machine, the README failed — file `type:bug`.

## Commands
| Command | Purpose |
|---|---|
| `pnpm dev` / `build` / `zip` | WXT dev server / production build / store artifact |
| `pnpm ci:all` | The complete local gate (format, eslint, typecheck, dep-law, copy-law, tests, build, bundle budgets, egress guard, dep policy) |
| `pnpm test` / `test:property` | Unit suite / property suites (FC_NUM_RUNS seeds, 1000 default) |
| `pnpm check:deps` | Import law (Blueprint §4) — violations are merge-blockers |
| `pnpm check:egress` | A-10: network allowlist is empty. Keep it empty. |
| `node scripts/gh-setup.mjs` | One-time: labels + milestones + branch-protection instructions |
| `node scripts/import-issues.mjs` | Import 86 roadmap tasks as GitHub issues |

## Debug workflow
- **Service worker:** chrome://extensions → Ledge → "service worker" link. SW is stateless by design (ADR-007) — you can kill it any time; the truth must not notice.
- **Offscreen workroom:** chrome://extensions → Ledge → "offscreen document".
- **Quiet page:** open via action menu or `chrome-extension://<id>/quiet-page.html`.
- **Chaos (from M1):** force faults via `ops/chaos/points.txt` driver — or induce a real crash at `chrome://inducebrowsercrashforrealz`.

## The three questions every PR answers
1. Does anything here touch user truth? → chaos points enumerated (T-04).
2. Does anything here cross a boundary? → contracts updated (§9 doc gate).
3. Does anything here leave the device? → it must not (A-10).

**Private repository. UNLICENSED. The only public covenant is the export format spec (docs/governance, A-13).**
