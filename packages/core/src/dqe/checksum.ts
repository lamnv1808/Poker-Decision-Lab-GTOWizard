/** FNV-1a 32-bit over a string: a small, dependency-free, deterministic content checksum (browser + node). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

/** Checksum of numeric arrays at fixed precision, so equal data gives equal checksums everywhere. */
export function checksumNumbers(...arrays: ArrayLike<number>[]): string {
  return fnv1a(arrays.map((a) => Array.from(a, (x) => x.toFixed(6)).join(',')).join('|'));
}
