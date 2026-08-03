import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocumentSettings, ReadingPosition } from '@pdfreader/shared-types';

/**
 * Local persistence.
 *
 * Everything here stays in the browser. The PDF itself is NOT stored unless the
 * user explicitly opts in; by default only a fingerprint, the reading position
 * and the display settings are kept, which is enough to resume a document
 * without retaining its contents.
 */

const DB_NAME = 'pdf-human-reader';
const DB_VERSION = 1;

interface ReaderDB extends DBSchema {
  positions: {
    key: string;
    value: ReadingPosition;
  };
  settings: {
    key: string;
    value: DocumentSettings & { fingerprint: string };
  };
  /** Only written when the user opts in to keeping the file locally. */
  documents: {
    key: string;
    value: { fingerprint: string; fileName: string; bytes: ArrayBuffer; storedAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<ReaderDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ReaderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ReaderDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents');
      },
    });
  }
  return dbPromise;
}

export class StorageFullError extends Error {
  constructor() {
    super('There is no room left in this browser to save your reading position.');
    this.name = 'StorageFullError';
  }
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

export async function savePosition(position: ReadingPosition): Promise<void> {
  try {
    const db = await getDb();
    await db.put('positions', position, position.fingerprint);
  } catch (error) {
    if (isQuotaError(error)) throw new StorageFullError();
    throw error;
  }
}

export async function loadPosition(fingerprint: string): Promise<ReadingPosition | undefined> {
  const db = await getDb();
  return db.get('positions', fingerprint);
}

export async function saveSettings(fingerprint: string, settings: DocumentSettings): Promise<void> {
  try {
    const db = await getDb();
    await db.put('settings', { ...settings, fingerprint }, fingerprint);
  } catch (error) {
    if (isQuotaError(error)) throw new StorageFullError();
    throw error;
  }
}

export async function loadSettings(fingerprint: string): Promise<DocumentSettings | undefined> {
  const db = await getDb();
  const stored = await db.get('settings', fingerprint);
  if (!stored) return undefined;
  const { fingerprint: _ignored, ...settings } = stored;
  return settings;
}

/** Opt-in only: keeps the PDF bytes locally so a reload does not need the file again. */
export async function saveDocumentBytes(
  fingerprint: string,
  fileName: string,
  bytes: ArrayBuffer,
): Promise<void> {
  try {
    const db = await getDb();
    await db.put('documents', { fingerprint, fileName, bytes, storedAt: Date.now() }, fingerprint);
  } catch (error) {
    if (isQuotaError(error)) throw new StorageFullError();
    throw error;
  }
}

export async function loadDocumentBytes(fingerprint: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb();
  return (await db.get('documents', fingerprint))?.bytes;
}

export async function listRecentDocuments(limit = 10): Promise<ReadingPosition[]> {
  const db = await getDb();
  const all = await db.getAll('positions');
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, limit);
}

/** Backs the "delete everything this app stored" action. */
export async function deleteAllStoredData(): Promise<void> {
  const db = await getDb();
  await Promise.all([db.clear('positions'), db.clear('settings'), db.clear('documents')]);
}

export async function deleteDocumentData(fingerprint: string): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.delete('positions', fingerprint),
    db.delete('settings', fingerprint),
    db.delete('documents', fingerprint),
  ]);
}

/** Approximate local storage usage, for the privacy panel. */
export async function estimateStorageUsage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 };
}
