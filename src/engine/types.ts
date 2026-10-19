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
// new repositories; existing ones keep the count stored in ab-repo.json
export const PBKDF2_ITERATIONS = 600_000;

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
  /** Set when the run failed; the other counters are then 0. */
  error?: string;
}

export interface BackupTask {
  id: string;
  name: string;
  createdAt: string;
  encrypt: boolean;
  /** One or more source folders; files are stored under the folder's name. */
  sources: FileSystemDirectoryHandle[];
  dest: FileSystemDirectoryHandle | null;
  lastRun: RunSummary | null;
  /**
   * Repository folder below allbacked/, pinned on the first successful run
   * so renaming the task does not start a new repository. Absent on tasks
   * that never ran (then slugify(name) is used).
   */
  repoSlug?: string;
}

export type ProgressPhase =
  | 'scan'
  | 'backup'
  | 'verify'
  | 'manifest'
  | 'restore'
  | 'done';

export interface Progress {
  phase: ProgressPhase;
  path?: string;
  filesDone: number;
  bytesDone: number;
  newBlocks: number;
  dedupBlocks: number;
  /** Known after the scan phase; 0 while still scanning. */
  totalFiles: number;
  totalBytes: number;
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
      | 'permission-denied'
      | 'repo-invalid'
      | 'manifest-invalid'
      | 'block-corrupt',
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
