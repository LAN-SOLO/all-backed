import { EngineError, Manifest, Progress, ProgressFn } from './types';
import { sha256Hex } from './crypto';
import { getDirByPath, readFile } from './fsx';
import { OpenRepo, decodeBlock, readManifest, safeRelativePath } from './repo';

export interface RestoreOptions {
  repo: OpenRepo;
  manifestName: string;
  target: FileSystemDirectoryHandle;
  onProgress?: ProgressFn;
}

export interface RestoreFailure {
  path: string;
  reason: string;
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
  let restoredFiles = 0;
  let restoredBytes = 0;

  for (const entry of manifest.files) {
    report({ path: entry.path });
    const parts = safeRelativePath(entry.path)!;
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
        const blockDir = await options.repo.blocks.getDirectoryHandle(hash.slice(0, 2));
        const plain = await decodeBlock(options.repo, await readFile(blockDir, hash)).catch(
          (err: unknown) => {
            // the passphrase was already proven on the manifest, so a block
            // that fails authentication is damaged, not "wrong passphrase"
            if (err instanceof EngineError && err.code === 'passphrase-wrong') {
              throw new EngineError('block-corrupt', `Block ${hash.slice(0, 12)}… is damaged.`);
            }
            throw err;
          }
        );
        // content addressing doubles as an integrity check: the decoded
        // chunk must hash to its name (catches bit rot and swapped blocks
        // in unencrypted repositories; GCM already covers encrypted ones)
        if ((await sha256Hex(plain)) !== hash) {
          throw new EngineError('block-corrupt', `Block ${hash.slice(0, 12)}… is damaged.`);
        }
        await writable.write(plain);
        written += plain.byteLength;
        report({ bytesDone: progress.bytesDone + plain.byteLength });
      }
      if (written !== entry.size) {
        throw new EngineError('block-corrupt', `Size mismatch (${written} ≠ ${entry.size} bytes).`);
      }
      await writable.close();
      writable = null;
      restoredFiles += 1;
      restoredBytes += written;
    } catch (err) {
      // never commit a half-written file: abort discards the swap file (an
      // existing file keeps its old content); a file we created is removed
      if (writable) await writable.abort().catch(() => {});
      if (created && dir) await dir.removeEntry(fileName).catch(() => {});
      if (isFatal(err)) throw err;
      failed.push({ path: entry.path, reason: reasonOf(err) });
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
  };
}
