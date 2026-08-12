// all backed repository format, version 1.
//
// Layout inside the chosen destination directory:
//   allbacked/<task-slug>/ab-repo.json           repo config (plaintext)
//   allbacked/<task-slug>/blocks/<hh>/<hash>     compressed [+ encrypted] chunks
//   allbacked/<task-slug>/manifests/manifest-<ts>.json[.enc]
//
// Chunk hashes are SHA-256 over the PLAINTEXT chunk, so deduplication is
// stable across runs. (Keyed hashes are a planned upgrade — see plan doc.)

export const REPO_DIR = 'allbacked';
export const REPO_CONFIG_FILE = 'ab-repo.json';
export const BLOCKS_DIR = 'blocks';
export const MANIFESTS_DIR = 'manifests';
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const PBKDF2_ITERATIONS = 310_000;

export interface RepoConfig {
  format: 1;
  createdAt: string;
  taskName: string;
  compression: 'gzip';
  encrypted: boolean;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string; // base64
  } | null;
}

export interface ManifestFile {
  path: string; // forward-slash relative path
  size: number;
  mtime: number;
  chunks: string[]; // SHA-256 hex of each plaintext chunk, in order
}

export interface Manifest {
  format: 1;
  createdAt: string;
  taskName: string;
  chunkSize: number;
  fileCount: number;
  totalBytes: number;
  files: ManifestFile[];
}

export interface RunSummary {
  finishedAt: string;
  manifestName: string;
  fileCount: number;
  totalBytes: number;
  newBlocks: number;
  dedupBlocks: number;
  verifiedOk: boolean;
  durationMs: number;
  encrypted: boolean;
}

export interface BackupTask {
  id: string;
  name: string;
  createdAt: string;
  encrypt: boolean;
  source: FileSystemDirectoryHandle | null;
  dest: FileSystemDirectoryHandle | null;
  lastRun: RunSummary | null;
}

export type ProgressPhase =
  | 'scan'
  | 'backup'
  | 'manifest'
  | 'verify'
  | 'restore'
  | 'done';

export interface Progress {
  phase: ProgressPhase;
  path?: string;
  filesDone: number;
  bytesDone: number;
  newBlocks: number;
  dedupBlocks: number;
}

export type ProgressFn = (p: Progress) => void;

export class EngineError extends Error {
  constructor(
    public code:
      | 'passphrase-required'
      | 'passphrase-wrong'
      | 'repo-unencrypted'
      | 'not-a-repo'
      | 'verify-failed'
      | 'permission-denied',
    message: string
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task'
  );
}
