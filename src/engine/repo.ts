import {
  BLOCKS_DIR,
  EngineError,
  MANIFESTS_DIR,
  Manifest,
  PBKDF2_ITERATIONS,
  REPO_CONFIG_FILE,
  REPO_DIR,
  RepoConfig,
  slugify,
} from './types';
import { decrypt, deriveKey, encrypt, gunzip, gzip, randomSaltB64 } from './crypto';
import { fileExists, getDirByPath, readFile, readFileIfExists, writeFileRetry } from './fsx';

export interface OpenRepo {
  root: FileSystemDirectoryHandle;
  blocks: FileSystemDirectoryHandle;
  manifests: FileSystemDirectoryHandle;
  config: RepoConfig;
  key: CryptoKey | null;
}

const decoder = new TextDecoder();

const MAX_KDF_ITERATIONS = 10_000_000;

/**
 * Parse and sanity-check ab-repo.json. The file is plaintext on the drive, so
 * a damaged or tampered config must fail with a clear error instead of
 * hanging the KDF (absurd iteration counts) or crashing later.
 */
export function parseRepoConfig(raw: ArrayBuffer): RepoConfig {
  let config: RepoConfig;
  try {
    config = JSON.parse(decoder.decode(raw)) as RepoConfig;
  } catch {
    throw new EngineError('repo-invalid', 'ab-repo.json is not valid JSON.', REPO_CONFIG_FILE);
  }
  const kdf = config?.kdf;
  const valid =
    config !== null &&
    typeof config === 'object' &&
    config.format === 1 &&
    typeof config.encrypted === 'boolean' &&
    (config.encrypted
      ? kdf !== null &&
        typeof kdf === 'object' &&
        kdf.name === 'PBKDF2' &&
        kdf.hash === 'SHA-256' &&
        Number.isInteger(kdf.iterations) &&
        kdf.iterations >= 1 &&
        kdf.iterations <= MAX_KDF_ITERATIONS &&
        typeof kdf.salt === 'string' &&
        /^[A-Za-z0-9+/]{16,}={0,2}$/.test(kdf.salt)
      : true);
  if (!valid) {
    throw new EngineError('repo-invalid', 'ab-repo.json is damaged or has an unsupported format.', REPO_CONFIG_FILE);
  }
  return config;
}

/**
 * Prove the passphrase against data already in the repository before any
 * new block is written. Without this, a wrong passphrase on a follow-up run
 * would encrypt new blocks with a different key and silently produce a
 * repository that no single passphrase can restore.
 */
async function verifyKey(repo: OpenRepo): Promise<void> {
  if (!repo.key) return;
  const names = await listManifests(repo);
  const encrypted = names.find((name) => name.endsWith('.enc'));
  if (encrypted) {
    await decryptOrThrow(repo.key, await readFile(repo.manifests, encrypted));
    return;
  }
  // no finished run yet — any block written by an aborted earlier run
  // still pins the key
  for await (const [, sub] of repo.blocks.entries()) {
    if (sub.kind !== 'directory') continue;
    for await (const [name, file] of sub.entries()) {
      // only real blocks pin the key — never a stray swap/temp file (e.g. a
      // leftover "<hash>.crswap" after a crash) or a .DS_Store
      if (file.kind !== 'file' || !HASH_RE.test(name)) continue;
      // an empty block is a leftover of an interrupted write, not a proof
      if ((await (file as FileSystemFileHandle).getFile()).size === 0) continue;
      await decryptOrThrow(repo.key, await readFile(sub, name));
      return;
    }
  }
}

async function loadKey(config: RepoConfig, passphrase?: string): Promise<CryptoKey | null> {
  if (!config.encrypted) {
    if (passphrase) {
      throw new EngineError('repo-unencrypted', 'This repository was created without encryption.');
    }
    return null;
  }
  if (!passphrase || !config.kdf) {
    throw new EngineError('passphrase-required', 'This repository is encrypted — passphrase required.');
  }
  return deriveKey(passphrase, config.kdf.salt, config.kdf.iterations);
}

