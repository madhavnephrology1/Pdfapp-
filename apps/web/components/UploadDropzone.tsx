'use client';

import { useCallback, useRef, useState } from 'react';
import { useDocumentStore } from '@/stores/document-store';
import styles from './UploadDropzone.module.css';

const MAX_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB ?? '100');

export function UploadDropzone() {
  const openFile = useDocumentStore((state) => state.openFile);
  const setError = useDocumentStore((state) => state.setError);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (file.size > MAX_MB * 1024 * 1024) {
        setError({
          title: 'That file is too large',
          message: `"${file.name}" is ${(file.size / 1_048_576).toFixed(0)} MB. This deployment accepts up to ${MAX_MB} MB.`,
          recovery: 'Split the document, or raise the limit if you run this yourself.',
          retryable: true,
        });
        return;
      }
      await openFile(file);
    },
    [openFile, setError],
  );

  return (
    <div className={styles.wrapper}>
      <div
        className={`${styles.zone} ${dragging ? styles.dragging : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void accept(event.dataTransfer.files[0]);
        }}
      >
        <h1 className={styles.title}>Listen to a PDF</h1>
        <p className={styles.lede}>
          Drop a PDF here to hear its meaningful text read aloud. Running headers, footers and page
          numbers are left out; every spoken sentence stays word for word as the author wrote it.
        </p>

        <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
          Choose a PDF
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label="Choose a PDF file to read"
          onChange={(event) => {
            void accept(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        <p className={styles.limit}>
          PDF files up to {MAX_MB} MB. Nothing is uploaded automatically.
        </p>
      </div>

      <ul className={styles.assurances}>
        <li>
          <strong>Your document stays in your browser.</strong> The file is read and processed
          locally. Only the text of the passage being spoken is sent to a speech provider, and only
          if you choose one.
        </li>
        <li>
          <strong>Nothing is summarised or reworded.</strong> The reader speaks the document’s own
          sentences. It will not paraphrase, correct grammar, or fill in text that is not there.
        </li>
        <li>
          <strong>Every exclusion is visible and reversible.</strong> Content Review lists what was
          left out, why, and how confident the detection was.
        </li>
      </ul>
    </div>
  );
}
