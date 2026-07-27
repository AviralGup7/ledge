#!/usr/bin/env node
// E8-T03 · on-device model artifact builder (ADR-040 carve-out earns its keep).
// Regenerates, DETERMINISTICALLY, from tools/ondevice-model/lexicon.json:
//   src/infrastructure/ai/providers/ondevice/model/frame-kernel.wasm.ts — the
//     hand-assembled WASM match kernel (real machine: 4×i64 frame keys over
//     packed term records; matched-id vector + f64 logit accumulation).
//   src/infrastructure/ai/providers/ondevice/model/weights.bin.ts — the packed
//     forward-pass weight table (frames×terms, prior logits, display vocab).
// Same lexicon ⇒ same bytes (sorted ids, fixed layouts). The CI check re-runs
// this builder in memory (emitArtifacts) and byte-compares, then instantiates
// the kernel and cross-checks it against the JS reference — derivation is
// provable, the machine is provably the machine.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LEXICON_PATH = join(ROOT, 'tools/ondevice-model/lexicon.json');
const OUT_DIR = join(ROOT, 'src/infrastructure/ai/providers/ondevice/model');

export const MODEL_V = 1;
export const MODEL_CLASS = 'ondevice-fwd-v1';
// Kernel ABI + memory layout (scores.ts mirrors these — the layout IS the contract).
export const NEEDLE_BASE = 4096; // lexicon terms staged at model load (const per session)
export const TEXT_PTR = 16384; // one mission's normalized corpus per call
export const TEXT_CAP_MIN_PAGES = 2; // 128KiB — ≥ 50 capped titles of headroom

// ── LEB128 + section framing ─────────────────────────────────────────────────
const uleb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (n) => {
  const out = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
};
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const name = (s) => [...uleb(s.length), ...ascii(s)];

// opcodes
const OP = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  ret: 0x0f,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  i32_load8_u: 0x2d,
  i32_const: 0x41,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_u: 0x49,
  i32_ge_u: 0x4f,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_or: 0x72,
};
const I32 = 0x7f;
const memarg = (align, offset) => [...uleb(align), ...uleb(offset)];

