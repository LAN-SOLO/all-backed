import { EngineError, Manifest, Progress, ProgressFn } from './types';
import { sha256Hex } from './crypto';
import { getDirByPath, readFile } from './fsx';
import { OpenRepo, decodeBlock, readManifest, safeRelativePath } from './repo';
import { planRestorePaths } from './portable';

export interface RestoreOptions {
  repo: OpenRepo;
  manifestName: string;
  target: FileSystemDirectoryHandle;
  onProgress?: ProgressFn;
  /**
   * Cancels between blocks (throws the signal's AbortError). The file being
   * written is discarded; files finished before stay in the target.
   */
  signal?: AbortSignal;
}

export interface RestoreRename {
  /** Path as stored in the backup. */
  path: string;
  /** Path actually written below the target folder. */
  to: string;
}

export interface RestoreFailure {
  path: string;
  /** Technical reason (English) — the UI translates `error` instead. */
  reason: string;
  error: unknown;
}

export interface RestoreResult {
  /** Files written completely and verified. */
  fileCount: number;
  totalBytes: number;
  durationMs: number;
  manifest: Manifest;
  /**
   * Files that could not be restored (corrupt/missing block, a name the
   * target file system rejects — e.g. "a:b.txt" on Windows). Every other
   * file is still restored; a failed file never leaves a partial copy.
   */
  failed: RestoreFailure[];
  /**
   * Files written under a different name because the original is not valid
   * on Windows/macOS ("a:b.txt" → "a_b.txt", "CON" → "_CON") or would collide
   * with another file on a case-insensitive volume ("README (2).txt").
   */
  renamed: RestoreRename[];
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Errors that make every further file fail too — stop instead of looping. */
function isFatal(err: unknown): boolean {
  if (err instanceof EngineError) return err.code === 'passphrase-wrong';
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' ||
      err.name === 'NotAllowedError' ||
      err.name === 'SecurityError' ||
      err.name === 'AbortError')
  );
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const started = performance.now();
  // readManifest validates structure, paths (no '..', no absolute or drive
  // paths, no backslashes) and chunk hashes before anything is written
  const manifest = await readManifest(options.repo, options.manifestName);

  const progress: Progress = {
    phase: 'restore',
    filesDone: 0,
    bytesDone: 0,
    newBlocks: 0,
    dedupBlocks: 0,
    totalFiles: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, f) => sum + f.size, 0),
  };
  const report = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };

  const failed: RestoreFailure[] = [];
  const renamed: RestoreRename[] = [];
  let restoredFiles = 0;
  let restoredBytes = 0;
  // target names are decided here, before anything is written: portable on
  // every system and unique on case-insensitive volumes
  const planned = planRestorePaths(manifest.files.map((entry) => safeRelativePath(entry.path)!));
  const signal = options.signal;

  for (const [index, entry] of manifest.files.entries()) {
    signal?.throwIfAborted();
    report({ path: entry.path });
    const { parts, renamed: isRenamed } = planned[index];
    const fileName = parts[parts.length - 1];
    let writable: FileSystemWritableFileStream | null = null;
    let dir: FileSystemDirectoryHandle | null = null;
    let created = false;
    let written = 0;
    try {
      dir = await getDirByPath(options.target, parts.slice(0, -1), true);
      let handle: FileSystemFileHandle;
      try {
        handle = await dir.getFileHandle(fileName);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
        handle = await dir.getFileHandle(fileName, { create: true });
        created = true;
      }
      writable = await handle.createWritable();
      for (const hash of entry.chunks) {
        signal?.throwIfAborted();
        const blockDir = await options.repo.blocks.getDirectoryHandle(hash.slice(0, 2));
        const plain = await decodeBlock(options.repo, await readFile(blockDir, hash)).catch(
          (err: unknown) => {
            // the passphrase was already proven on the manifest, so a block
            // that fails authentication is damaged, not "wrong passphrase"
            if (err instanceof EngineError && err.code === 'passphrase-wrong') {
              throw new EngineError('block-corrupt', `Block ${hash.slice(0, 12)}… is damaged.`, `${hash.slice(0, 12)}…`);
            }
            throw err;
          }
        );
        // content addressing doubles as an integrity check: the decoded
        // chunk must hash to its name (catches bit rot and swapped blocks
        // in unencrypted repositories; GCM already covers encrypted ones)
        if ((await sha256Hex(plain)) !== hash) {
          throw new EngineError('block-corrupt', `Block ${hash.slice(0, 12)}… is damaged.`, `${hash.slice(0, 12)}…`);
        }
        await writable.write(plain);
        written += plain.byteLength;
        report({ bytesDone: progress.bytesDone + plain.byteLength });
      }
      if (written !== entry.size) {
        throw new EngineError('block-corrupt', `Size mismatch (${written} ≠ ${entry.size} bytes).`, `${written} ≠ ${entry.size} B`);
      }
      await writable.close();
      writable = null;
      restoredFiles += 1;
      restoredBytes += written;
      if (isRenamed) renamed.push({ path: entry.path, to: parts.join('/') });
    } catch (err) {
      // never commit a half-written file: abort discards the swap file (an
      // existing file keeps its old content); a file we created is removed
      if (writable) await writable.abort().catch(() => {});
      if (created && dir) await dir.removeEntry(fileName).catch(() => {});
      if (isFatal(err)) throw err;
      failed.push({ path: entry.path, reason: reasonOf(err), error: err });
    }
    report({ filesDone: progress.filesDone + 1 });
  }

  report({ phase: 'done', path: undefined });
  return {
    fileCount: restoredFiles,
    totalBytes: restoredBytes,
    durationMs: Math.round(performance.now() - started),
    manifest,
    failed,
    renamed,
  };
}

// Files the OS drops into any folder — they do not make a target "non-empty".
const OS_LITTER = new Set(['.ds_store', 'desktop.ini', 'thumbs.db', '.localized']);

export interface RestoreTargetCheck {
  /** The target is the repository folder or lies inside it. */
  insideRepo: boolean;
  /** Up to `limit` names already in the target (OS litter ignored). */
  existing: string[];
}

/**
 * Checked before a restore writes anything: restoring into the repository
 * would mix restored files into blocks/ and manifests/, and a non-empty
 * target gets same-named files overwritten — the UI asks first.
 */
export async function inspectRestoreTarget(
  target: FileSystemDirectoryHandle,
  repoRoot: FileSystemDirectoryHandle,
  limit = 5
): Promise<RestoreTargetCheck> {
  let insideRepo = await repoRoot.isSameEntry(target).catch(() => false);
  if (!insideRepo && typeof repoRoot.resolve === 'function') {
    insideRepo = (await repoRoot.resolve(target).catch(() => null)) !== null;
  }
  const existing: string[] = [];
  for await (const name of target.keys()) {
    if (OS_LITTER.has(name.toLowerCase())) continue;
    existing.push(name);
    if (existing.length >= limit) break;
  }
  return { insideRepo, existing };
}
