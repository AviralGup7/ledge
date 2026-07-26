// E5-T03 · render-json (ADR-045: fidelity + schema tag + per-part checksums +
// manifest; self-describing = spec version + app provenance). Grammar v1 (the
// covenant — a grammar change is a formatV bump, NEVER an edit):
//
//   { "format":"ledge-export", "formatV":1, "app":{…}, "canonRulesV":…,
//     "generatedAt":…, "scope":…,
//     "missions":[ <mission objects> ],
//     "looseTabs":[ <tab objects> ],
//     "diagnostics":{…},
//     "manifest":{ parts, partCount, totalBytes, manifestChecksum } }
//
// Part grammar (what each partId seals — the separator law: array separators
// ride INSIDE the part that precedes them, so parts concatenate byte-exactly):
//   head            — everything through `"missions": [` (provenance + scope)
//   mission:<id>    — one mission object (+ trailing `,` when a part follows)
//   loose:<i>       — LOOSE_BATCH tab objects (+ trailing `,` when a part follows)
//   tail            — `], "diagnostics":…,` closing the data arrays
//   manifest        — the manifest object + document close (sealer, not sealed)
import type { CanonicalExportModel, ExportMissionModel, ExportTabModel } from './model.js';
import { crc32Hex } from '@/shared-kernel/canon/index.js';
import { MANIFEST_PART_ID, type ManifestPart, type RawPart } from './stream.js';

/** Tabs per loose-batch part (streaming granularity for pathological libraries). */
export const LOOSE_BATCH = 500;

/** Manifest seal input law: ordered `partId:checksum` lines over DATA parts. */
const sealOf = (parts: readonly ManifestPart[]): string =>
  crc32Hex(parts.map((p) => `${p.partId}:${p.checksum}`).join('\n'));

const byteLen = (text: string): number => new TextEncoder().encode(text).length;

/** Nested JSON block: pretty-print (two-space indent — the grammar's indent
 *  unit) then re-indent every line by `pad` spaces. */
const JSON_INDENT = 2;

const nest = (value: unknown, pad: string): string =>
  JSON.stringify(value, null, JSON_INDENT)
    .split('\n')
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join('\n');

const PAD = '    ';

const missionText = (mission: ExportMissionModel, moreFollow: boolean): string =>
  `${nest(mission, PAD)}${moreFollow ? ',' : ''}\n`;

const looseText = (tabs: readonly ExportTabModel[], moreFollow: boolean): string =>
  `${tabs.map((t) => nest(t, PAD)).join(',\n')}${moreFollow ? ',' : ''}\n`;

/**
 * Build the JSON grammar's raw parts from the canonical model. Deterministic:
 * same model ⇒ same parts ⇒ same bytes ⇒ same checksums (round-trip law).
 */
export const jsonParts = (model: CanonicalExportModel): readonly RawPart[] => {
  const headText =
    `{\n  "format": ${JSON.stringify(model.format)},\n` +
    `  "formatV": ${String(model.formatV)},\n` +
    `  "app": ${JSON.stringify(model.app)},\n` +
    `  "canonRulesV": ${String(model.canonRulesV)},\n` +
    `  "generatedAt": ${String(model.generatedAt)},\n` +
    `  "scope": ${JSON.stringify(model.scope)},\n` +
    `  "missions": [` +
    (model.missions.length > 0 ? '\n' : '');

  const dataParts: RawPart[] = [{ partId: 'head', text: headText }];
  model.missions.forEach((mission, i) => {
    const moreMission = i < model.missions.length - 1;
    dataParts.push({
      partId: `mission:${mission.missionId}`,
      text: missionText(mission, moreMission),
    });
  });

  // The loose array opens in the tail… unless loose tabs exist, in which case
  // the tail opens it and loose parts carry the batches. Empty arrays stay valid.
  const looseBatches: RawPart[] = [];
  for (let start = 0; start < model.looseTabs.length; start += LOOSE_BATCH) {
    const batch = model.looseTabs.slice(start, start + LOOSE_BATCH);
    const batchIndex = Math.floor(start / LOOSE_BATCH);
    const moreBatches = start + LOOSE_BATCH < model.looseTabs.length;
    const prefix = start === 0 ? '],\n  "looseTabs": [\n' : '';
    looseBatches.push({
      partId: `loose:${String(batchIndex)}`,
      text: `${prefix}${looseText(batch, moreBatches)}`,
    });
  }

  const tailText =
    model.looseTabs.length > 0
      ? `],\n  "diagnostics": ${JSON.stringify(model.diagnostics)},\n`
      : `],\n  "looseTabs": [],\n  "diagnostics": ${JSON.stringify(model.diagnostics)},\n`;

  const sealed: ManifestPart[] = [
    ...dataParts,
    ...looseBatches,
    { partId: 'tail', text: tailText },
  ].map((p) => ({ partId: p.partId, checksum: crc32Hex(p.text), bytes: byteLen(p.text) }));

  const manifest = {
    parts: sealed,
    partCount: sealed.length,
    totalBytes: sealed.reduce((n, p) => n + p.bytes, 0),
    manifestChecksum: sealOf(sealed),
  };
  const manifestText = `  "manifest": ${nest(manifest, '  ')}\n}\n`;

  return [
    ...dataParts,
    ...looseBatches,
    { partId: 'tail', text: tailText },
    { partId: MANIFEST_PART_ID, text: manifestText },
  ];
};
