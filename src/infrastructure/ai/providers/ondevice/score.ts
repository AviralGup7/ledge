// E8-T03 · on-device forward pass v1 — normalized title corpus → WASM boundary
// scan (the REAL evidence-mining compute; ADR-040's carve-out earns it) →
// prior-logit evidence → calibrated posterior. Honesty laws:
//  * ENGLISH-ONLY lexicon — non-English titles score nothing; thin evidence
//    YIELDS to the next rung (null), never fabricates.
//  * STEMMING = boundary-safe substring, never morphological — "github" matches
//    "github" alone, "pull request" as the phrase, "retro" uneats
//    "retrospective". The lexicon carries its stems; the kernel enforces the
//    boundaries in wasm bytes.
//  * DISPLAY vocabulary = lexicon displays (never invented), tabCount is the
//    only input-derived token in the name — same honesty class as rung 1.
import {
  MODEL_V,
  NEEDLE_BASE,
  TEXT_PTR,
  WEIGHTS_FRAME_REC_BYTES,
  WEIGHTS_HEADER_BYTES,
  WEIGHTS_TERM_REC_BYTES,
} from './model-layout.js';

export interface WeightFrame {
  readonly id: string;
  readonly display: string;
  readonly logit: number;
  /** Staged needle descriptors: (off,len) into the model's text blob. */
  readonly terms: readonly { off: number; len: number; text: string }[];
}

export interface ParsedWeights {
  readonly frames: readonly WeightFrame[];
  /** The raw text blob staged into wasm memory once per model instance. */
  readonly textBlob: Uint8Array;
}

const decoder = new TextDecoder();

// Layout offsets (builder-mirrored — the derived-bytes check proves agreement).
const MAGIC = 'LFW1' as const;
const VER_OFF = 4;
const HDR = { text: 8, textLen: 12, frameCount: 16, termCount: 20, termTable: 24 } as const;
const U32 = 4;
const FRAME = {
  idOff: 0,
  idLen: 4,
  dispOff: 8,
  dispLen: 12,
  logit: 16,
  termStart: 24,
  termCount: 28,
} as const;

export const parseWeights = (bytes: Uint8Array): ParsedWeights => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magicOk =
    bytes.length >= WEIGHTS_HEADER_BYTES &&
    [...MAGIC].every((ch, i) => bytes[i] === ch.charCodeAt(0));
  if (!magicOk) throw new Error('weights: bad magic');
  if (dv.getUint32(VER_OFF, true) !== MODEL_V) throw new Error('weights: version mismatch');
  const textOff = dv.getUint32(HDR.text, true);
  const textLen = dv.getUint32(HDR.textLen, true);
  const frameCount = dv.getUint32(HDR.frameCount, true);
  const termCount = dv.getUint32(HDR.termCount, true);
  const termTableOff = dv.getUint32(HDR.termTable, true);
  if (textOff + textLen > bytes.length) throw new Error('weights: text blob out of range');
  const textAt = (off: number, len: number): string =>
    decoder.decode(bytes.subarray(textOff + off, textOff + off + len));
  const termRec = (idx: number): { off: number; len: number } => ({
    off: dv.getUint32(termTableOff + idx * WEIGHTS_TERM_REC_BYTES, true),
    len: dv.getUint32(termTableOff + idx * WEIGHTS_TERM_REC_BYTES + U32, true),
  });
  const frames: WeightFrame[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const base = WEIGHTS_HEADER_BYTES + i * WEIGHTS_FRAME_REC_BYTES;
    const idOff = dv.getUint32(base + FRAME.idOff, true);
    const idLen = dv.getUint32(base + FRAME.idLen, true);
    const displayOff = dv.getUint32(base + FRAME.dispOff, true);
    const displayLen = dv.getUint32(base + FRAME.dispLen, true);
    const logit = dv.getFloat64(base + FRAME.logit, true);
    const termStartIdx = dv.getUint32(base + FRAME.termStart, true);
    const count = dv.getUint32(base + FRAME.termCount, true);
    const terms: { off: number; len: number; text: string }[] = [];
    for (let t = 0; t < count && termStartIdx + t < termCount; t += 1) {
      const rec = termRec(termStartIdx + t);
      terms.push({ off: rec.off, len: rec.len, text: textAt(rec.off, rec.len) });
    }
    frames.push({
      id: textAt(idOff, idLen),
      display: textAt(displayOff, displayLen),
      logit,
      terms,
    });
  }
  return { frames, textBlob: bytes.slice(textOff, textOff + textLen) };
};

// ── Normalize (JS owns case/diacritics; the kernel owns byte boundaries) ─────
const NORMALIZE_MARKS = /\p{M}+/gu;
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;

export const normalizeText = (raw: string): string =>
  raw
    .normalize('NFKD')
    .replace(NORMALIZE_MARKS, '')
    .toLowerCase()
    .replace(NON_WORD_RUN, ' ')
    .trim()
    .replace(/\s+/g, ' ');

/** JS reference of the kernel law (verification suites cross-check the machine
 *  against this — never blend, prove). Boundary = not [0-9A-Za-z]/≥0x80 byte. */
export const matchPhraseReference = (haystack: string, needle: string): boolean => {
  if (needle.length === 0) return false;
  let from = 0;
  const isWordChar = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);
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