/** Open or create the per-task repository below the destination directory. */
export async function openOrInitRepo(
  dest: FileSystemDirectoryHandle,
  taskName: string,
  passphrase?: string,
  repoSlug?: string
): Promise<OpenRepo> {
  const root = await getDirByPath(dest, [REPO_DIR, repoSlug || slugify(taskName)], true);
  let config: RepoConfig;
  const existing = await readFileIfExists(root, REPO_CONFIG_FILE);
  if (existing) {
    config = parseRepoConfig(existing);
  } else {
    config = {
      format: 1,
      createdAt: new Date().toISOString(),
      taskName,
      compression: 'gzip',
      encrypted: Boolean(passphrase),
      kdf: passphrase
        ? { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: randomSaltB64() }
        : null,
    };
    await writeFileRetry(root, REPO_CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  const key = await loadKey(config, passphrase);
  const repo: OpenRepo = {
    root,
    blocks: await root.getDirectoryHandle(BLOCKS_DIR, { create: true }),
    manifests: await root.getDirectoryHandle(MANIFESTS_DIR, { create: true }),
    config,
    key,
  };
  if (existing) await verifyKey(repo);
  return repo;
}

/** Open an existing repository (for restore); `dir` must contain ab-repo.json. */
export async function openRepo(
  dir: FileSystemDirectoryHandle,
  passphrase?: string
): Promise<OpenRepo> {
  const raw = await readFileIfExists(dir, REPO_CONFIG_FILE);
  if (!raw) {
    throw new EngineError('not-a-repo', `"${dir.name}" is not an all backed repository.`, dir.name);
  }
  const config = parseRepoConfig(raw);
  const key = await loadKey(config, passphrase);
  // a repo whose first run never got to write anything has no blocks/ or
  // manifests/ yet — treat that as "no versions" instead of crashing
  return {
    root: dir,
    blocks: await dir.getDirectoryHandle(BLOCKS_DIR, { create: false }).catch(() => {
      throw new EngineError('repo-invalid', `"${dir.name}" has no blocks/ folder.`, `${dir.name}/${BLOCKS_DIR}/`);
    }),
    manifests: await dir.getDirectoryHandle(MANIFESTS_DIR, { create: false }).catch(() => {
      throw new EngineError('repo-invalid', `"${dir.name}" has no manifests/ folder.`, `${dir.name}/${MANIFESTS_DIR}/`);
    }),
    config,
    key,
  };
}

/** Human-readable repo label: the task name from ab-repo.json, if readable. */
async function repoLabel(handle: FileSystemDirectoryHandle): Promise<string> {
  const raw = await readFileIfExists(handle, REPO_CONFIG_FILE);
  if (!raw) return handle.name;
  try {
    return (JSON.parse(decoder.decode(raw)) as RepoConfig).taskName || handle.name;
  } catch {
    return handle.name;
  }
}

/**
 * Find task repositories reachable from a user-picked directory: the picked
 * directory itself, `<picked>/allbacked/*`, or `<picked>/*` when the user
 * picked the `allbacked` folder directly.
 */
export async function findRepos(
  dir: FileSystemDirectoryHandle
): Promise<{ name: string; handle: FileSystemDirectoryHandle }[]> {
  if (await fileExists(dir, REPO_CONFIG_FILE)) {
    return [{ name: await repoLabel(dir), handle: dir }];
  }
  let container = dir;
  try {
    container = await dir.getDirectoryHandle(REPO_DIR);
  } catch {
    // maybe the user picked the allbacked folder itself
  }
  const repos: { name: string; handle: FileSystemDirectoryHandle }[] = [];
  for await (const [, handle] of container.entries()) {
    if (handle.kind === 'directory' && (await fileExists(handle, REPO_CONFIG_FILE))) {
      repos.push({ name: await repoLabel(handle), handle });
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listManifests(repo: OpenRepo): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of repo.manifests.entries()) {
    if (handle.kind !== 'file' || !/^manifest-.+\.json(\.enc)?$/.test(name)) continue;
    // a 0-byte manifest is a run interrupted while writing it (tab closed,
    // crash) — not a version; it would otherwise fail every unlock
    if ((await (handle as FileSystemFileHandle).getFile()).size === 0) continue;
    names.push(name);
  }
  return names.sort().reverse(); // newest first (ISO timestamps in name)
}

export async function readManifest(repo: OpenRepo, name: string): Promise<Manifest> {
  let raw = await readFile(repo.manifests, name);
  if (name.endsWith('.enc')) {
    if (!repo.key) throw new EngineError('passphrase-required', 'Encrypted manifest — passphrase required.');
    raw = await decryptOrThrow(repo.key, raw);
  } else if (repo.key) {
    // an encrypted repo never writes plaintext manifests — a planted one
    // must not be trusted
    throw new EngineError('manifest-invalid', `Unencrypted manifest in an encrypted repository: ${name}`, name);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    throw new EngineError('manifest-invalid', `Manifest ${name} is not valid JSON.`, name);
  }
  return validateManifest(parsed, name);
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** Reject a path that could escape the restore target or is not portable. */
export function safeRelativePath(path: unknown): string[] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return null;
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (/^[A-Za-z]:$/.test(parts[0])) return null; // Windows drive letter
  return parts;
}

/** Structural validation of a decoded manifest (defends restore). */
export function validateManifest(value: unknown, name = 'manifest'): Manifest {
  const m = value as Manifest;
  const bad = (why: string, path?: unknown) =>
    new EngineError('manifest-invalid', `Manifest ${name}: ${why}`, typeof path === 'string' ? `${name}: ${path}` : name);
  if (!m || typeof m !== 'object' || m.format !== 1 || !Array.isArray(m.files)) {
    throw bad('unsupported format');
  }
  for (const file of m.files) {
    if (!file || typeof file !== 'object') throw bad('bad file entry');
    if (!safeRelativePath(file.path)) throw bad(`unsafe path ${JSON.stringify(file.path)}`, file.path);
    if (!Number.isFinite(file.size) || file.size < 0) throw bad(`bad size for ${file.path}`, file.path);
    if (!Array.isArray(file.chunks) || !file.chunks.every((c) => typeof c === 'string' && HASH_RE.test(c))) {
      throw bad(`bad chunk list for ${file.path}`, file.path);
    }
  }
  return m;
}

export async function writeManifest(repo: OpenRepo, manifest: Manifest): Promise<string> {
  const stamp = manifest.createdAt.replace(/[:.]/g, '-');
  const json = new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer;
  const name = repo.key ? `manifest-${stamp}.json.enc` : `manifest-${stamp}.json`;
  const data = repo.key ? await encrypt(repo.key, json) : json;
  await writeFileRetry(repo.manifests, name, data);
  return name;
}

export async function decryptOrThrow(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    return await decrypt(key, data);
  } catch {
    throw new EngineError('passphrase-wrong', 'Decryption failed — wrong passphrase?');
  }
}

/** Encode a plaintext chunk for storage (compress, then encrypt). */
export async function encodeBlock(repo: OpenRepo, plain: ArrayBuffer): Promise<ArrayBuffer> {
  const packed = await gzip(plain);
  return repo.key ? encrypt(repo.key, packed) : packed;
}

/** Decode a stored block back to the plaintext chunk. */
export async function decodeBlock(repo: OpenRepo, stored: ArrayBuffer): Promise<ArrayBuffer> {
  const packed = repo.key ? await decryptOrThrow(repo.key, stored) : stored;
  return gunzip(packed);
}
