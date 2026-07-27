// E8-T03 · model loader — the anti-tamper law for shipped bytes: digest-verify
// (in-repo SRI over WebCrypto), WebAssembly.validate, instantiate, parse the
// weight table through strict layout, stage the needles. Any failure is a
// typed capability absence (the caller degrades invisibly), never a throw.
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import {
  FRAME_KERNEL_SHA256,
  FRAME_KERNEL_WASM_B64,
  WEIGHTS_BIN_B64,
  WEIGHTS_SHA256,
} from './model/index.js';
import { NEEDLE_BASE, TEXT_PTR } from './model-layout.js';
import { parseWeights, prepareNeedles, type Kernel, type ParsedWeights } from './score.js';

export interface OnDeviceModel {
  readonly kernel: Kernel;
  readonly weights: ParsedWeights;
}

/** Capability seam — production binds the ambient engine; tests negate it. */
export interface OnDeviceModelHost {
  readonly hasWebAssembly: boolean;
  readonly digest?: ((bytes: Uint8Array) => Promise<string>) | undefined;
}

const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/** TS 5.7 typed-array generics: WebCrypto wants Uint8Array<ArrayBuffer>; give it
 *  a provably-whole fresh copy instead of swapping type lies for speed. */
const asBufferSource = (bytes: Uint8Array): BufferSource => {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
};

const HEX_BASE = 16;
const HEX_PAIR = 2;

const defaultDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(HEX_BASE).padStart(HEX_PAIR, '0'))
    .join('');
};

const absence = (what: string): LedgeError =>
  ledgeError('E_CAPABILITY', { what, provider: 'ondevice' });

/**
 * Load + verify. Single-purpose and memoization-free by design: callers memoize
 * (the provider factory pins one instance per graph; the load is ~1ms of real
 * work and MUST re-fail identically on capability-negation probes).
 */
export const loadOnDeviceModel = async (
  host: OnDeviceModelHost,
): Promise<Result<OnDeviceModel, LedgeError>> => {
  if (!host.hasWebAssembly) return err(absence('webassembly-absent'));
  const digest = host.digest ?? defaultDigest;
  const kernelBytes = fromB64(FRAME_KERNEL_WASM_B64);
  const kernelDigest = await digest(kernelBytes);
  if (kernelDigest !== FRAME_KERNEL_SHA256) {
    return err(absence('kernel-digest-mismatch'));
  }
  if (!WebAssembly.validate(asBufferSource(kernelBytes))) {
    return err(absence('kernel-invalid'));
  }
  let instance: WebAssembly.Instance;
  try {
    const built = await WebAssembly.instantiate(asBufferSource(kernelBytes), {});
    instance = built.instance;
  } catch {
    return err(absence('kernel-instantiate-failed'));
  }
  const exportsMap = instance.exports as Record<string, unknown>;
  const memory = exportsMap['memory'];
  const matchPtr = exportsMap['match_ptr'];
  if (!(memory instanceof WebAssembly.Memory) || typeof matchPtr !== 'function') {
    return err(absence('kernel-abi-mismatch'));
  }
  const weightsBytes = fromB64(WEIGHTS_BIN_B64);
  const weightsDigest = await digest(weightsBytes);
  if (weightsDigest !== WEIGHTS_SHA256) return err(absence('weights-digest-mismatch'));
  let weights: ParsedWeights;
  try {
    weights = parseWeights(weightsBytes);
  } catch {
    return err(absence('weights-parse-failed'));
  }
  // Staging law: needles live [NEEDLE_BASE, TEXT_PTR) — never into corpus space.
  if (NEEDLE_BASE + weights.textBlob.length > TEXT_PTR) {
    return err(absence('kernel-memory-layout-violation'));
  }
  const kernel: Kernel = { memory, matchPtr: matchPtr as Kernel['matchPtr'] };
  prepareNeedles(kernel, weights);
  return ok({ kernel, weights });
};