/** The scoring machine — wasm exports behind the layout contract. */
export interface Kernel {
  readonly memory: WebAssembly.Memory;
  readonly matchPtr: (
    textPtr: number,
    textLen: number,
    needlePtr: number,
    needleLen: number,
  ) => number;
}

export interface FrameEvidence {
  readonly frameId: string;
  readonly display: string;
  /** Prior-logit step per matched term — register marker (chaff < 1.0). */
  readonly logit: number;
  readonly z: number;
  readonly posterior: number;
  readonly matchedTerms: readonly string[];
}

const encoder = new TextEncoder();
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Forward pass over one mission's normalized corpus. The kernel decides every
 * candidate term IN WASM (needle staged at NEEDLE_BASE once per session via
 * prepareNeedles); evidence accumulates prior logits per hit; sort is total +
 * deterministic (z desc, id asc — replay/redelivery idempotence).
 */
export const forwardPass = (
  kernel: Kernel,
  weights: ParsedWeights,
  normalizedCorpus: string,
): readonly FrameEvidence[] => {
  const memoryBytes = new Uint8Array(kernel.memory.buffer);
  const textBytes = encoder.encode(normalizedCorpus);
  const textCap = kernel.memory.buffer.byteLength - TEXT_PTR;
  if (textBytes.length > textCap) return [];
  memoryBytes.set(textBytes, TEXT_PTR);
  const evidence: FrameEvidence[] = [];
  for (const frame of weights.frames) {
    const matched: string[] = [];
    for (const term of frame.terms) {
      const at = kernel.matchPtr(TEXT_PTR, textBytes.length, NEEDLE_BASE + term.off, term.len);
      if (at >= 0) matched.push(term.text);
    }
    if (matched.length === 0) continue;
    const z = matched.length * frame.logit;
    evidence.push({
      frameId: frame.id,
      display: frame.display,
      logit: frame.logit,
      z,
      posterior: sigmoid(z),
      matchedTerms: matched,
    });
  }
  return evidence.sort((a, b) => b.z - a.z || a.frameId.localeCompare(b.frameId));
};

/** Stage the lexicon needles into wasm memory (once per model instance). The
 *  blob is part of the model bytes — staging is a memory copy, never a fetch. */
export const prepareNeedles = (kernel: Kernel, weights: ParsedWeights): void => {
  new Uint8Array(kernel.memory.buffer).set(weights.textBlob, NEEDLE_BASE);
};

export interface CalibratedName {
  readonly value: string;
  readonly confidence: number;
  /** The dual mate's frame id when the name is dual (E8-T04 summaries recap
   *  anchor terms from exact frames, never re-derived guesses). */
  readonly dualWith?: string | undefined;
  readonly posteriors: readonly { frameId: string; posterior: number }[];
}

/** Calibration constants (E8-T03 ADR note): policy, pinned, shadow-evidenced —
 *  never tuned per-mission. */
export const ONDEVICE_ACCEPT_POSTERIOR = 0.6;
export const ONDEVICE_DUAL_MARGIN = 0.12;
/** Dual assembly is reserved for mission-grade stories ("two anchors, one
 *  mission"). Chaff-register frames (logit < MISSION_GRADE_LOGIT) may NAME only
 *  when they are the entire story — never borrow half a dual name. */
export const MISSION_GRADE_LOGIT = 1.0;
const CONFIDENCE_SHARP = 0.9;
const STAMP_HIGH_SHARP = 0.88;
const STAMP_HIGH = 0.85;
const STAMP_MID = 0.72;
const STAMP_FLOOR = 0.64;

const stampFor = (posterior: number, dual: boolean): number => {
  if (posterior >= CONFIDENCE_SHARP && dual) return STAMP_HIGH_SHARP;
  if (posterior >= CONFIDENCE_SHARP) return STAMP_HIGH;
  if (posterior >= ONDEVICE_ACCEPT_POSTERIOR) return STAMP_MID;
  return STAMP_FLOOR;
};

/** Assemble the calibrated name, or null when evidence is thin (the YIELD law:
 *  null is never an error and never counts against the breaker — the ladder
 *  takes the next rung). */
export const calibrate = (
  evidence: readonly FrameEvidence[],
  tabCount: number,
): CalibratedName | null => {
  const top = evidence[0];
  if (top === undefined) return null;
  if (top.posterior < ONDEVICE_ACCEPT_POSTERIOR) return null;
  // Dual mate: the nearest MISSION-GRADE frame after the top, subject to the
  // margin. Chaff frames between them are evidence (in posteriors) but never
  // wear half a mission name. A chaff top cannot dual at all.
  const mate =
    top.logit >= MISSION_GRADE_LOGIT
      ? evidence
          .slice(1)
          .find(
            (e) =>
              e.logit >= MISSION_GRADE_LOGIT && top.posterior - e.posterior < ONDEVICE_DUAL_MARGIN,
          )
      : undefined;
  const value =
    mate !== undefined
      ? `${top.display} & ${mate.display} · ${tabCount} tabs`
      : `${top.display} · ${tabCount} tabs`;
  return {
    value,
    confidence: stampFor(top.posterior, mate !== undefined),
    ...(mate !== undefined ? { dualWith: mate.frameId } : {}),
    posteriors: evidence.map((e) => ({ frameId: e.frameId, posterior: e.posterior })),
  };
};

// Model version stamped into every artifact the provider emits.
export const ONDEVICE_MODEL_V = MODEL_V;
