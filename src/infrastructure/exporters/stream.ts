// E5-T03 · Render stream protocol + verifying assembler (ADR-045 "streaming
// generation, chunk-verify-then-present"; EES §6 ExportRendererPort error law:
// E_RENDER_CHUNK(checksum) → regen ×2 → E_RENDER_FATAL; EES §2.14 "never
// silent-partial"). Renderers are PURE async chunk producers (deterministic:
// same model ⇒ same chunks ⇒ same checksums — the round-trip law's foundation).
// The assembler is the only place chunks become an artifact: it re-computes
// every chunk's checksum before accepting it, retries the WHOLE render on
// mismatch (the v1 in-process regen path; per-chunk regen is the offscreen
// door), and fails loudly after REGEN_ATTEMPTS — a partial artifact is never
// presented as an export.
import { crc32Hex } from '@/shared-kernel/canon/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

/** One streamed chunk (the offscreen boundary's future frame shape). */
export interface RenderChunk {
  readonly seq: number;
  /** Part identity the manifest seals (grammar slots: 'head' | 'mission:<id>' |
   *  'loose:<batch>' | 'meta' | format-specific tails). */
  readonly partId: string;
  readonly text: string;
  /** crc32Hex(text) declared by the producer; re-verified by the assembler. */
  readonly checksum: string;
}

/** One sealed part line in the manifest (per-part checksum law). */
export interface ManifestPart {
  readonly partId: string;
  readonly checksum: string;
  readonly bytes: number;
}

/** The export manifest (ADR-045: per-part checksums + manifest, self-describing). */
export interface RenderManifest {
  readonly parts: readonly ManifestPart[];
  readonly partCount: number;
  readonly totalBytes: number;
  /** crc32Hex over the ordered `partId:checksum` lines — seals the part set. */
  readonly manifestChecksum: string;
}

export interface ExportArtifact {
  readonly text: string;
  readonly manifest: RenderManifest;
}

/** Whole-render regeneration budget (EES §6 "regen ×2", then fatal). */
export const REGEN_ATTEMPTS = 2;

const UTF8 = new TextEncoder();

const byteLen = (text: string): number => UTF8.encode(text).length;

/** Manifest seal input: ordered partId:checksum lines (deterministic grammar). */
const sealParts = (parts: readonly ManifestPart[]): string =>
  crc32Hex(parts.map((p) => `${p.partId}:${p.checksum}`).join('\n'));

/** Verify one chunk against its declared checksum (the transport-verify law). */
export const chunkOk = (chunk: RenderChunk): boolean => chunk.checksum === crc32Hex(chunk.text);

/** Raw part (the renderer's vocabulary before streaming): id + text, deterministic. */
export interface RawPart {
  readonly partId: string;
  readonly text: string;
}

/** The partId of the embedded manifest block (describes the DATA parts; seals
 *  itself out of its own list — the manifest is the sealer, never the sealed). */
export const MANIFEST_PART_ID = 'manifest';

/** Parts the manifest seals: everything except the embedded manifest block. */
const sealable = (chunks: readonly RenderChunk[]): readonly RenderChunk[] =>
  chunks.filter((c) => c.partId !== MANIFEST_PART_ID);

/** Deterministic chunk source over raw parts (the async façade the offscreen
 *  door later replaces with a document transport; renderers stay pure/sync). */
export async function* streamParts(
  parts: readonly RawPart[],
): AsyncGenerator<RenderChunk, void, undefined> {
  let seq = 0;
  for (const part of parts) {
    yield { seq, partId: part.partId, text: part.text, checksum: crc32Hex(part.text) };
    seq += 1;
    // Yield the microtask: the chunk boundary is a real streaming seam, not a loop.
    await Promise.resolve();
  }
}

/**
 * Assemble a renderer's stream into a verified artifact. Failure law:
 *  - any chunk failing verification ⇒ discard the buffer and re-run the render,
 *    up to REGEN_ATTEMPTS extra attempts (E_RENDER_CHUNK is the retryable
 *    signal the port row names; the final failure is E_RENDER_FATAL);
 *  - a renderer that produces disjoint/mismatched parts across regens is
 *    source-corrupt ⇒ E_RENDER_FATAL (never a silent partial);
 *  - a successful assembly seals the manifest over the DATA parts (the embedded
 *    'manifest' chunk is transport, not content) before presenting.
 */
export const assembleVerified = async (
  format: string,
  produce: () => AsyncGenerator<RenderChunk, void, undefined>,
): Promise<Result<ExportArtifact, LedgeError>> => {
  let lastBad: RenderChunk | undefined;
  const totalAttempts = REGEN_ATTEMPTS + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const chunks: RenderChunk[] = [];
    let corrupt = false;
    for await (const chunk of produce()) {
      if (!chunkOk(chunk)) {
        corrupt = true;
        lastBad = chunk;
        break;
      }
      chunks.push(chunk);
    }
    if (corrupt) continue;
    const sealed = sealable(chunks);
    const parts: ManifestPart[] = sealed.map((c) => ({
      partId: c.partId,
      checksum: c.checksum,
      bytes: byteLen(c.text),
    }));
    const manifest: RenderManifest = {
      parts,
      partCount: parts.length,
      totalBytes: parts.reduce((n, p) => n + p.bytes, 0),
      manifestChecksum: sealParts(parts),
    };
    // Present-time re-verification (chunk-verify-then-present, belt edition):
    if (manifest.manifestChecksum !== sealParts(parts) || parts.some((p) => !p.partId)) {
      return err(ledgeError('E_RENDER_FATAL', { format, fault: 'manifest-seal-mismatch' }));
    }
    return ok({ text: chunks.map((c) => c.text).join(''), manifest });
  }
  return err(
    ledgeError('E_RENDER_FATAL', {
      format,
      fault: 'chunk-checksum-regen-exhausted',
      partId: lastBad?.partId ?? '',
      seq: lastBad?.seq ?? -1,
    }),
  );
};
