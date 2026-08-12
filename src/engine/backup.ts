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
 * A backup source is either a picked directory handle (Chromium) or a flat
 * list of files with relative paths, as produced by a webkitdirectory input
 * (Firefox fallback).
 */
export type SourceInput = FileSystemDirectoryHandle | { path: string; file: File }[];

export interface BackupOptions {
  source: SourceInput;
  dest: FileSystemDirectoryHandle;
  taskName: string;
  passphrase?: string;
  chunkSize?: number;
  verifySamples?: number;
  onProgress?: ProgressFn;
}

async function* iterateSource(
  source: SourceInput
): AsyncGenerator<{ path: string; getFile: () => Promise<File> }> {
  if (Array.isArray(source)) {
    for (const entry of source) {
      yield { path: entry.path, getFile: async () => entry.file };
    }
  } else {
    for await (const item of walkFiles(source)) {
      yield { path: item.path, getFile: () => item.handle.getFile() };
    }
  }
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
  const allChunks = manifest.files.flatMap((f) => f.chunks);
  if (allChunks.length === 0) return;
  const picks = new Set<string>();
  while (picks.size < Math.min(sampleCount, allChunks.length)) {
    picks.add(allChunks[Math.floor(Math.random() * allChunks.length)]);
  }
  for (const hash of picks) {
    const dir = await blockDir(repo, hash, false);
    const plain = await decodeBlock(repo, await readFile(dir, hash));
    if ((await sha256Hex(plain)) !== hash) {
      throw new EngineError('verify-failed', `Block ${hash.slice(0, 12)}… failed verification.`);
    }
  }
}

export async function runBackup(options: BackupOptions): Promise<RunSummary> {
  const started = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const repo = await openOrInitRepo(options.dest, options.taskName, options.passphrase);

  const progress: Progress = {
    phase: 'backup',
    filesDone: 0,
    bytesDone: 0,
    newBlocks: 0,
    dedupBlocks: 0,
  };
  const report = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };

  const files: ManifestFile[] = [];
  let totalBytes = 0;

  for await (const entry of iterateSource(options.source)) {
    report({ phase: 'backup', path: entry.path });
    const file = await entry.getFile();
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
  report({ phase: 'manifest', path: undefined });
  const manifestName = await writeManifest(repo, manifest);

  report({ phase: 'verify' });
  await verifySamples(repo, manifest, options.verifySamples ?? 5);

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
