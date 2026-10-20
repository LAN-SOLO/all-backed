// Thin helpers over the File System Access API. All engine code accesses
// directories exclusively through handles, so the same code runs against
// user-picked folders and against OPFS (used by the self-test).

import { EngineError } from './types';

export interface WalkedFile {
  path: string;
  handle: FileSystemFileHandle;
}

/**
 * Read errors that affect a single file or subfolder (locked by another
 * program, changed or deleted while the backup runs, unreadable folder).
 * They skip that entry; everything else (permission, quota) stays fatal.
 */
export function isSkippableReadError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'NotReadableError' || err.name === 'NotFoundError')
  );
}

export async function* walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix = '',
  onSkip?: (path: string, err: unknown) => void,
  /**
   * A folder that is never entered — the backup's own `allbacked` folder
   * when the destination lies inside a source (otherwise every run would
   * back up the repository into itself).
   */
  exclude?: FileSystemDirectoryHandle
): AsyncGenerator<WalkedFile> {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      yield { path, handle };
      continue;
    }
    if (exclude && (await exclude.isSameEntry(handle).catch(() => false))) continue;
    if (onSkip) {
      // an unreadable subfolder (e.g. a protected system folder on a
      // Windows drive) skips that folder instead of failing the whole run
      try {
        yield* walkFiles(handle, path, onSkip, exclude);
      } catch (err) {
        if (!isSkippableReadError(err)) throw err;
        onSkip(`${path}/`, err);
      }
    } else {
      yield* walkFiles(handle, path, undefined, exclude);
    }
  }
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite'
): Promise<void> {
  if ((await handle.queryPermission({ mode })) === 'granted') return;
  if ((await handle.requestPermission({ mode })) === 'granted') return;
  throw new EngineError('permission-denied', `Permission (${mode}) denied for "${handle.name}"`, handle.name);
}

export async function fileExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | Blob | string
): Promise<void> {
  // getFileHandle({ create: true }) creates an EMPTY file at once; if the
  // write then fails (drive full, lock) that empty file must not stay — a
  // 0-byte block would otherwise count as "already stored" forever
  let created = false;
  let handle: FileSystemFileHandle;
  try {
    handle = await dir.getFileHandle(name);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
    handle = await dir.getFileHandle(name, { create: true });
    created = true;
  }
  let writable: FileSystemWritableFileStream | null = null;
  try {
    writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    if (writable) await writable.abort().catch(() => {});
    if (created) await dir.removeEntry(name).catch(() => {});
    throw err;
  }
}

/**
 * True when `name` exists with content. A 0-byte file is what an
 * interrupted write leaves behind (tab closed, browser crash, drive pulled
 * between create and close) — every stored block and manifest has at least
 * a gzip header, so an empty one is never valid and is written again.
 */
export async function nonEmptyFileExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size > 0;
  } catch {
    return false;
  }
}

/**
 * Errors a short-lived lock on the destination produces — on Windows a
 * virus scanner, the search indexer or OneDrive briefly holding the file (or
 * Chrome's swap file while it is moved into place). Worth a retry.
 */
export function isTransientWriteError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError')
  );
}

/** Delays between write attempts (ms); exported for the self-test. */
export const WRITE_RETRY_DELAYS = [150, 500, 1500];

/**
 * writeFile with retries on transient locks. Each attempt writes the whole
 * file again and close() commits atomically, so a retry never produces a
 * mixed or half file. Other errors (quota, permission) fail at once.
 */
export async function writeFileRetry(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | Blob | string,
  delays: number[] = WRITE_RETRY_DELAYS
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(dir, name, data);
      return;
    } catch (err) {
      if (!isTransientWriteError(err) || attempt >= delays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export async function readFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<ArrayBuffer> {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return file.arrayBuffer();
}

export async function readFileIfExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<ArrayBuffer | null> {
  try {
    return await readFile(dir, name);
  } catch {
    return null;
  }
}

/** Resolve (and optionally create) a nested directory from a relative path. */
export async function getDirByPath(
  root: FileSystemDirectoryHandle,
  path: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of path) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}
