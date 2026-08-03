import { compositeKey, hash64 } from './hash';

/**
 * Document fingerprint.
 *
 * Derived from the file's size and sampled content so that reopening the same
 * PDF restores the same reading position. Sampling the head, middle and tail
 * rather than the whole file keeps this fast for large documents while still
 * distinguishing documents that share a size.
 *
 * The fingerprint never leaves the browser. It is not a content hash and must
 * not be used as one.
 */

const SAMPLE_BYTES = 64 * 1024;

export async function fingerprintFile(file: File): Promise<string> {
  const size = file.size;
  const slices: Blob[] = [];

  if (size <= SAMPLE_BYTES * 3) {
    slices.push(file);
  } else {
    const middle = Math.floor(size / 2 - SAMPLE_BYTES / 2);
    slices.push(file.slice(0, SAMPLE_BYTES));
    slices.push(file.slice(middle, middle + SAMPLE_BYTES));
    slices.push(file.slice(size - SAMPLE_BYTES));
  }

  const parts: string[] = [];
  for (const slice of slices) {
    parts.push(hash64(new Uint8Array(await slice.arrayBuffer())));
  }

  // The name is included so two copies of the same bytes under different names
  // keep separate reading positions, which is what users expect.
  return hash64(compositeKey(String(size), file.name, ...parts));
}

/** A stable, URL-safe document id derived from the fingerprint. */
export const documentIdFor = (fingerprint: string): string => `doc-${fingerprint.slice(0, 12)}`;
