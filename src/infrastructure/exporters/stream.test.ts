// E5-T03 · Verifying-assembler laws (EES §6 ExportRendererPort error row:
// E_RENDER_CHUNK → regen ×2 → E_RENDER_FATAL; "never silent-partial" — §2.14).
// Corruption rides the chunk seam (the exact boundary the offscreen transport
// becomes); production renderers stay pure and never carry a sabotage hook.
import { describe, expect, it } from 'vitest';
import { crc32Hex } from '@/shared-kernel/canon/index.js';
import {
  assembleVerified,
  chunkOk,
  MANIFEST_PART_ID,
  REGEN_ATTEMPTS,
  streamParts,
  type RawPart,
  type RenderChunk,
} from './stream.js';

const PARTS: readonly RawPart[] = [
  { partId: 'head', text: '{\n  "missions": [\n' },
  { partId: 'mission:m1', text: '    {"missionId":"m1"}\n' },
  { partId: 'tail', text: ']\n' },
  { partId: MANIFEST_PART_ID, text: '  "manifest": {}\n}\n' },
];

const assemble = (produce?: () => AsyncGenerator<RenderChunk, void, undefined>) =>
  assembleVerified('json', produce ?? (() => streamParts(PARTS)));

/** Wrap a chunk source with a per-attempt corrupter (attempt = render run). */
const corrupting = (
  seqToHit: number,
  attemptsToHit: ReadonlySet<number>,
): (() => AsyncGenerator<RenderChunk, void, undefined>) => {
  let attempt = 0;
  return async function* () {
    attempt += 1;
    const inner = streamParts(PARTS);
    for await (const chunk of inner) {
      if (chunk.seq === seqToHit && attemptsToHit.has(attempt)) {
        yield { ...chunk, text: `${chunk.text} tampered` };
      } else {
        yield chunk;
      }
    }
  };
};

describe('E5 stream · chunk-verify-then-present', () => {
  it('chunkOk is the honest re-computation (accepts genuine, refuses tampered)', () => {
    const genuine: RenderChunk = { seq: 0, partId: 'p', text: 'abc', checksum: crc32Hex('abc') };
    expect(chunkOk(genuine)).toBe(true);
    expect(chunkOk({ ...genuine, checksum: crc32Hex('xyz') })).toBe(false);
  });

  it('a clean stream assembles text and seals the manifest over DATA parts only', async () => {
    const r = await assemble();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe(PARTS.map((p) => p.text).join(''));
    expect(r.value.manifest.parts.map((p) => p.partId)).toEqual(['head', 'mission:m1', 'tail']);
    expect(r.value.manifest.partCount).toBe(3);
    expect(r.value.manifest.parts.every((p) => /^[0-9a-f]{8}$/.test(p.checksum))).toBe(true);
    expect(r.value.manifest.manifestChecksum).toMatch(/^[0-9a-f]{8}$/);
    expect(r.value.manifest.totalBytes).toBeGreaterThan(0);
  });

  it('transient transport corruption rides regen transparently (E_RENDER_CHUNK path)', async () => {
    const r = await assemble(corrupting(1, new Set([1])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe(PARTS.map((p) => p.text).join(''));
  });

  it('source-persistent corruption is E_RENDER_FATAL after regen ×2 — never a partial', async () => {
    const r = await assemble(corrupting(1, new Set([1, 2, REGEN_ATTEMPTS + 1])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_RENDER_FATAL');
    expect(r.error.details?.['fault']).toBe('chunk-checksum-regen-exhausted');
    expect(r.error.details?.['partId']).toBe('mission:m1');
    expect(r.error.retryable).toBe(false);
  });

  it('regen budget arithmetic: corrupting exactly REGEN_ATTEMPTS times still presents', async () => {
    const hits = new Set<number>();
    for (let i = 1; i <= REGEN_ATTEMPTS; i += 1) hits.add(i);
    const r = await assemble(corrupting(0, hits));
    expect(r.ok).toBe(true);
  });
});
