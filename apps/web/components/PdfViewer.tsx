'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BoundingBox } from '@pdfreader/shared-types';
import { openPdf } from '@/lib/pdf';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './PdfViewer.module.css';

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Pages this far outside the viewport are rendered ahead of time. */
const RENDER_MARGIN = '600px';

export function PdfViewer() {
  const fileBytes = useDocumentStore((state) => state.fileBytes);
  const pages = useDocumentStore((state) => state.pages);
  const currentPage = useDocumentStore((state) => state.currentPage);
  const setCurrentPage = useDocumentStore((state) => state.setCurrentPage);
  const sentences = useDocumentStore((state) => state.sentences);
  const activeSentenceId = usePlaybackStore((state) => state.activeSentenceId);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showSourceRegions, setShowSourceRegions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fileBytes) return;
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;

    // PDF.js takes ownership of the buffer it is given, so hand it a copy and
    // keep the store's own bytes intact.
    openPdf({ data: fileBytes.slice(0) })
      .then((loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        destroy = loaded.destroy;
        setDoc(loaded.doc);
        setLoadError(null);
      })
      .catch((error) => {
        if (!cancelled) setLoadError((error as Error).message);
      });

    return () => {
      cancelled = true;
      void destroy?.();
      setDoc(null);
    };
  }, [fileBytes]);

  const activeBoxes = useMemo(() => {
    if (!activeSentenceId || !showSourceRegions) return [];
    return sentences.find((sentence) => sentence.id === activeSentenceId)?.boundingBoxes ?? [];
  }, [activeSentenceId, sentences, showSourceRegions]);

  // Follow the spoken sentence to its page.
  useEffect(() => {
    if (activeBoxes.length === 0) return;
    const page = activeBoxes[0].pageNumber;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-page-container="${page}"]`,
    );
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeBoxes]);

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(page);
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-page-container="${page}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [setCurrentPage],
  );

  if (loadError) {
    return (
      <div className={styles.error} role="alert">
        <p>{loadError}</p>
      </div>
    );
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <div className={styles.pageControls}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            Previous page
          </button>
          <span className={styles.pageIndicator} aria-live="polite">
            Page {currentPage} of {pages.length || '—'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= pages.length}
          >
            Next page
          </button>
        </div>

        <div className={styles.zoomControls}>
          <label className="sr-only" htmlFor="zoom-select">
            Zoom level
          </label>
          <select
            id="zoom-select"
            className={styles.select}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {Math.round(level * 100)}%
              </option>
            ))}
          </select>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={showSourceRegions}
              onChange={(event) => setShowSourceRegions(event.target.checked)}
            />
            Highlight source
          </label>
        </div>
      </div>

      <div ref={scrollRef} className={styles.scroll}>
        {doc ? (
          pages.map((page) => (
            <PdfPage
              key={page.pageNumber}
              doc={doc}
              pageNumber={page.pageNumber}
              zoom={zoom}
              boxes={activeBoxes.filter((box) => box.pageNumber === page.pageNumber)}
              onVisible={() => setCurrentPage(page.pageNumber)}
            />
          ))
        ) : (
          <p className={styles.loading}>Rendering pages…</p>
        )}
      </div>
    </div>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  boxes: BoundingBox[];
  onVisible: () => void;
}

/**
 * One lazily-rendered page.
 *
 * The canvas is only painted once the page approaches the viewport, and it is
 * released when the page scrolls far away, so a long document does not hold a
 * bitmap for every page at once.
 */
function PdfPage({ doc, pageNumber, zoom, boxes, onVisible }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) onVisible();
        }
      },
      { rootMargin: RENDER_MARGIN, threshold: [0, 0.5] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: zoom });
      setSize({ width: viewport.width, height: viewport.height });

      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.scale(ratio, ratio);

      const render = page.render({ canvas, canvasContext: context, viewport });
      task = render;
      try {
        await render.promise;
      } catch {
        // A cancelled render is normal when scrolling quickly.
      }
      page.cleanup();
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, zoom, visible]);

  // Release the bitmap when the page moves far out of view.
  useEffect(() => {
    if (visible) return;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className={styles.pageContainer}
      data-page-container={pageNumber}
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-label={`Page ${pageNumber}`} />

      {size &&
        boxes.map((box, index) => (
          <div
            key={index}
            className={styles.sourceHighlight}
            style={{
              left: box.x * zoom,
              // PDF coordinates grow upward; the viewport grows downward.
              top: size.height - (box.y + box.height) * zoom,
              width: box.width * zoom,
              height: box.height * zoom,
            }}
          />
        ))}

      <span className={styles.pageLabel}>{pageNumber}</span>
    </div>
  );
}
