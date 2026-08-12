// Thin helpers over the File System Access API. All engine code accesses
// directories exclusively through handles, so the same code runs against
// user-picked folders and against OPFS (used by the self-test).

import { EngineError } from './types';

export interface WalkedFile {
  path: string;
  handle: FileSystemFileHandle;
}

export async function* walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix = ''
): AsyncGenerator<WalkedFile> {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      yield { path, handle };
    } else {
      yield* walkFiles(handle, path);
    }
  }
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite'
): Promise<void> {
  if ((await handle.queryPermission({ mode })) === 'granted') return;
  if ((await handle.requestPermission({ mode })) === 'granted') return;
  throw new EngineError('permission-denied', `Permission (${mode}) denied for "${handle.name}"`);
}

export async function fileExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | string
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function readFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<ArrayBuffer> {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return file.arrayBuffer();
}

export async function readFileIfExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<ArrayBuffer | null> {
  try {
    return await readFile(dir, name);
  } catch {
    return null;
  }
}

/** Resolve (and optionally create) a nested directory from a relative path. */
export async function getDirByPath(
  root: FileSystemDirectoryHandle,
  path: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of path) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}
