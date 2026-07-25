// E1-T06 · FNV-1a 64-bit — cheap, deterministic matching hash for canon forms.
// NOT cryptographic: used for indexing only. Collision safety law: dedupe/matching code
// must ALWAYS confirm equality against the full canonForm, never the hash alone.
const OFFSET_BASIS = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const HASH_BITS = 64;
const HEX_PAD = 16;
const HEX_BASE = 16;

/** FNV-1a over UTF-16 code units (platform-stable in every Ledge context). */
export function fnv1a64(text: string): string {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(HASH_BITS, hash * FNV_PRIME);
  }
  return hash.toString(HEX_BASE).padStart(HEX_PAD, '0');
}
