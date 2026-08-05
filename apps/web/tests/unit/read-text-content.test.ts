import { describe, expect, it } from 'vitest';
import { readTextContent } from '@/lib/pdf';

/**
 * The failure this guards against was reported from an iPhone: every page of a
 * fifteen-page document failed with "undefined is not a function (near '...t of
 * e...')" — PDF.js's `getTextContent()` doing `for await (const value of
 * readableStream)` on a browser that does not implement
 * `ReadableStream.prototype[Symbol.asyncIterator]`.
 *
 * Node and Chromium both implement it, so a test cannot fail the way Safari
 * does by accident. It has to be made to: the stream stand-in below has a
 * `getReader` and deliberately **no** async iterator, exactly like Safari's.
 */
interface Chunk {
  items: unknown[];
  styles: Record<string, unknown>;
  lang: string | null;
}

function safariLikeStream(chunks: Chunk[]): ReadableStream<Chunk> {
  let index = 0;
  let locked = false;
  const stream = {
    getReader() {
      locked = true;
      return {
        read: () =>
          Promise.resolve(
            index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
          ),
        releaseLock: () => {
          locked = false;
        },
      };
    },
    get locked() {
      return locked;
    },
  };
  // Prove the object really lacks what PDF.js relies on.
  expect((stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBeUndefined();
  return stream as unknown as ReadableStream<Chunk>;
}

const pageWith = (chunks: Chunk[]) => ({ streamTextContent: () => safariLikeStream(chunks) });

describe('readTextContent', () => {
  it('reads a stream that has no async iterator', async () => {
    const content = await readTextContent(
      pageWith([
        { items: [{ str: 'one' }], styles: { a: 1 }, lang: 'en' },
        { items: [{ str: 'two' }], styles: { b: 2 }, lang: 'fr' },
      ]),
    );

    expect(content.items).toEqual([{ str: 'one' }, { str: 'two' }]);
    expect(content.styles).toEqual({ a: 1, b: 2 });
  });

  it('keeps items in the order the stream produced them', async () => {
    const content = await readTextContent(
      pageWith([
        { items: [{ str: 'a' }, { str: 'b' }], styles: {}, lang: null },
        { items: [{ str: 'c' }], styles: {}, lang: null },
      ]),
    );

    expect(content.items.map((item) => (item as { str: string }).str)).toEqual(['a', 'b', 'c']);
  });

  it('takes the first language reported and does not overwrite it', async () => {
    const content = await readTextContent(
      pageWith([
        { items: [], styles: {}, lang: 'en' },
        { items: [], styles: {}, lang: 'de' },
      ]),
    );

    expect(content.lang).toBe('en');
  });

  it('leaves lang null when no chunk reports one', async () => {
    const content = await readTextContent(pageWith([{ items: [], styles: {}, lang: null }]));
    expect(content.lang).toBeNull();
  });

  it('returns an empty result for a stream with no chunks', async () => {
    const content = await readTextContent(pageWith([]));
    expect(content.items).toEqual([]);
    expect(content.lang).toBeNull();
  });

  it('releases the reader so the page can be cleaned up', async () => {
    const stream = safariLikeStream([{ items: [], styles: {}, lang: null }]);
    await readTextContent({ streamTextContent: () => stream });
    expect(stream.locked).toBe(false);
  });
});
