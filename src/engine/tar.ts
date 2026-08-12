// Minimal ustar reader/writer. Used by the Firefox fallback path: repositories
// staged in OPFS are exported as a single .tar download, and restore reads
// such an archive back in. No compression here — blocks are already gzip'd.

import { getDirByPath, walkFiles, writeFile } from './fsx';

const BLOCK = 512;
const encoder = new TextEncoder();

function writeStr(view: Uint8Array, offset: number, value: string, length: number) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field overflow: ${value}`);
  view.set(bytes, offset);
}

function writeOctal(view: Uint8Array, offset: number, value: number, length: number) {
  // length-1 octal digits, NUL-terminated
  writeStr(view, offset, value.toString(8).padStart(length - 1, '0'), length - 1);
}

function splitPath(path: string): { name: string; prefix: string } {
  if (path.length <= 100) return { name: path, prefix: '' };
  // split at a '/' so that name <= 100 and prefix <= 155
  for (let i = path.length - 101; i < path.length; i++) {
    if (path[i] === '/' ) {
      const prefix = path.slice(0, i);
      const name = path.slice(i + 1);
      if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
    }
  }
  throw new Error(`path too long for tar: ${path}`);
}

function header(path: string, size: number, mtimeSec: number): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(path);
  writeStr(head, 0, name, 100);
  writeStr(head, 100, '0000644', 8);
  writeStr(head, 108, '0000000', 8);
  writeStr(head, 116, '0000000', 8);
  writeOctal(head, 124, size, 12);
  writeOctal(head, 136, mtimeSec, 12);
  head[156] = 48; // typeflag '0' — regular file
  writeStr(head, 257, 'ustar', 6);
  writeStr(head, 263, '00', 2);
  if (prefix) writeStr(head, 345, prefix, 155);
  // checksum: field treated as spaces
  head.fill(32, 148, 156);
  let sum = 0;
  for (const byte of head) sum += byte;
  writeStr(head, 148, sum.toString(8).padStart(6, '0'), 7);
  head[155] = 32;
  return head;
}

export interface TarEntry {
  path: string;
  data: ArrayBuffer;
}

export function buildTar(entries: TarEntry[]): Blob {
  const parts: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    parts.push(header(entry.path, entry.data.byteLength, now));
    parts.push(entry.data);
    const pad = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Blob(parts, { type: 'application/x-tar' });
}

export async function parseTar(archive: Blob): Promise<TarEntry[]> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const decoder = new TextDecoder();
  const readStr = (offset: number, length: number) => {
    const slice = bytes.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  };
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + BLOCK <= bytes.length) {
    const block = bytes.subarray(pos, pos + BLOCK);
    if (block.every((b) => b === 0)) break;
    const name = readStr(pos, 100);
    const prefix = readStr(pos + 345, 155);
    const size = parseInt(readStr(pos + 124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(bytes[pos + 156]);
    pos += BLOCK;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const data = bytes.slice(pos, pos + size).buffer;
      entries.push({ path: prefix ? `${prefix}/${name}` : name, data });
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Tar every file below `dir` (paths relative to `dir`). */
export async function tarDirectory(dir: FileSystemDirectoryHandle): Promise<Blob> {
  const entries: TarEntry[] = [];
  for await (const item of walkFiles(dir)) {
    const file = await item.handle.getFile();
    entries.push({ path: item.path, data: await file.arrayBuffer() });
  }
  return buildTar(entries);
}

/** Unpack an archive into `dir`, creating subdirectories as needed. */
export async function untarToDirectory(
  archive: Blob,
  dir: FileSystemDirectoryHandle
): Promise<number> {
  const entries = await parseTar(archive);
  for (const entry of entries) {
    const parts = entry.path.split('/').filter((p) => p !== '' && p !== '.' && p !== '..');
    if (parts.length === 0) continue;
    const fileName = parts.pop()!;
    const target = await getDirByPath(dir, parts, true);
    await writeFile(target, fileName, entry.data);
  }
  return entries.length;
}
