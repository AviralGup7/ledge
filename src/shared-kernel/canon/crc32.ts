// CRC-32 (ISO-HDLC, reflected poly 0xEDB88320) — ADR-004's segment checksum, shared from
// the kernel so the journal (E2-T01) and exporter chunk-verify (§2.14) use one function.
// Threat model per ADR-004/020: accident detection (bit-rot, torn writes), not adversarial
// tamper resistance. Table-driven; pure arithmetic over UTF-8 bytes — no IO, no clocks.
const POLY_REFLECTED = 0xedb88320;
const TABLE_SIZE = 256;
const BYTE_MASK = 0xff;
const SPIN_BITS = 8;
const LOW_BIT = 1;
const INIT = 0xffffffff;
const HEX_RADIX = 16;
export const CRC32_HEX_LENGTH = 8;

const TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < TABLE_SIZE; n += 1) {
    let c = n;
    for (let k = 0; k < SPIN_BITS; k += 1) {
      c = (c & LOW_BIT) !== 0 ? (c >>> LOW_BIT) ^ POLY_REFLECTED : c >>> LOW_BIT;
    }
    table.push(c >>> 0);
  }
  return table;
})();

/** CRC-32 of the UTF-8 byte image of `text`, rendered as 8 lowercase hex chars. */
export function crc32Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let crc = INIT;
  for (const byte of bytes) {
    // TABLE covers every byte value 0..255 by construction; the ?? 0 is a
    // noUncheckedIndexedAccess satisfier, not a reachable branch.
    crc = (TABLE[(crc ^ byte) & BYTE_MASK] ?? 0) ^ (crc >>> SPIN_BITS);
  }
  return ((crc ^ INIT) >>> 0).toString(HEX_RADIX).padStart(CRC32_HEX_LENGTH, '0');
}
