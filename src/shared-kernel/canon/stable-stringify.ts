// E1-T06 canon family · deterministic JSON for hash/CRC inputs. Keys sorted recursively
// so structurally-equal values serialize byte-identically regardless of source key order
// (registry diffs and journal CRC images depend on that). undefined/function tails drop
// to 'null' — a stable, total rendering, matching JSON.stringify's own value coercion.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
