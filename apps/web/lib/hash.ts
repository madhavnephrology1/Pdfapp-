/**
 * Deterministic, dependency-free hashing.
 *
 * Used for chunk hashes, cache keys and document fingerprints. It must produce
 * identical output in the browser, in a Web Worker and in Node so that cache
 * keys computed on the client match those the API caches under.
 *
 * This is a non-cryptographic hash. It is used only for cache addressing and
 * change detection, never for authentication or integrity guarantees.
 */

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over UTF-8 bytes, returned as 16 lowercase hex characters. */
export function hash64(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Combines several fields into one stable key. Fields are length-prefixed so
 *  that ("ab","c") and ("a","bc") never collide. */
export function compositeKey(...fields: (string | number)[]): string {
  return fields.map((f) => `${String(f).length}:${String(f)}`).join('|');
}
