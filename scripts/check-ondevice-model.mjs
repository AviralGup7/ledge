#!/usr/bin/env node
// E8-T03 · on-device model derivation gate (`pnpm check:ondevice-model`) [CI].
// The committed model bytes must be provably DERIVED from
// tools/ondevice-model/lexicon.json — a hand-edited weight table or kernel is
// an unverifiable blob, and ADR-040's carve-out only tolerates a verifiable
// one. Chain of custody, all mechanical:
//
//   D1 RE-DERIVATION: emitArtifacts(lexicon.json) re-run in memory MUST
//      byte-equal the three committed model/*.ts files (same lexicon ⇒ same
//      bytes — the builder is deterministic by construction).
//   D2 STAMP SELF-CONSISTENCY: sha256(base64_decode(committed payload)) MUST
//      equal the committed *_SHA256 stamp inside the same file (a doctored
//      header riding on honest bytes fails here).
//   D3 MACHINE TRUTH: WebAssembly.validate + instantiate succeed; the ABI
//      ({memory, match_ptr}) exists; memory covers the layout contract.
//   D4 LAYOUT LAW: NEEDLE_BASE + weights textBlob ≤ TEXT_PTR (needles never
//      crowd the corpus lane).
//   D5 TERM-FORM LIVENESS: every lexicon term MUST equal its own normalization
//      (full-word boundary law). Dead needles — " rust ", "next.js", "b-tree",
//      raw sub-word stems — cannot match and are rejected at authoring time.
//      (Corpus reachability — every term fires ≥1 row — is shadow-eval G4.)
//   D6 SMOKE AGREEMENT: the machine and the JS law answer identically for all
//      lexicon terms over a fixed probe grid (corpus-scale agreement lives in
//      unit lane M2 + shadow-eval G9; this runs everywhere, cheaply).
//   D7 DETERMINISM: two emissions of the same lexicon are byte-equal.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKernelBytes,
  emitArtifacts,
  NEEDLE_BASE,
  TEXT_PTR,
} from '../tools/ondevice-model/build-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON_PATH = join(ROOT, 'tools/ondevice-model/lexicon.json');
const MODEL_DIR = join(ROOT, 'src/infrastructure/ai/providers/ondevice/model');

const failures = [];
const check = (law, verdict, detail) => {
  if (!verdict) failures.push(`${law}: ${detail}`);
};

// ── D1 · re-derivation byte equality ─────────────────────────────────────────
const lexicon = JSON.parse(readFileSync(LEXICON_PATH, 'utf8'));
const emitted = emitArtifacts(lexicon);
const FILES = ['frame-kernel.wasm.ts', 'weights.bin.ts', 'index.ts'];
for (const file of FILES) {
  const committed = readFileSync(join(MODEL_DIR, file), 'utf8');
  check(
    'D1',
    committed === emitted[file],
    `${file} is not the emitted artifact — run \`pnpm gen:ondevice-model\``,
  );
}

// ── D7 · determinism ─────────────────────────────────────────────────────────
const again = emitArtifacts(lexicon);
check(
  'D7',
  FILES.every((f) => again[f] === emitted[f]),
  'emitArtifacts is not deterministic across two emissions',
);

// ── D2 · stamp self-consistency ──────────────────────────────────────────────
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const extract = (file, key) => {
  const text = readFileSync(join(MODEL_DIR, file), 'utf8');
  const m = new RegExp(`${key} = '([^']+)'`, 'u').exec(text);
  if (m === null) failures.push(`D2: ${file}: missing ${key}`);
  return m?.[1] ?? '';
};
const kernelBytes = Buffer.from(extract('frame-kernel.wasm.ts', 'FRAME_KERNEL_WASM_B64'), 'base64');
const weightsBytes = Buffer.from(extract('weights.bin.ts', 'WEIGHTS_BIN_B64'), 'base64');
check(
  'D2',
  sha256(kernelBytes) === extract('frame-kernel.wasm.ts', 'FRAME_KERNEL_SHA256'),
  'kernel payload sha256 != committed stamp',
);
check(
  'D2',
  sha256(weightsBytes) === extract('weights.bin.ts', 'WEIGHTS_SHA256'),
  'weights sha256 != committed stamp',
);
const frameCountStamp = /WEIGHTS_FRAME_COUNT = (\d+)/u.exec(
  readFileSync(join(MODEL_DIR, 'weights.bin.ts'), 'utf8'),
);
check(
  'D2',
  frameCountStamp !== null && Number(frameCountStamp[1]) === lexicon.frames.length,
  'WEIGHTS_FRAME_COUNT stamp != lexicon frame count',
);

