#!/usr/bin/env node
// E8-T03 · shadow-eval gate (`pnpm check:shadow-eval`) — metric set
// ai-shadow-eval-v1, frozen in docs/ai-shadow-eval-v1.md. This is the harness
// behind the roadmap's completion sentence "OnDeviceML beats heuristic on the
// shadow evaluation set ≥ threshold" and behind the doc-law that ships the
// provider flag-on: the evidence is a BUILD GATE, never a slack note.
//
//   CHAIN OF TRUST (each link provable, none assumed):
//     lexicon.json ==(check:ondevice-model byte-compare)== committed model .ts
//     committed model .ts ==(sha256 stamps, re-verified HERE)== shipped bytes
//     shipped WASM machine ==(this script, corpus-scale agreement)== JS law
//     corpus generator ==(byte-compare below)== committed missions.json
//
//   INDEPENDENCE LAW: the evaluator NEVER imports src/ TypeScript modules. It
//   re-implements the scorer from the frozen doc constants; the unit lane ties
//   the runtime provider to the same law (M2), so a drift on either side breaks
//   a different gate. Evaluation that imports the code under test grades its
//   own homework — banned.
//
//   Flag: --write-report refreshes ops/shadow-eval/report.json (evidence).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, serializeCorpus } from '../shadow-corpus/gen.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_DIR = join(ROOT, 'src/infrastructure/ai/providers/ondevice/model');
const CORPUS_PATH = join(ROOT, 'ops/shadow-corpus/missions.json');
const REPORT_PATH = join(ROOT, 'ops/shadow-eval/report.json');

// ── Frozen v1 constants (docs/ai-shadow-eval-v1.md is the source of truth) ──
const NEEDLE_BASE = 4096;
const TEXT_PTR = 16384;
const ACCEPT_POSTERIOR = 0.6;
const DUAL_MARGIN = 0.12;
const MISSION_GRADE_LOGIT = 1.0;
const STAMPS = { sharpDual: 0.88, sharp: 0.85, mid: 0.72, floor: 0.64 };
const CONFIDENCE_SHARP = 0.9;
const HEURISTIC_CONFIDENCE = 0.55;

const GATES = {
  'G1-fabrication-zero': { metric: 'named on expect-yield rows', threshold: 0 },
  'G2-precision': { metric: 'top frame ∈ accepted / named', threshold: 0.95 },
  'G3-recall': { metric: 'named / nameable', threshold: 0.85 },
  'G4-term-reachability': { metric: 'lexicon terms fired ≥1 row', threshold: 1 },
  'G5-beats-heuristic': { metric: 'ondevice acc − heuristic acc (nameable)', threshold: 0.5 },
  'G6-stamp-vocabulary': { metric: 'confidences ⊆ frozen stamp set', threshold: 1 },
  'G7-determinism': { metric: 'two full passes, byte-equal digest', threshold: 1 },
  'G8-totality': { metric: 'rows judged == rows in corpus', threshold: 1 },
  'G9-machine-agreement': { metric: 'wasm machine == JS law (term verdicts)', threshold: 1 },
};

const fail = (msg) => {
  console.error(`shadow-eval: ${msg}`);
  process.exit(1);
};

// ── 1 · Corpus derivation pin ────────────────────────────────────────────────
const committedCorpusText = readFileSync(CORPUS_PATH, 'utf8');
if (committedCorpusText !== serializeCorpus(buildCorpus())) {
  fail('missions.json is NOT the seeded artifact — run `pnpm gen:shadow-corpus` and commit.');
}
const corpus = JSON.parse(committedCorpusText);
if (corpus.schema !== 'shadow-corpus-v1') fail(`unknown corpus schema ${corpus.schema}`);
const rows = corpus.rows;
if (!Array.isArray(rows) || rows.length === 0) fail('empty corpus');

