import { Manifest, Progress, ProgressFn } from './types';
import { getDirByPath, readFile } from './fsx';
import { OpenRepo, decodeBlock, readManifest } from './repo';

export interface RestoreOptions {
  repo: OpenRepo;
  manifestName: string;
  target: FileSystemDirectoryHandle;
  onProgress?: ProgressFn;
}

export interface RestoreResult {
  fileCount: number;
  totalBytes: number;
  durationMs: number;
  manifest: Manifest;
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const started = performance.now();
  const manifest = await readManifest(options.repo, options.manifestName);

  const progress: Progress = {
    phase: 'restore',
    filesDone: 0,
    bytesDone: 0,
    newBlocks: 0,
    dedupBlocks: 0,
  };
  const report = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    options.onProgress?.({ ...progress });
  };

  for (const entry of manifest.files) {
    report({ path: entry.path });
    const parts = entry.path.split('/');
    const fileName = parts.pop()!;
    const dir = await getDirByPath(options.target, parts, true);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      for (const hash of entry.chunks) {
        const blockDir = await options.repo.blocks.getDirectoryHandle(hash.slice(0, 2));
        const plain = await decodeBlock(options.repo, await readFile(blockDir, hash));
        await writable.write(plain);
        report({ bytesDone: progress.bytesDone + plain.byteLength });
      }
    } finally {
      await writable.close();
    }
    report({ filesDone: progress.filesDone + 1 });
  }

  report({ phase: 'done', path: undefined });
  return {
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    durationMs: Math.round(performance.now() - started),
    manifest,
  };
}
