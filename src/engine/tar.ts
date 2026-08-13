// Minimal ustar reader/writer, streaming-friendly. Used by the Firefox/Safari
// fallback path: repositories staged in OPFS are exported as a single .tar
// download, and restore reads such an archive back in.
//
// Memory model: entry data is carried as Blob references wherever possible —
// building the archive composes Blob parts without materializing file
// contents, and parsing slices the source Blob instead of loading it whole.

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
    if (path[i] === '/') {
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
  /** Blob parts are composed by reference — contents are not loaded into RAM. */
  data: Blob | ArrayBuffer;
}

export function buildTar(entries: TarEntry[]): Blob {
  const parts: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const size = entry.data instanceof Blob ? entry.data.size : entry.data.byteLength;
    parts.push(header(entry.path, size, now));
    parts.push(entry.data);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Blob(parts, { type: 'application/x-tar' });
}

export interface TarFileRef {
  path: string;
  size: number;
  /** Lazy slice of the source archive — read it only when needed. */
  data: Blob;
}

/** Iterate archive entries without loading the whole archive into memory. */
export async function* iterTar(archive: Blob): AsyncGenerator<TarFileRef> {
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos + BLOCK <= archive.size) {
    const head = new Uint8Array(await archive.slice(pos, pos + BLOCK).arrayBuffer());
    if (head.every((b) => b === 0)) break;
    const readStr = (offset: number, length: number) => {
      const slice = head.subarray(offset, offset + length);
      const end = slice.indexOf(0);
      return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
    };
    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const size = parseInt(readStr(124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(head[156]);
    pos += BLOCK;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      yield {
        path: prefix ? `${prefix}/${name}` : name,
        size,
        data: archive.slice(pos, pos + size),
      };
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** Tar every file below `dir` (paths relative to `dir`), by reference. */
export async function tarDirectory(dir: FileSystemDirectoryHandle): Promise<Blob> {
  const entries: TarEntry[] = [];
  for await (const item of walkFiles(dir)) {
    entries.push({ path: item.path, data: await item.handle.getFile() });
  }
  return buildTar(entries);
}

/** Unpack an archive into `dir`, creating subdirectories as needed. */
export async function untarToDirectory(
  archive: Blob,
  dir: FileSystemDirectoryHandle
): Promise<number> {
  let count = 0;
  for await (const entry of iterTar(archive)) {
    const parts = entry.path.split('/').filter((p) => p !== '' && p !== '.' && p !== '..');
    if (parts.length === 0) continue;
    const fileName = parts.pop()!;
    const target = await getDirByPath(dir, parts, true);
    await writeFile(target, fileName, entry.data);
    count += 1;
  }
  return count;
}