// ── D3 · machine truth ───────────────────────────────────────────────────────
check(
  'D3',
  kernelBytes.length > 0 && WebAssembly.validate(kernelBytes),
  'kernel fails WebAssembly.validate',
);
let instance = null;
try {
  ({ instance } = await WebAssembly.instantiate(kernelBytes, {}));
} catch (cause) {
  failures.push(`D3: instantiate threw: ${String(cause)}`);
}
if (instance !== null) {
  const { memory, match_ptr: matchPtr } = instance.exports;
  check('D3', memory instanceof WebAssembly.Memory, 'missing exported memory');
  check('D3', typeof matchPtr === 'function', 'missing exported match_ptr');
  if (memory instanceof WebAssembly.Memory) {
    check(
      'D3',
      memory.buffer.byteLength >= TEXT_PTR,
      `memory ${memory.buffer.byteLength} < TEXT_PTR ${TEXT_PTR}`,
    );
  }
}

// ── D4 · layout law (header fields of the committed weights) ─────────────────
const HEADER_BYTES = 28;
const weightsPlausible = weightsBytes.length >= HEADER_BYTES;
check(
  'D4',
  weightsPlausible,
  `weights payload too small (${weightsBytes.length} bytes) — header unreadable`,
);
const dv = weightsPlausible
  ? new DataView(weightsBytes.buffer, weightsBytes.byteOffset, weightsBytes.byteLength)
  : null;
const magicOk = weightsPlausible && [0x4c, 0x46, 0x57, 0x31].every((b, i) => weightsBytes[i] === b); // LFW1
check('D4', magicOk, 'weights magic != LFW1');
const textOff = dv?.getUint32(8, true) ?? 0;
const textLen = dv?.getUint32(12, true) ?? 0;
if (weightsPlausible && magicOk) {
  check(
    'D4',
    NEEDLE_BASE + textLen <= TEXT_PTR,
    `needles ${NEEDLE_BASE}+${textLen} cross TEXT_PTR ${TEXT_PTR}`,
  );
  check('D4', textOff + textLen <= weightsBytes.length, 'text blob out of weights range');
}

// ── D5 · term-form liveness ──────────────────────────────────────────────────
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
const deadTerms = [];
for (const frame of lexicon.frames) {
  for (const term of frame.terms) {
    if (term !== normalize(term) || term.length === 0) deadTerms.push(`${frame.id}: "${term}"`);
  }
}
check('D5', deadTerms.length === 0, `non-normal terms (dead needles): ${deadTerms.join('; ')}`);

// ── D6 · smoke agreement (machine vs JS law over a probe grid) ───────────────
// Terms are read from the REAL committed weight table (off,len records) — the
// smoke exercises exactly the bytes the runtime ships, never a re-derivation.
if (instance !== null && dv !== null && magicOk) {
  const { memory, match_ptr: matchPtr } = instance.exports;
  const textBlob = weightsBytes.subarray(textOff, textOff + textLen);
  new Uint8Array(memory.buffer).set(textBlob, NEEDLE_BASE);
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
  // Walk the frame + term records (layout-mirrored; D1 byte-equality pins it).
  const frameCount = dv.getUint32(16, true);
  const termTotal = dv.getUint32(20, true);
  const termTableOff = dv.getUint32(24, true);
  const decoder = new TextDecoder();
  const tableTerms = [];
  for (let i = 0; i < frameCount; i += 1) {
    const base = 28 + i * 32;
    const termStart = dv.getUint32(base + 24, true);
    const count = dv.getUint32(base + 28, true);
    for (let t = 0; t < count && termStart + t < termTotal; t += 1) {
      const rec = termTableOff + (termStart + t) * 8;
      const off = dv.getUint32(rec, true);
      const len = dv.getUint32(rec + 4, true);
      tableTerms.push({ off, len, text: decoder.decode(textBlob.subarray(off, off + len)) });
    }
  }
  const probes = [
    'the pull request on github was merged at noon',
    'kubernetes deploy and the ci cd bill',
    'сложные слова ici और शब्द here githubber',
    'sqlite query planner, b tree, and indexeddb',
    'typescript inside jsx with service worker notes',
  ];
  const encoder = new TextEncoder();
  let mismatch = 0;
  let verdicts = 0;
  const expectedKernel = buildKernelBytes();
  check(
    'D6',
    Buffer.from(expectedKernel).equals(kernelBytes),
    'committed kernel bytes differ from buildKernelBytes() (builder law drift)',
  );
  for (const probe of probes) {
    const corpus = normalize(probe);
    const textBytes = encoder.encode(corpus);
    new Uint8Array(memory.buffer).set(textBytes, TEXT_PTR);
    for (const term of tableTerms) {
      const at = matchPtr(TEXT_PTR, textBytes.length, NEEDLE_BASE + term.off, term.len);
      const machine = at >= 0;
      const reference = matchRef(corpus, term.text);
      verdicts += 1;
      if (machine !== reference) mismatch += 1;
    }
  }
  check('D6', mismatch === 0, `machine-vs-law smoke: ${mismatch}/${verdicts} mismatches`);
}

if (failures.length > 0) {
  console.error(`check:ondevice-model FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.info(
  'check:ondevice-model OK — derivation, stamps, machine, layout, liveness, smoke, determinism (D1-D7).',
);
