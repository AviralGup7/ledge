// E7-T02 · Report emitters — machine-readable JSON (CI artifact + baseline source)
// and a markdown table for humans/CI job summaries. History accumulates out-of-band:
// ops/perf/out/perf-report.json is the artifact; the committed baseline is the anchor.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch } from 'node:os';
import type { ComparisonRow, HostInfo, PerfReport, ScenarioResult } from './types.js';
import { REPORT_SCHEMA_V } from './types.js';

const MB_PER_BYTES = 1_048_576;

export const hostInfo = (): HostInfo => {
  const list = cpus();
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpuModel: list[0]?.model ?? 'unknown',
    cpuCount: list.length,
    totalMemMB: Math.round(totalmem() / MB_PER_BYTES),
  };
};

const TABLE_DECIMALS = 3;
const JSON_INDENT = 2;

const fmt = (n: number): string => n.toFixed(TABLE_DECIMALS);

const resultLine = (r: ScenarioResult): string =>
  `| ${r.key} | ${r.unit} | ${fmt(r.stats.mean)} | ${fmt(r.stats.median)} | ${fmt(r.stats.p95)} | ${fmt(r.stats.p99)} | ${fmt(r.stats.min)} | ${fmt(r.stats.max)} | ${fmt(r.stats.stddev)} |`;

const comparisonLine = (c: ComparisonRow): string => {
  const delta = c.deltaPct === 0 ? '—' : `${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}%`;
  return `| ${c.key} | ${c.verdict} | ${fmt(c.currentStat)} | ${c.baselineStat === 0 ? '—' : fmt(c.baselineStat)} | ${delta} | ${c.reason ?? ''} |`;
};

export const renderMarkdown = (report: PerfReport): string => {
  const lines: string[] = [];
  lines.push('# Ledge perf harness report');
  lines.push('');
  lines.push(`- recorded: ${report.recordedAt}`);
  lines.push(
    `- host: ${report.host.node} · ${report.host.platform}/${report.host.arch} · ${report.host.cpuCount} cores (CI reference profile)`,
  );
  lines.push(
    `- scenarios: ${report.results.length} · budget breaches: ${report.budgetBreaches.length}`,
  );
  lines.push('');
  lines.push('## Measurements (mean · median · P95 · P99 · min · max · stddev)');
  lines.push('');
  lines.push('| scenario | unit | mean | median | p95 | p99 | min | max | stddev |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of report.results) lines.push(resultLine(r));
  lines.push('');
  lines.push('## Baseline comparison');
  lines.push('');
  lines.push('| scenario | verdict | current | baseline | delta | note |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of report.comparisons) lines.push(comparisonLine(c));
  if (report.scalingFindings.length > 0) {
    lines.push('');
    lines.push('## Scaling findings');
    lines.push('');
    for (const f of report.scalingFindings) lines.push(`- ${f}`);
  }
  if (report.budgetBreaches.length > 0) {
    lines.push('');
    lines.push('## Budget breaches (hard — lane fails)');
    lines.push('');
    for (const b of report.budgetBreaches) lines.push(`- ${b}`);
  }
  if (report.budgetObservations.length > 0) {
    lines.push('');
    lines.push('## Budget observations (reference-profile rows; evidence for hardening)');
    lines.push('');
    for (const b of report.budgetObservations) lines.push(`- ${b}`);
  }
  lines.push('');
  return lines.join('\n');
};

export const writeReportArtifacts = (report: PerfReport, dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/perf-report.json`,
    `${JSON.stringify(report, null, JSON_INDENT)}\n`,
    'utf8',
  );
  writeFileSync(`${dir}/perf-report.md`, renderMarkdown(report), 'utf8');
};

export const emptyReport = (host: HostInfo): PerfReport => ({
  schemaV: REPORT_SCHEMA_V,
  recordedAt: new Date().toISOString(),
  host,
  results: [],
  comparisons: [],
  scalingFindings: [],
  budgetBreaches: [],
  budgetObservations: [],
});
