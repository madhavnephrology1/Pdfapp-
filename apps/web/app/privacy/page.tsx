import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './privacy.module.css';

export const metadata: Metadata = {
  title: 'Privacy notice — PDF Human Reader',
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>
        ← Back to the reader
      </Link>

      <h1>Privacy notice</h1>
      <p className={styles.lede}>
        This app treats every PDF you open as private. This page describes exactly what happens to
        your document and where anything is sent.
      </p>

      <h2>Your PDF file</h2>
      <ul>
        <li>
          The file is opened and processed <strong>in your browser</strong>. Page rendering, text
          extraction, layout analysis and classification all run locally.
        </li>
        <li>
          The file itself is <strong>never uploaded</strong> to this app’s server or anywhere else,
          unless you explicitly turn on text recognition for scanned pages.
        </li>
        <li>
          The file is <strong>not stored</strong> between sessions unless you opt in. By default
          only a fingerprint, your reading position and your display settings are kept, in this
          browser.
        </li>
      </ul>

      <h2>Text sent for speech</h2>
      <ul>
        <li>
          If a server speech provider is configured for this deployment, the app sends{' '}
          <strong>the text of the passage currently being read</strong> to this app’s own API, which
          forwards it to that provider. Your file is not sent; only the words to be spoken.
        </li>
        <li>
          If no server provider is configured, or you pick a browser voice, speech is produced by
          your browser’s own engine. Some operating systems use a cloud voice for this; that is a
          decision made by your browser and operating system, not by this app.
        </li>
        <li>
          The Settings panel names the exact provider this deployment is configured to use, before
          you play anything.
        </li>
      </ul>

      <h2>Scanned pages and text recognition</h2>
      <ul>
        <li>
          A page image is only sent to a text-recognition provider if you turn that on. The setting
          is off by default and the server refuses any request that does not carry your consent.
        </li>
        <li>
          Where recognition is uncertain, the word is marked as uncertain. The app will not guess at
          a word it could not read.
        </li>
      </ul>

      <h2>Logging</h2>
      <ul>
        <li>
          The server logs identifiers, sizes and error codes. It does{' '}
          <strong>not log document text</strong>, extracted text, page images or provider request
          bodies in production.
        </li>
        <li>
          Validation errors return field names only, so document text is never echoed back in an
          error message.
        </li>
        <li>API credentials are held on the server only and are never sent to your browser.</li>
      </ul>

      <h2>Model training</h2>
      <p>
        Your documents and their extracted text are <strong>not used to train any model</strong> by
        this application. If you configure a third-party speech or recognition provider, that
        provider’s own terms govern what it does with the text you send it — check them before
        enabling one for sensitive documents.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Settings → “Delete everything this app has stored” removes every reading position, setting
        and locally-kept document from this browser, and clears the server’s temporary audio cache.
        Temporary server files are deleted as soon as a request finishes, and a sweeper removes
        anything left behind.
      </p>

      <h2>What this app does not do</h2>
      <ul>
        <li>It does not summarise, paraphrase or reword your document.</li>
        <li>It does not correct the author’s grammar or complete unfinished sentences.</li>
        <li>It does not invent descriptions for images.</li>
        <li>It does not hide content it excluded — Content Review lists all of it.</li>
        <li>It does not present estimated word timing as if it were exact.</li>
      </ul>
    </main>
  );
}
