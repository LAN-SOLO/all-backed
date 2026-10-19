import {
  DEFAULT_CHUNK_SIZE,
  EngineError,
  Manifest,
  ManifestFile,
  Progress,
  ProgressFn,
  RunSummary,
  SkippedFile,
} from './types';
import { sha256Hex } from './crypto';
import { fileExists, isSkippableReadError, walkFiles, writeFileRetry, readFile } from './fsx';
import { OpenRepo, decodeBlock, encodeBlock, openOrInitRepo, writeManifest } from './repo';

/**
 * A backup source: either a picked directory handle (Chromium — files are
 * stored under `<handle.name>/…`) or a named flat list of files with relative
 * paths, as produced by a webkitdirectory input (Safari/Firefox fallback —
 * webkitRelativePath already contains the folder name).
 */
export type SourceDir =
  | { kind: 'handle'; handle: FileSystemDirectoryHandle }
  | { kind: 'files'; name: string; files: { path: string; file: File }[] };

export interface BackupOptions {
  sources: SourceDir[];
  dest: FileSystemDirectoryHandle;
  taskName: string;
  /**
   * Folder name of the repository below `allbacked/`. Defaults to
   * slugify(taskName); tasks pin it after their first run so renaming a task
   * keeps writing into the same repository.
   */
  repoSlug?: string;
  passphrase?: string;
  chunkSize?: number;
  verifySamples?: number;
  onProgress?: ProgressFn;
  /**
   * Cancels the run between files/blocks (throws the signal's AbortError).
   * Blocks written so far stay (they are complete and deduplicate the next
   * run); no manifest is written, so no half version appears.
   */
  signal?: AbortSignal;
}

async function blockDir(repo: OpenRepo, hash: string, create: boolean) {
  return repo.blocks.getDirectoryHandle(hash.slice(0, 2), { create });
}

async function storeChunk(
  repo: OpenRepo,
  hash: string,
  plain: ArrayBuffer
): Promise<'new' | 'dedup'> {
  const dir = await blockDir(repo, hash, true);
  if (await fileExists(dir, hash)) return 'dedup';
  await writeFileRetry(dir, hash, await encodeBlock(repo, plain));
  return 'new';
}

async function verifySamples(
  repo: OpenRepo,
  manifest: Manifest,
  sampleCount: number
): Promise<void> {
  // sample from the DISTINCT chunks — sampling the raw list could never
  // reach `sampleCount` distinct picks when files share chunks (e.g. two
  // empty files) and would spin forever
  const unique = [...new Set(manifest.files.flatMap((f) => f.chunks))];
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  for (const hash of unique.slice(0, sampleCount)) {
    let plain: ArrayBuffer;
    try {
      const dir = await blockDir(repo, hash, false);
      plain = await decodeBlock(repo, await readFile(dir, hash));
    } catch {
      throw new EngineError('verify-failed', `Block ${hash.slice(0, 12)}… failed verification.`, `${hash.slice(0, 12)}…`);
    }
    if ((await sha256Hex(plain)) !== hash) {
      throw new EngineError('verify-failed', `Block ${hash.slice(0, 12)}… failed verification.`, `${hash.slice(0, 12)}…`);
    }
  }
}

