#!/usr/bin/env node
// E8-T02 · ADR-041 module isolation + R7/R18 confidence-gate lint. [CI]
// The spec's action bar (§6.12) is structurally impossible only if enforcement is
// mechanical — this gate scans SOURCE, not intentions:
//
//   G1 AI ISOLATION (ADR-041): files under src/infrastructure/ai/** and
//      src/domain/memory/** must not import mutation-capable portraits
//      (tabs/windows/tab-groups ports, infrastructure/chrome verb adapters,
//      the journal append path, surfaces/entrypoints/roots) and must not touch
//      the ambient `chrome` object. The OffscreenPort (own sandbox lifecycle)
//      and StorageEnginePort scoped to ai_jobs (E8-T01 F1) are sanctioned.
//   G2 TIER OWNERSHIP (R18): outside src/domain/memory/**, no source may wield
//      the raw cutoffs (CONFIDENCE_TIER_HIGH_AT/MEDIUM_AT) or compare a
//      `confidence` value against a number — surfaces and application bind the
//      Memory layer's pre-mapped tier/presentation, never threshold logic.
//   G3 R7 CONSTANTS PIN: domain/memory/confidence.ts declares exactly the R7
//      contract constants (HIGH 0.85 · MEDIUM 0.60). Tunable until Tier-3
//      freeze; a change requires an ADR note AND this pin's update.
//
//   FIXTURE LAW (the row's completion criterion — "mutation-symbol import
//   impossible, fixture fails"): ops/fixtures/lint/*.fixture.ts files carry a
//   `// lint-fixture: <virtual src path>` header and are evaluated with the SAME
//   rules; every fixture MUST produce at least one finding. A clean fixture
//   means the gate is toothless and this script fails.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = 'src';
const FIXTURE_DIR = 'ops/fixtures/lint';
const AI_SCOPE = /^(?:src\/)?(?:infrastructure\/ai|domain\/memory)\//;
const TEST_FILE = /\.(?:test|property\.test|chaos\.test|contract\.test)\.ts$/;