// ── 2 · Shipped-bytes extraction + stamp re-verification ─────────────────────
const extract = (file, key) => {
  const text = readFileSync(join(MODEL_DIR, file), 'utf8');
  const match = new RegExp(`${key} = '([^']+)'`, 'u').exec(text);
  if (match === null) fail(`${file}: ${key} stamp not found`);
  return match[1];
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const kernelBytes = Buffer.from(extract('frame-kernel.wasm.ts', 'FRAME_KERNEL_WASM_B64'), 'base64');
const weightsBytes = Buffer.from(extract('weights.bin.ts', 'WEIGHTS_BIN_B64'), 'base64');
if (sha256(kernelBytes) !== extract('frame-kernel.wasm.ts', 'FRAME_KERNEL_SHA256')) {
  fail('kernel payload does not match its committed sha256 stamp (module byte-truth)');
}
if (sha256(weightsBytes) !== extract('weights.bin.ts', 'WEIGHTS_SHA256')) {
  fail('weights payload does not match its committed sha256 stamp');
}

// ── 3 · Independent scorer (re-implemented; imports NOTHING from src/) ───────
const NORMALIZE_MARKS = /\p{M}+/gu;
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;
const normalize = (raw) =>
  raw
    .normalize('NFKD')
    .replace(NORMALIZE_MARKS, '')
    .toLowerCase()
    .replace(NON_WORD_RUN, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);
const matchRef = (haystack, needle) => {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : haystack.charAt(at - 1);
    const afterAt = at + needle.length;
    const after = afterAt >= haystack.length ? ' ' : haystack.charAt(afterAt);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
};

const parseWeights = (bytes) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicOk = [0x4c, 0x46, 0x57, 0x31].every((b, i) => bytes[i] === b); // LFW1
  if (!magicOk) fail('weights: bad magic');
  if (dv.getUint32(4, true) !== 1) fail('weights: version != 1');
  const textOff = dv.getUint32(8, true);
  const textLen = dv.getUint32(12, true);
  const frameCount = dv.getUint32(16, true);
  const termCount = dv.getUint32(20, true);
  const termTableOff = dv.getUint32(24, true);
  const decoder = new TextDecoder();
  const textAt = (off, len) => decoder.decode(bytes.subarray(textOff + off, textOff + off + len));
  const frames = [];
  for (let i = 0; i < frameCount; i += 1) {
    const base = 28 + i * 32;
    const id = textAt(dv.getUint32(base, true), dv.getUint32(base + 4, true));
    const display = textAt(dv.getUint32(base + 8, true), dv.getUint32(base + 12, true));
    const logit = dv.getFloat64(base + 16, true);
    const termStart = dv.getUint32(base + 24, true);
    const count = dv.getUint32(base + 28, true);
    const terms = [];
    for (let t = 0; t < count && termStart + t < termCount; t += 1) {
      const rec = termTableOff + (termStart + t) * 8;
      terms.push({
        off: dv.getUint32(rec, true),
        len: dv.getUint32(rec + 4, true),
        text: textAt(dv.getUint32(rec, true), dv.getUint32(rec + 4, true)),
      });
    }
    frames.push({ id, display, logit, terms });
  }
  return { frames, textBlob: bytes.subarray(textOff, textOff + textLen) };
};
const weights = parseWeights(weightsBytes);
if (NEEDLE_BASE + weights.textBlob.length > TEXT_PTR) fail('layout: needles cross TEXT_PTR');

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const forwardPassRef = (normalizedCorpus) =>
  weights.frames
    .map((frame) => {
      const matched = frame.terms.filter((term) => matchRef(normalizedCorpus, term.text));
      const z = matched.length * frame.logit;
      return {
        frameId: frame.id,
        display: frame.display,
        logit: frame.logit,
        z,
        posterior: sigmoid(z),
        matched: matched.map((m) => m.text),
      };
    })
    .filter((e) => e.matched.length > 0)
    .sort((a, b) => b.z - a.z || a.frameId.localeCompare(b.frameId));

const calibrateRef = (evidence, tabCount) => {
  const top = evidence[0];
  if (top === undefined || top.posterior < ACCEPT_POSTERIOR) return null;
  const mate =
    top.logit >= MISSION_GRADE_LOGIT
      ? evidence
          .slice(1)
          .find((e) => e.logit >= MISSION_GRADE_LOGIT && top.posterior - e.posterior < DUAL_MARGIN)
      : undefined;
  const stampFor = (posterior, dual) => {
    if (posterior >= CONFIDENCE_SHARP && dual) return STAMPS.sharpDual;
    if (posterior >= CONFIDENCE_SHARP) return STAMPS.sharp;
    if (posterior >= ACCEPT_POSTERIOR) return STAMPS.mid;
    return STAMPS.floor;
  };
  const value =
    mate !== undefined
      ? `${top.display} & ${mate.display} · ${tabCount} tabs`
      : `${top.display} · ${tabCount} tabs`;
  return { value, confidence: stampFor(top.posterior, mate !== undefined), top, mate };
};

// Heuristic rung-1 re-implementation (for the G5 margin only — strict words).
const STEP_OVER = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
const labelWord = (domain) => {
  const parts = domain
    .toLowerCase()
    .split('.')
    .filter((p) => p.length > 0);
  if (parts.length === 0) return domain;
  if (parts.length === 1) return parts[0];
  const secondLevel = parts.length >= 2 ? parts[parts.length - 2] : '';
  if (STEP_OVER.has(secondLevel) && parts.length > 2) return parts[parts.length - 3];
  return secondLevel.length > 0 ? secondLevel : parts[0];
};
const heuristicTopicWords = (row) =>
  [...new Set(row.rootDomains.map(labelWord))].slice(0, 2).map((w) => w.toLowerCase());