// ── The kernel ────────────────────────────────────────────────────────────────
// match_ptr(text_ptr, text_len, needle_ptr, needle_len) -> i32 (index | -1).
// Naive boundary scan — the REAL evidence-mining compute (ADR-040's carve-out
// earns its exception). Word byte = [0-9A-Za-z] or ≥0x80 (UTF-8 continuation);
// the JS normalize stage owns case/diacritics. Structured discipline: branches
// only at block-body level (depths 0/1), flag-carrying instead of br-from-if.
// locals: 4=i 5=j 6=limit 7=t1 8=char 9=flag
export function buildKernelBytes() {
  const body = [];
  const emit = (...bytes) => body.push(...bytes);
  const lg = (i) => emit(OP.local_get, ...uleb(i));
  const ls = (i) => emit(OP.local_set, ...uleb(i));
  const ic = (n) => emit(OP.i32_const, ...sleb(n));
  const wordCheck = () => {
    // isword(local8) → i32 0/1: [0-9] | [a-z] | [A-Z] | >=0x80
    lg(8);
    ic(48);
    emit(OP.i32_sub);
    ic(10);
    emit(OP.i32_lt_u);
    lg(8);
    ic(97);
    emit(OP.i32_sub);
    ic(26);
    emit(OP.i32_lt_u, OP.i32_or);
    lg(8);
    ic(65);
    emit(OP.i32_sub);
    ic(26);
    emit(OP.i32_lt_u, OP.i32_or);
    lg(8);
    ic(128);
    emit(OP.i32_ge_u, OP.i32_or);
  };
  const flagOrWord = () => {
    lg(9);
    wordCheck();
    emit(OP.i32_or);
    ls(9);
  };

  // needle_len == 0 or text_len < needle_len → -1
  lg(3);
  emit(OP.i32_eqz, OP.if, 0x40);
  ic(-1);
  emit(OP.ret);
  emit(OP.end);
  lg(1);
  lg(3);
  emit(OP.i32_lt_u, OP.if, 0x40);
  ic(-1);
  emit(OP.ret);
  emit(OP.end);
  // limit = text_len - needle_len
  lg(1);
  lg(3);
  emit(OP.i32_sub);
  ls(6);
  emit(OP.block, 0x40); // $done
  emit(OP.loop, 0x40); // $top
  // exit when limit < i
  lg(6);
  lg(4);
  emit(OP.i32_lt_u, OP.br_if, ...uleb(1));
  // j = 0; flag = 0
  ic(0);
  ls(5);
  ic(0);
  ls(9);
  emit(OP.block, 0x40); // $after_inner
  emit(OP.loop, 0x40); // $inner
  // j == needle_len → full token: break with flag untouched (0)
  lg(5);
  lg(3);
  emit(OP.i32_eq, OP.br_if, ...uleb(1));
  // t1 = mem[text+i+j]
  lg(0);
  lg(4);
  emit(OP.i32_add);
  lg(5);
  emit(OP.i32_add, OP.i32_load8_u, ...memarg(0, 0));
  ls(7);
  // char = mem[needle+j]
  lg(2);
  lg(5);
  emit(OP.i32_add, OP.i32_load8_u, ...memarg(0, 0));
  ls(8);
  // flag |= (t1 != char); j += (t1 == char)
  lg(9);
  lg(7);
  lg(8);
  emit(OP.i32_ne, OP.i32_or);
  ls(9);
  lg(5);
  lg(7);
  lg(8);
  emit(OP.i32_eq, OP.i32_add);
  ls(5);
  // mismatch seen → break; else continue inner
  lg(9);
  emit(OP.br_if, ...uleb(1));
  emit(OP.br, ...uleb(0));
  emit(OP.end); // $inner
  emit(OP.end); // $after_inner
  // candidate iff flag == 0
  lg(9);
  emit(OP.i32_eqz, OP.if, 0x40);
  // boundary BEFORE: i == 0 ? 32 : mem[text+i-1]
  lg(4);
  emit(OP.i32_eqz, OP.if, 0x40);
  ic(32);
  ls(8);
  emit(OP.else);
  lg(0);
  lg(4);
  emit(OP.i32_add);
  ic(-1);
  emit(OP.i32_add, OP.i32_load8_u, ...memarg(0, 0));
  ls(8);
  emit(OP.end);
  flagOrWord();
  // boundary AFTER: pos = i + needle_len; pos < text_len ? mem[text+pos] : 32
  lg(4);
  lg(3);
  emit(OP.i32_add, OP.local_tee, ...uleb(7));
  lg(1);
  emit(OP.i32_lt_u, OP.if, 0x40);
  lg(0);
  lg(7);
  emit(OP.i32_add, OP.i32_load8_u, ...memarg(0, 0));
  ls(8);
  emit(OP.else);
  ic(32);
  ls(8);
  emit(OP.end);
  flagOrWord();
  // clean match + clean boundaries → return i
  lg(9);
  emit(OP.i32_eqz, OP.if, 0x40);
  lg(4);
  emit(OP.ret);
  emit(OP.end);
  emit(OP.end); // (candidate-if)
  // advance
  lg(4);
  ic(1);
  emit(OP.i32_add);
  ls(4);
  emit(OP.br, ...uleb(0)); // → $top
  emit(OP.end); // $top
  emit(OP.end); // $done
  ic(-1);
  emit(OP.end); // func

  const locals = vec([[...uleb(6), I32]]);
  const codeBody = [...locals, ...body];
  const typeSec = section(1, vec([[0x60, ...uleb(4), I32, I32, I32, I32, ...uleb(1), I32]]));
  const funcSec = section(3, vec([[...uleb(0)]]));
  const memSec = section(5, vec([[0x00, ...uleb(2)]]));
  const exportSec = section(
    7,
    vec([
      [...name('memory'), 0x02, ...uleb(0)],
      [...name('match_ptr'), 0x00, ...uleb(0)],
    ]),
  );
  const codeSec = section(10, vec([[...uleb(codeBody.length), ...codeBody]]));
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSec,
    ...funcSec,
    ...memSec,
    ...exportSec,
    ...codeSec,
  ]);
}

