# Ledge

**Never lose a thought.** An AI-powered tab & session manager — park without loss, resume with context, find anything. Local-first, private, MV3-native.

> v1 vertical is built and gated (EPICs E1–E6 shipped; E7 reliability ops in flight — see `docs/governance/ledge-implementation-roadmap.md`). Governing documents are LOCKED and live in `docs/governance/` — read them before writing code:
> Vision → Spec → ADR → Blueprint → Execution Spec → Roadmap → **Constitution (read this one twice)**.

## The documents map (30 minutes well spent)

| Where                             | What                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `docs/governance/`                | The seven locked documents (append-only canon)                                      |
| `docs/degradation-matrix.md`      | What the product does when every dependency misbehaves (witness-pinned)             |
| `docs/threat-model.md`            | Boundaries, attacker classes, mitigations, §7.5 gate census                         |
| `docs/runbooks/`                  | One failure playbook per Blueprint §9 row (detect → confirm → act → repair → drill) |
| `docs/accessibility-checklist.md` | §7.4 zero-defect program — clause × surface matrix + manual protocols               |
| `seeds/README.md`                 | Regression seed corpus — every defect lands a failing test first (T-01 gate)        |
| `ops/fixtures/FIXTURES.md`        | Import-corpus attribution log (privacy-clean, byte-honest)                          |
| `docs/adr-notes/`                 | Per-milestone decision records (fork rulings with refinements)                      |

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

| Command                          | Purpose                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev` / `build` / `zip`     | WXT dev server / production build / store artifact                                                                             |
| `pnpm ci:all`                    | The complete local gate (format, eslint, typecheck, dep-law, copy-law, tests, build, bundle budgets, egress guard, dep policy) |
| `pnpm test` / `test:property`    | Unit suite / property suites (FC_NUM_RUNS seeds, 1000 default)                                                                 |
| `pnpm test:contract`             | Port contract suites (ADR-032) — identical law set runs against every adapter                                                  |
| `pnpm test:security`             | Boundary-validator fuzz + injection firewalls (EES §8; FC_NUM_RUNS volume)                                                     |
| `pnpm check:deps`                | Import law (Blueprint §4) — violations are merge-blockers                                                                      |
| `pnpm check:egress`              | A-10: network allowlist is empty. Keep it empty. (scans http/https/wss/ftp + protocol-relative)                                |
| `pnpm check:manifest`            | ADR-022: built manifest must equal the signed baseline (`ops/ci/manifest-baseline.json`)                                       |
| `node scripts/gh-setup.mjs`      | One-time: labels + milestones + branch-protection instructions                                                                 |
| `node scripts/import-issues.mjs` | Import 86 roadmap tasks as GitHub issues                                                                                       |

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