// G1 · mutation-capable imports, banned inside the AI isolation scope.
const FORBIDDEN_PATH = [
  { re: /@\/application\/ports\/(?:tabs|windows|tab-groups)\.port/, what: 'mutation port' },
  { re: /@\/infrastructure\/chrome\//, what: 'browser-verb adapter' },
  { re: /@\/infrastructure\/journal\//, what: 'journal append path' },
  { re: /@\/(?:surfaces|roots)\//, what: 'egress/composition layer' },
  { re: /(?:^|\/)\.wxt\//, what: 'generated platform layer' },
];
const FORBIDDEN_SYMBOL = /\b(?:TabsPort|WindowsPort|TabGroupsPort)\b/u;
const AMBIENT_CHROME = /\bchrome\s*\.\s*[a-zA-Z]/u;

// G2 · tier-ownership bans (outside src/domain/memory, tests exempt — they PIN laws).
const RAW_CUTOFF_IMPORT = /\bCONFIDENCE_TIER_(?:HIGH|MEDIUM)_AT\b/u;
const CONFIDENCE_THRESHOLD = /\bconfidence\s*(?:[<>]=?|===?|!==?)\s*-?\d/u;

// G3 · R7 contract constants (frozen values; the pin is the docs-visible tripwire).
const R7_HIGH = 0.85;
const R7_MEDIUM = 0.6;
const CONFIDENCE_FILE = 'src/domain/memory/confidence.ts';

const IMPORT_LINE = /^\s*import[^'"]*from\s*['"]([^'"]+)['"]/gm;

/** Law-stating prose ("never touches chrome.runtime") is documentation, not
 *  violation: blank full-line and block comments before scanning. Strings stay
 *  intact (trailing comments are deliberately kept — masking beats mangling). */
const stripLawProse = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length));

/** Evaluate every rule against one file's text; returns findings (path-tagged). */
const evaluate = (virtualPath, rawText) => {
  const text = stripLawProse(rawText);
  const findings = [];
  const inAiScope = AI_SCOPE.test(virtualPath);
  const isTest = TEST_FILE.test(virtualPath) || virtualPath.includes('/testing/');
  const inMemoryDomain = /^(?:src\/)?domain\/memory\//.test(virtualPath);

  if (inAiScope && !isTest) {
    for (const m of text.matchAll(IMPORT_LINE)) {
      const spec = m[1] ?? '';
      for (const rule of FORBIDDEN_PATH) {
        if (rule.re.test(spec)) {
          findings.push(`G1: imports ${rule.what} "${spec}" (ADR-041 isolation)`);
        }
      }
    }
    for (const m of text.matchAll(IMPORT_LINE)) {
      if (FORBIDDEN_SYMBOL.test(m[0])) {
        findings.push(
          `G1: imports a mutation-port symbol by name (ADR-041: TabsPort.close* et al.)`,
        );
      }
    }
    if (AMBIENT_CHROME.test(text)) {
      findings.push('G1: touches ambient `chrome` (browser verbs are unreachable by law)');
    }
  }

  if (!inMemoryDomain && !isTest) {
    for (const m of text.matchAll(IMPORT_LINE)) {
      if (RAW_CUTOFF_IMPORT.test(m[0])) {
        findings.push(
          'G2: imports raw tier cutoffs — R18: only domain/memory wields numeric thresholds',
        );
      }
    }
    if (CONFIDENCE_THRESHOLD.test(text)) {
      findings.push(
        'G2: numeric confidence thresholding outside domain/memory — R18 single-source law (consume the pre-mapped tier/presentation)',
      );
    }
  }
  return findings;
};

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};

const violations = [];

// ── Main scan: every src file is clean. ──────────────────────────────────────
for (const file of walk(SRC)) {
  const vpath = relative('.', file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  for (const finding of evaluate(vpath, text)) violations.push(`${vpath}: ${finding}`);
}

// ── G3 · R7 constants pin. ───────────────────────────────────────────────────
const confidenceText = readFileSync(CONFIDENCE_FILE, 'utf8');
const pin = (name) => {
  const m = confidenceText.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)`));
  return m === null ? null : Number(m[1]);
};
const high = pin('CONFIDENCE_TIER_HIGH_AT');
const medium = pin('CONFIDENCE_TIER_MEDIUM_AT');
if (high !== R7_HIGH || medium !== R7_MEDIUM) {
  violations.push(
    `${CONFIDENCE_FILE}: G3 R7 constants drifted (HIGH=${String(high)}, MEDIUM=${String(
      medium,
    )}; law is ${R7_HIGH}/${R7_MEDIUM}) — R7: tunable until Tier-3 freeze, change requires an ADR note AND this pin`,
  );
}

// ── Fixture law: planted violations MUST be caught. ─────────────────────────
let fixtures = [];
try {
  fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.fixture.ts'));
} catch {
  violations.push(`${FIXTURE_DIR}: fixture directory missing — the gate cannot prove itself`);
}
for (const fixture of fixtures) {
  const path = join(FIXTURE_DIR, fixture);
  const text = readFileSync(path, 'utf8');
  const header = text.match(/^\/\/ lint-fixture:\s*(\S+)/m);
  if (header === null) {
    violations.push(`${path}: fixture lacks the "// lint-fixture: <virtual path>" header`);
    continue;
  }
  const virtualPath = header[1] ?? '';
  const caught = evaluate(virtualPath, text);
  if (caught.length === 0) {
    violations.push(
      `${path}: FIXTURE NOT CAUGHT at ${virtualPath} — the isolation gate is toothless (completion law: the fixture fails)`,
    );
  } else {
    console.info(`  fixture ok — ${fixture} caught: ${caught.length} finding(s)`);
  }
}

if (violations.length > 0) {
  console.error(`ISOLATION LINT VIOLATION (ADR-041 / R7 / R18):\n${violations.join('\n')}`);
  process.exit(1);
}
console.info(
  `isolation-lint: ADR-041 isolation + R18 tier ownership hold; R7 constants pinned (${R7_HIGH}/${R7_MEDIUM}); ${fixtures.length} hostile fixture(s) provably caught.`,
);