export async function runBackup(options: BackupOptions): Promise<RunSummary> {
  const started = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  signal?.throwIfAborted();
  const repo = await openOrInitRepo(
    options.dest,
    options.taskName,
    options.passphrase,
    options.repoSlug
  );

  const progress: Progress = {
    phase: 'scan',
    filesDone: 0,
    bytesDone: 0,
    newBlocks: 0,
    dedupBlocks: 0,
    totalFiles: 0,
    totalBytes: 0,
  };
  const report = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };

  // scan phase: materialize the full file list so progress has a real total
  report({ phase: 'scan' });
  // handle-based entries keep their handle: the file is re-opened right
  // before it is read, so a file saved between scan and read is backed up
  // in its new state instead of failing with NotReadableError
  const plan: { path: string; file: File; handle?: FileSystemFileHandle }[] = [];
  const skipped: SkippedFile[] = [];
  const skip = (path: string, err: unknown) =>
    skipped.push({ path, reason: err instanceof DOMException ? err.name : String(err) });
  const seenHandles: FileSystemDirectoryHandle[] = [];
  const usedRoots = new Set<string>();
  // two sources with the same folder name (e.g. "Documents" from two drives)
  // must not collide in the manifest: the second becomes "Documents (2)"
  const uniqueRoot = (name: string) => {
    let candidate = name;
    for (let n = 2; usedRoots.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    usedRoots.add(candidate.toLowerCase());
    return candidate;
  };
  for (const source of options.sources) {
    if (source.kind === 'files') {
      const root = uniqueRoot(source.name);
      for (const entry of source.files) {
        const path =
          root === source.name
            ? entry.path
            : entry.path === source.name
              ? root
              : entry.path.startsWith(`${source.name}/`)
                ? `${root}/${entry.path.slice(source.name.length + 1)}`
                : entry.path;
        plan.push({ path, file: entry.file });
      }
    } else {
      // the same folder added twice is backed up once
      let duplicate = false;
      for (const seen of seenHandles) {
        if (await seen.isSameEntry(source.handle).catch(() => false)) duplicate = true;
      }
      if (duplicate) continue;
      seenHandles.push(source.handle);
      for await (const item of walkFiles(source.handle, uniqueRoot(source.handle.name), skip)) {
        signal?.throwIfAborted();
        let file: File;
        try {
          file = await item.handle.getFile();
        } catch (err) {
          if (!isSkippableReadError(err)) throw err;
          skip(item.path, err);
          continue;
        }
        plan.push({ path: item.path, file, handle: item.handle });
        if (plan.length % 50 === 0) report({ path: item.path });
      }
    }
  }
  // safety net: identical relative paths (e.g. loose dropped files with the
  // same name) get a numbered suffix instead of silently overwriting
  // each other on restore
  const usedPaths = new Set<string>();
  for (const entry of plan) {
    let path = entry.path;
    if (usedPaths.has(path.toLowerCase())) {
      const slash = path.lastIndexOf('/');
      const dot = path.lastIndexOf('.');
      const cut = dot > slash + 1 ? dot : path.length;
      for (let n = 2; usedPaths.has(path.toLowerCase()); n++) {
        path = `${entry.path.slice(0, cut)} (${n})${entry.path.slice(cut)}`;
      }
      entry.path = path;
    }
    usedPaths.add(path.toLowerCase());
  }
  report({
    totalFiles: plan.length,
    totalBytes: plan.reduce((sum, entry) => sum + entry.file.size, 0),
  });

  const files: ManifestFile[] = [];
  let totalBytes = 0;

  plan: for (const entry of plan) {
    signal?.throwIfAborted();
    report({ phase: 'backup', path: entry.path });
    // a file that is locked (e.g. an open Outlook .pst on Windows), changed
    // mid-read or deleted since the scan is skipped and listed — one busy
    // file must not fail the whole backup
    let file: File;
    try {
      file = entry.handle ? await entry.handle.getFile() : entry.file;
    } catch (err) {
      if (!isSkippableReadError(err)) throw err;
      skip(entry.path, err);
      report({ filesDone: progress.filesDone + 1 });
      continue;
    }
    const chunks: string[] = [];
    const bytesBefore = progress.bytesDone;
    for (let offset = 0; offset < file.size || offset === 0; offset += chunkSize) {
      let plain: ArrayBuffer;
      try {
        plain = await file.slice(offset, offset + chunkSize).arrayBuffer();
      } catch (err) {
        if (!isSkippableReadError(err)) throw err;
        // blocks already stored for this file are harmless (deduplicated
        // content); the file just doesn't appear in this version
        skip(entry.path, err);
        report({ bytesDone: bytesBefore + file.size, filesDone: progress.filesDone + 1 });
        continue plan;
      }
      if (plain.byteLength === 0 && offset > 0) break;
      signal?.throwIfAborted();
      const hash = await sha256Hex(plain);
      const stored = await storeChunk(repo, hash, plain);
      if (stored === 'new') progress.newBlocks += 1;
      else progress.dedupBlocks += 1;
      chunks.push(hash);
      report({ bytesDone: progress.bytesDone + plain.byteLength });
      if (plain.byteLength === 0) break; // empty file: single empty chunk recorded
    }
    files.push({ path: entry.path, size: file.size, mtime: file.lastModified, chunks });
    totalBytes += file.size;
    report({ filesDone: progress.filesDone + 1 });
  }

  const manifest: Manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    taskName: options.taskName,
    chunkSize,
    fileCount: files.length,
    totalBytes,
    files,
  };
  // verify BEFORE the manifest is written: a run whose blocks don't read
  // back never shows up as a restorable version
  signal?.throwIfAborted();
  report({ phase: 'verify', path: undefined });
  await verifySamples(repo, manifest, options.verifySamples ?? 5);

  // last point to cancel — once the manifest is written the run is done
  signal?.throwIfAborted();
  report({ phase: 'manifest' });
  const manifestName = await writeManifest(repo, manifest);

  report({ phase: 'done' });
  return {
    finishedAt: new Date().toISOString(),
    manifestName,
    fileCount: files.length,
    totalBytes,
    newBlocks: progress.newBlocks,
    dedupBlocks: progress.dedupBlocks,
    verifiedOk: true,
    durationMs: Math.round(performance.now() - started),
    encrypted: repo.config.encrypted,
    ...(skipped.length > 0
      ? { skippedCount: skipped.length, skipped: skipped.slice(0, MAX_SKIPPED_LISTED) }
      : {}),
  };
}

/** How many skipped paths a run summary keeps (it is stored with the task). */
export const MAX_SKIPPED_LISTED = 100;