// ── The weight table ─────────────────────────────────────────────────────────
// Header 'LFW1' (28B): magic 4 · v u32 · textOff · textLen · frameCount ·
// termCount · termTableOff. Frame rec (32B): idOff · idLen · displayOff ·
// displayLen · logit f64 · termStartIdx u32 · termCount u32. Term rec (8B):
// off u32 · len u32. ids are sort-stable slugs; displays carry the name-vocab.
export function buildWeightsBytes(lexicon) {
  const frames = [...lexicon.frames].sort((a, b) => a.id.localeCompare(b.id));
  const enc = new TextEncoder();
  const text = [];
  const putText = (s) => {
    const off = text.length;
    for (const b of enc.encode(s)) text.push(b);
    return { off, len: text.length - off };
  };
  const terms = [];
  const records = frames.map((f) => {
    const id = putText(f.id);
    const display = putText(f.display);
    const termStartIdx = terms.length;
    for (const term of f.terms) terms.push(putText(term));
    return { id, display, logit: f.logit, termStartIdx, termCount: f.terms.length };
  });
  const headerBytes = 28;
  const frameRecBytes = 32;
  const termRecBytes = 8;
  const termTableOff = headerBytes + records.length * frameRecBytes;
  const textOff = termTableOff + terms.length * termRecBytes;
  const out = new ArrayBuffer(textOff + text.length);
  const dv = new DataView(out);
  dv.setUint8(0, 0x4c);
  dv.setUint8(1, 0x46);
  dv.setUint8(2, 0x57);
  dv.setUint8(3, 0x31); // LFW1
  dv.setUint32(4, MODEL_V, true);
  dv.setUint32(8, textOff, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, records.length, true);
  dv.setUint32(20, terms.length, true);
  dv.setUint32(24, termTableOff, true);
  records.forEach((r, i) => {
    const base = headerBytes + i * frameRecBytes;
    dv.setUint32(base + 0, r.id.off, true);
    dv.setUint32(base + 4, r.id.len, true);
    dv.setUint32(base + 8, r.display.off, true);
    dv.setUint32(base + 12, r.display.len, true);
    dv.setFloat64(base + 16, r.logit, true);
    dv.setUint32(base + 24, r.termStartIdx, true);
    dv.setUint32(base + 28, r.termCount, true);
  });
  terms.forEach((t, i) => {
    const base = termTableOff + i * termRecBytes;
    dv.setUint32(base + 0, t.off, true);
    dv.setUint32(base + 4, t.len, true);
  });
  new Uint8Array(out, textOff).set(text);
  return new Uint8Array(out);
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const KERNEL_TS = (
  bytes,
  digest,
) => `// GENERATED by tools/ondevice-model/build-model.mjs — hand edits are a red gate
// (check:ondevice-model re-derives bytes from lexicon.json and byte-compares).
// ADR-040: this module is the ONLY wasm payload in the extension (CSP carve-out).
export const FRAME_KERNEL_WASM_B64 = '${bytes}';
export const FRAME_KERNEL_SHA256 = '${digest}';
`;
const WEIGHTS_TS = (
  bytes,
  digest,
  frameCount,
) => `// GENERATED by tools/ondevice-model/build-model.mjs — see frame-kernel.wasm.ts.
// Layout: 'LFW1' magic · v u32 · textOff u32 · textLen u32 · frameCount u32 ·
// frame records {displayOff,displayLen,logit f64,termOff,termLen} · utf8 blob.
export const WEIGHTS_BIN_B64 = '${bytes}';
export const WEIGHTS_SHA256 = '${digest}';
export const WEIGHTS_FRAME_COUNT = ${String(frameCount)};
`;
const INDEX_TS = `// GENERATED by tools/ondevice-model/build-model.mjs (v${String(MODEL_V)}, modelClass \`${MODEL_CLASS}\`).
export { FRAME_KERNEL_WASM_B64, FRAME_KERNEL_SHA256 } from './frame-kernel.wasm.js';
export { WEIGHTS_BIN_B64, WEIGHTS_FRAME_COUNT, WEIGHTS_SHA256 } from './weights.bin.js';
`;

export function emitArtifacts(lexicon) {
  const kernel = buildKernelBytes();
  const weights = buildWeightsBytes(lexicon);
  return {
    'frame-kernel.wasm.ts': KERNEL_TS(b64(kernel), sha256Hex(kernel)),
    'weights.bin.ts': WEIGHTS_TS(b64(weights), sha256Hex(weights), lexicon.frames.length),
    'index.ts': INDEX_TS,
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const lexicon = JSON.parse(readFileSync(LEXICON_PATH, 'utf8'));
  const artifacts = emitArtifacts(lexicon);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [filename, content] of Object.entries(artifacts)) {
    writeFileSync(join(OUT_DIR, filename), content);
  }
  console.info(
    `ondevice model: ${Object.keys(artifacts).length} artifacts regenerated (deterministic).`,
  );
}
