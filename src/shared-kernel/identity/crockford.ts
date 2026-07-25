// E1-T04 · EES §2.1 — Crockford base32 (ULID alphabet). Pure encode/decode; format frozen forever.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;
export const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;

/** Encode a non-negative integer of at most `chars*5` bits into a fixed-width Crockford string. */
export function encodeBig(value: number, chars: number): string {
  let v = value;
  let out = '';
  for (let i = 0; i < chars; i++) {
    out = ENCODING[v % ENCODING.length] + out;
    v = Math.floor(v / ENCODING.length);
  }
  if (v !== 0) throw new TypeError(`value ${value} does not fit into ${chars} base32 chars`);
  return out;
}

/** Encode raw bytes left-to-right into a fixed-width Crockford string (fractional trailing bits are zero-padded). */
export function encodeBytes(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bitsLeft = 0;
  let i = 0;
  while (out.length < chars) {
    if (bitsLeft < BITS_PER_CHAR) {
      buffer = (buffer << BITS_PER_BYTE) | (bytes[i] ?? 0);
      bitsLeft += BITS_PER_BYTE;
      i++;
    }
    bitsLeft -= BITS_PER_CHAR;
    out += ENCODING[(buffer >> bitsLeft) & (ENCODING.length - 1)];
  }
  return out;
}

/** Decode a fixed-width Crockford string back to its integer value. */
export function decodeBig(text: string): number {
  let v = 0;
  for (const ch of text) {
    const idx = ENCODING.indexOf(ch);
    if (idx === -1) throw new TypeError(`invalid Crockford character: ${ch}`);
    v = v * ENCODING.length + idx;
  }
  return v;
}
