import {
  DEFAULT_CHUNK_SIZE,
  EngineError,
  Manifest,
  ManifestFile,
  Progress,
  ProgressFn,
  RunSummary,
} from './types';
import { sha256Hex } from './crypto';
import { fileExists, walkFiles, writeFile, readFile } from './fsx';
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
  await writeFile(dir, hash, await encodeBlock(repo, plain));
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
      throw new EngineError('verify-failed', `Block ${hash.slice(0, 12)}… failed verification.`);
    }
    if ((await sha256Hex(plain)) !== hash) {
      throw new EngineError('verify-failed', `Block ${hash.slice(0, 12)}… failed verification.`);
    }
  }
}

export async function runBackup(options: BackupOptions): Promise<RunSummary> {
  const started = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
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
  const plan: { path: string; file: File }[] = [];
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
      for await (const item of walkFiles(source.handle, uniqueRoot(source.handle.name))) {
        plan.push({ path: item.path, file: await item.handle.getFile() });
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

  for (const entry of plan) {
    report({ phase: 'backup', path: entry.path });
    const file = entry.file;
    const chunks: string[] = [];
    for (let offset = 0; offset < file.size || offset === 0; offset += chunkSize) {
      const plain = await file.slice(offset, offset + chunkSize).arrayBuffer();
      if (plain.byteLength === 0 && offset > 0) break;
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
  report({ phase: 'verify', path: undefined });
  await verifySamples(repo, manifest, options.verifySamples ?? 5);

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
  };
}
