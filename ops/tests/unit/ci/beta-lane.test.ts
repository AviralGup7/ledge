// E7-T06 · beta-channel soak covenant tripwire — the lane keeps its shape:
// weekly cron + the house browser bin (no new supply chain), LEDGE_CHROME seam
// (never a hardcoded path), the 48h owner rule filed mechanically on red, and
// the monthly manual matrix stays documented with its flows and sign-off law.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LANE = '.github/workflows/beta-soak.yml';
const MATRIX = 'docs/beta-soak-matrix.md';

describe('E7-T06 beta soak · lane shape (tripwire)', () => {
  it('the workflow exists and runs on a weekly soak cadence (+ manual dispatch)', () => {
    expect(existsSync(LANE)).toBe(true);
    const lane = readFileSync(LANE, 'utf8');
    expect(lane).toContain('schedule:');
    expect(lane).toMatch(/cron:\s*'[^']+'/);
    expect(lane).toContain('workflow_dispatch');
  });

  it('beta installs via the house bin — @puppeteer/browsers, no new actions', () => {
    const lane = readFileSync(LANE, 'utf8');
    expect(lane).toContain('browsers install chrome@beta');
    // Supply-chain diet (§7.5): the soak may not bring new third-party actions.
    const uses = [...lane.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    const ALLOWED = new Set([
      'actions/checkout@v4',
      'pnpm/action-setup@v4',
      'actions/setup-node@v4',
    ]);
    for (const use of uses) {
      expect(ALLOWED, `new action in the soak lane violates the diet: ${use}`).toContain(use);
    }
  });

  it('the soak rides the LEDGE_CHROME seam (executable never hardcoded)', () => {
    const lane = readFileSync(LANE, 'utf8');
    expect(lane).toContain('LEDGE_CHROME');
    expect(lane).toContain('pnpm test:e2e');
  });

  it('red ⇒ 48h owner rule is filed mechanically (issue to the named owner)', () => {
    const lane = readFileSync(LANE, 'utf8');
    expect(lane).toContain('if: failure()');
    expect(lane).toContain('gh issue create');
    expect(lane).toContain('--assignee AviralGup7');
    expect(lane).toContain('48h');
  });
});

describe('E7-T06 beta soak · monthly manual matrix (tripwire)', () => {
  it('the matrix doc exists with the flows, the rule, and the sign-off law', () => {
    expect(existsSync(MATRIX)).toBe(true);
    const doc = readFileSync(MATRIX, 'utf8');
    for (const flow of ['W1', 'W2', 'W6', 'W7']) {
      expect(doc, `flow missing: ${flow}`).toContain(flow);
    }
    expect(doc).toContain('48h');
    expect(doc).toContain('AviralGup7');
    expect(doc).toMatch(/monthly/i);
    expect(doc).toContain('rescue console');
  });

  it('the workflow points at the matrix (lane and manual pass are one program)', () => {
    const lane = readFileSync(LANE, 'utf8');
    expect(lane).toContain('docs/beta-soak-matrix.md');
  });
});