// ── 4 · The shipped machine, instantiated once ───────────────────────────────
if (!WebAssembly.validate(kernelBytes)) fail('kernel bytes fail WebAssembly.validate');
const { instance } = await WebAssembly.instantiate(kernelBytes, {});
const memory = instance.exports.memory;
const matchPtr = instance.exports.match_ptr;
if (!(memory instanceof WebAssembly.Memory) || typeof matchPtr !== 'function') {
  fail('kernel ABI mismatch (memory/match_ptr exports)');
}
const memoryBytes = () => new Uint8Array(memory.buffer);
memoryBytes().set(weights.textBlob, NEEDLE_BASE); // needle staging law
const encoder = new TextEncoder();
const machineMatchSet = (normalizedCorpus) => {
  const textBytes = encoder.encode(normalizedCorpus);
  if (TEXT_PTR + textBytes.length > memory.buffer.byteLength) return null; // over-cap: law says []
  memoryBytes().set(textBytes, TEXT_PTR);
  const out = new Map(); // frameId -> matched term texts
  for (const frame of weights.frames) {
    const hits = [];
    for (const term of frame.terms) {
      const at = matchPtr(TEXT_PTR, textBytes.length, NEEDLE_BASE + term.off, term.len);
      if (at >= 0) hits.push(term.text);
    }
    if (hits.length > 0) out.set(frame.id, hits);
  }
  return out;
};

// ── 5 · One full evaluation pass (run twice for the determinism gate) ────────
function corpusOfRowTexts(row) {
  const parts = [];
  for (const tab of row.tabs) {
    if (typeof tab.title === 'string' && tab.title.length > 0) parts.push(tab.title);
    if (tab.discarded !== true && typeof tab.rootDomain === 'string' && tab.rootDomain.length > 0) {
      parts.push(tab.rootDomain);
    }
  }
  if (parts.length === 0) parts.push(...row.rootDomains);
  return parts.join(' ');
}

const runPass = () => {
  const perRow = [];
  const termFired = new Set();
  let machineMismatches = 0;
  for (const row of rows) {
    const corpus = normalize(corpusOfRowTexts(row));
    const evidence = forwardPassRef(corpus);
    const named = corpus.length === 0 ? null : calibrateRef(evidence, row.tabCount);
    // G9: machine agreement — matched sets must equal the JS law exactly.
    const machine = machineMatchSet(corpus);
    const refMap = new Map(evidence.map((e) => [e.frameId, e.matched]));
    const canon = (m) =>
      JSON.stringify([...m.entries()].map(([k, v]) => [k, [...v].sort()]).sort());
    if (machine === null || canon(machine) !== canon(refMap)) machineMismatches += 1;
    for (const e of evidence) for (const t of e.matched) termFired.add(t);
    const topicOk =
      named !== null &&
      row.accepted.includes(named.top.frameId) &&
      (named.mate === undefined || row.accepted.includes(named.mate.frameId));
    const heuristicWords = heuristicTopicWords(row);
    // Strict word equality, but displays count as words too (frame 'devops'
    // displays 'deploy' — a heuristic label "deploy" is genuinely on-topic).
    const acceptedWords = new Set();
    for (const frameId of row.accepted) {
      acceptedWords.add(frameId.toLowerCase());
      const frame = weights.frames.find((f) => f.id === frameId);
      if (frame !== undefined) acceptedWords.add(frame.display.toLowerCase());
    }
    const heuristicOk = row.accepted.length > 0 && heuristicWords.some((w) => acceptedWords.has(w));
    perRow.push({ row, named, topicOk, heuristicOk, heuristicWords });
  }
  return { perRow, termFired, machineMismatches };
};

