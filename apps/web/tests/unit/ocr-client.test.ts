import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OCRClientError, recognizePage } from '@/lib/ocr-client';

/**
 * The consent gate, from the browser's side.
 *
 * The API refuses a request without consent as well, so this is the second of
 * two locks rather than the only one. It exists because the first thing that
 * must be true of a privacy control is that a bug in the interface cannot put
 * the document on the wire anyway.
 */

const params = {
  image: 'aW1hZ2U=',
  mimeType: 'image/png',
  pageNumber: 2,
  documentId: 'doc-1',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

describe('sending a page for recognition', () => {
  it('sends nothing at all without consent', async () => {
    await expect(recognizePage({ ...params, consent: false })).rejects.toBeInstanceOf(
      OCRClientError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says plainly that the image was not sent', async () => {
    const error = await recognizePage({ ...params, consent: false }).catch((e) => e);
    expect(error.normalized.message).toContain('was not sent');
    expect(error.normalized.retryable).toBe(false);
  });

  it('sends the image and the consent flag when consent was given', async () => {
    fetchMock.mockReturnValue(ok({ pageNumber: 2, words: [], text: '' }));
    await recognizePage({ ...params, consent: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.consent).toBe(true);
    expect(body.image).toBe('aW1hZ2U=');
    expect(body.pageNumber).toBe(2);
  });

  it('never puts the signal in the request body', async () => {
    fetchMock.mockReturnValue(ok({ pageNumber: 2, words: [], text: '' }));
    const controller = new AbortController();
    await recognizePage({ ...params, consent: true, signal: controller.signal });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).signal).toBeUndefined();
  });

  it('surfaces the API’s normalized error', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({
            code: 'rate_limited',
            message: 'Too many pages at once.',
            recovery: 'Wait a moment.',
          }),
      } as Response),
    );
    const error = await recognizePage({ ...params, consent: true }).catch((e) => e);
    expect(error).toBeInstanceOf(OCRClientError);
    expect(error.normalized.code).toBe('rate_limited');
    expect(error.normalized.recovery).toBe('Wait a moment.');
  });

  it('never surfaces a response body it could not parse', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        json: () => Promise.reject(new Error('<html>provider detail</html>')),
      } as unknown as Response),
    );
    const error = await recognizePage({ ...params, consent: true }).catch((e) => e);
    expect(error.normalized.message).not.toContain('provider detail');
    expect(error.normalized.code).toBe('provider_unavailable');
  });

  it('reports an unreachable service rather than throwing a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await recognizePage({ ...params, consent: true }).catch((e) => e);
    expect(error).toBeInstanceOf(OCRClientError);
    expect(error.normalized.retryable).toBe(true);
  });

  it('lets an abort through unchanged, so a cancelled page is not an error', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    await expect(recognizePage({ ...params, consent: true })).rejects.toBe(abort);
  });
});
