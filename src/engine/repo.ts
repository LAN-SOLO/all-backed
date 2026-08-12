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
import { fileExists, getDirByPath, readFile, readFileIfExists, writeFile } from './fsx';

export interface OpenRepo {
  root: FileSystemDirectoryHandle;
  blocks: FileSystemDirectoryHandle;
  manifests: FileSystemDirectoryHandle;
  config: RepoConfig;
  key: CryptoKey | null;
}

const decoder = new TextDecoder();

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
  passphrase?: string
): Promise<OpenRepo> {
  const root = await getDirByPath(dest, [REPO_DIR, slugify(taskName)], true);
  let config: RepoConfig;
  const existing = await readFileIfExists(root, REPO_CONFIG_FILE);
  if (existing) {
    config = JSON.parse(decoder.decode(existing)) as RepoConfig;
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
    await writeFile(root, REPO_CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  const key = await loadKey(config, passphrase);
  return {
    root,
    blocks: await root.getDirectoryHandle(BLOCKS_DIR, { create: true }),
    manifests: await root.getDirectoryHandle(MANIFESTS_DIR, { create: true }),
    config,
    key,
  };
}

/** Open an existing repository (for restore); `dir` must contain ab-repo.json. */
export async function openRepo(
  dir: FileSystemDirectoryHandle,
  passphrase?: string
): Promise<OpenRepo> {
  const raw = await readFileIfExists(dir, REPO_CONFIG_FILE);
  if (!raw) {
    throw new EngineError('not-a-repo', `"${dir.name}" is not an all backed repository.`);
  }
  const config = JSON.parse(decoder.decode(raw)) as RepoConfig;
  const key = await loadKey(config, passphrase);
  return {
    root: dir,
    blocks: await dir.getDirectoryHandle(BLOCKS_DIR, { create: false }),
    manifests: await dir.getDirectoryHandle(MANIFESTS_DIR, { create: false }),
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
  for await (const name of repo.manifests.keys()) {
    if (name.startsWith('manifest-')) names.push(name);
  }
  return names.sort().reverse(); // newest first (ISO timestamps in name)
}

export async function readManifest(repo: OpenRepo, name: string): Promise<Manifest> {
  let raw = await readFile(repo.manifests, name);
  if (name.endsWith('.enc')) {
    if (!repo.key) throw new EngineError('passphrase-required', 'Encrypted manifest — passphrase required.');
    raw = await decryptOrThrow(repo.key, raw);
  }
  return JSON.parse(decoder.decode(raw)) as Manifest;
}

export async function writeManifest(repo: OpenRepo, manifest: Manifest): Promise<string> {
  const stamp = manifest.createdAt.replace(/[:.]/g, '-');
  const json = new TextEncoder().encode(JSON.stringify(manifest)).buffer as ArrayBuffer;
  const name = repo.key ? `manifest-${stamp}.json.enc` : `manifest-${stamp}.json`;
  const data = repo.key ? await encrypt(repo.key, json) : json;
  await writeFile(repo.manifests, name, data);
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