const summarize = ({ perRow, termFired, machineMismatches }) => {
  const judged = perRow.length;
  const nameable = perRow.filter((r) => r.row.expect === 'name');
  const yieldRows = perRow.filter((r) => r.row.expect === 'yield');
  const named = perRow.filter((r) => r.named !== null);
  const fabrications = named.filter((r) => r.row.expect === 'yield').length;
  const precisionOk = named.filter((r) => r.topicOk).length;
  const allTerms = new Set(weights.frames.flatMap((f) => f.terms.map((t) => t.text)));
  const stampVocab = new Set(Object.values(STAMPS));
  const stampViolations = named.filter((r) => !stampVocab.has(r.named.confidence)).length;
  const ondeviceAcc =
    nameable.filter((r) => r.named !== null && r.topicOk).length / nameable.length;
  const heuristicAcc = nameable.filter((r) => r.heuristicOk).length / nameable.length;
  return {
    judged,
    totalRows: rows.length,
    nameable: nameable.length,
    yieldRows: yieldRows.length,
    named: named.length,
    fabrications,
    precision: named.length === 0 ? 0 : precisionOk / named.length,
    recall:
      nameable.length === 0 ? 0 : nameable.filter((r) => r.named !== null).length / nameable.length,
    termReachability: termFired.size / allTerms.size,
    deadTerms: [...allTerms].filter((t) => !termFired.has(t)),
    ondeviceAcc,
    heuristicAcc,
    beatsHeuristicMargin: ondeviceAcc - heuristicAcc,
    stampVocabularyPass: stampViolations === 0,
    heuristicConfidence: HEURISTIC_CONFIDENCE,
    machineMismatches,
  };
};

const digestOf = (summary, perRow) =>
  sha256(
    Buffer.from(
      JSON.stringify({
        summary,
        names: perRow.map((r) => [r.row.id, r.named?.value ?? null, r.named?.confidence ?? null]),
      }),
    ),
  );

const first = runPass();
const firstSummary = summarize(first);
const second = runPass();
const secondSummary = summarize(second);
const determinismPass =
  digestOf(firstSummary, first.perRow) === digestOf(secondSummary, second.perRow);

// ── 6 · Gates ────────────────────────────────────────────────────────────────
const metrics = {
  fabrications: firstSummary.fabrications,
  precision: firstSummary.precision,
  recall: firstSummary.recall,
  termReachability: firstSummary.termReachability,
  beatsHeuristicMargin: firstSummary.beatsHeuristicMargin,
  stampVocabularyPass: firstSummary.stampVocabularyPass,
  determinismPass,
  totalityPass: firstSummary.judged === firstSummary.totalRows,
  machineAgreementPass: firstSummary.machineMismatches === 0,
};
const gateResults = [
  { id: 'G1-fabrication-zero', pass: metrics.fabrications === 0, value: metrics.fabrications },
  {
    id: 'G2-precision',
    pass: metrics.precision >= GATES['G2-precision'].threshold,
    value: metrics.precision,
  },
  { id: 'G3-recall', pass: metrics.recall >= GATES['G3-recall'].threshold, value: metrics.recall },
  {
    id: 'G4-term-reachability',
    pass: metrics.termReachability === 1,
    value: metrics.termReachability,
  },
  {
    id: 'G5-beats-heuristic',
    pass: metrics.beatsHeuristicMargin >= GATES['G5-beats-heuristic'].threshold,
    value: metrics.beatsHeuristicMargin,
  },
  {
    id: 'G6-stamp-vocabulary',
    pass: metrics.stampVocabularyPass,
    value: metrics.stampVocabularyPass,
  },
  { id: 'G7-determinism', pass: metrics.determinismPass, value: metrics.determinismPass },
  { id: 'G8-totality', pass: metrics.totalityPass, value: firstSummary.judged },
  {
    id: 'G9-machine-agreement',
    pass: metrics.machineAgreementPass,
    value: firstSummary.machineMismatches,
  },
];
const failed = gateResults.filter((g) => !g.pass);
const report = {
  metricSet: 'ai-shadow-eval-v1',
  corpusHash: sha256(Buffer.from(committedCorpusText)),
  kernelHash: sha256(kernelBytes),
  rows: firstSummary.totalRows,
  nameable: firstSummary.nameable,
  yieldRows: firstSummary.yieldRows,
  namedByOnDevice: firstSummary.named,
  ondeviceAcc: metrics.precision === 0 ? 0 : firstSummary.ondeviceAcc,
  heuristicAcc: firstSummary.heuristicAcc,
  metrics,
  deadTerms: firstSummary.deadTerms,
  gates: gateResults.map((g) => ({ ...g, law: GATES[g.id] })),
  verdict: failed.length === 0 ? 'pass' : 'fail',
};

if (process.argv.includes('--write-report')) {
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`shadow-eval: report written to ${REPORT_PATH}`);
}
console.info(JSON.stringify(report, null, 2));
if (failed.length > 0) {
  console.error(
    `shadow-eval: ${failed.length} gate(s) failed: ${failed.map((g) => g.id).join(', ')}`,
  );
  process.exit(1);
}
console.info('shadow-eval: ai-shadow-eval-v1 PASS — all gates green.');
