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

const byteLen = (value: string) => encoder.encode(value).length;
const MAX_OCTAL_11 = 0o77777777777; // largest size a classic header can hold (8 GiB - 1)

/** ustar name/prefix split by BYTE length, or null if the path doesn't fit. */
function splitPath(path: string): { name: string; prefix: string } | null {
  if (byteLen(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name.length > 0 && byteLen(prefix) <= 155 && byteLen(name) <= 100) return { name, prefix };
  }
  return null;
}

function header(
  name: string,
  prefix: string,
  size: number,
  mtimeSec: number,
  typeflag: string
): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(BLOCK);
  writeStr(head, 0, name, 100);
  writeStr(head, 100, '0000644', 8);
  writeStr(head, 108, '0000000', 8);
  writeStr(head, 116, '0000000', 8);
  writeOctal(head, 124, size, 12);
  writeOctal(head, 136, mtimeSec, 12);
  head[156] = typeflag.charCodeAt(0);
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

/** One pax record: "<len> <key>=<value>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = byteLen(body) + 1;
  while (String(len).length + byteLen(body) !== len) len = String(len).length + byteLen(body);
  return `${len}${body}`;
}

/** ASCII-only stand-in name for readers that ignore pax headers. */
function fallbackName(path: string): string {
  const tail = path.split('/').pop() ?? 'file';
  const ascii = tail.replace(/[^\x20-\x7e]/g, '_');
  return ascii.slice(Math.max(0, ascii.length - 100)) || 'file';
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
    let split = splitPath(entry.path);
    // long/multibyte paths and files >= 8 GiB go through a pax extended
    // header (POSIX.1-2001) — readable by tar, bsdtar, 7-Zip and Windows tar
    if (!split || size > MAX_OCTAL_11) {
      let records = '';
      if (!split) records += paxRecord('path', entry.path);
      if (size > MAX_OCTAL_11) records += paxRecord('size', String(size));
      const data = encoder.encode(records);
      parts.push(header(`PaxHeader/${fallbackName(entry.path)}`.slice(0, 100), '', data.length, now, 'x'));
      parts.push(data);
      const paxPad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (paxPad > 0) parts.push(new Uint8Array(paxPad));
      split = split ?? { name: fallbackName(entry.path), prefix: '' };
    }
    parts.push(header(split.name, split.prefix, Math.min(size, MAX_OCTAL_11), now, '0'));
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

function parsePax(text: string): [string, string][] {
  const out: [string, string][] = [];
  // records are length-prefixed in BYTES; work on the encoded form
  const bytes = encoder.encode(text);
  const dec = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    let j = i;
    while (j < bytes.length && bytes[j] !== 32) j++;
    const len = parseInt(dec.decode(bytes.subarray(i, j)), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > bytes.length) break;
    const record = dec.decode(bytes.subarray(j + 1, i + len - 1)); // drop trailing \n
    const eq = record.indexOf('=');
    if (eq > 0) out.push([record.slice(0, eq), record.slice(eq + 1)]);
    i += len;
  }
  return out;
}

/** Iterate archive entries without loading the whole archive into memory. */
export async function* iterTar(archive: Blob): AsyncGenerator<TarFileRef> {
  const decoder = new TextDecoder();
  let pos = 0;
  let ended = false;
  // pending overrides from a pax ('x') or GNU long-name ('L') entry
  let nextPath: string | null = null;
  let nextSize: number | null = null;
  while (pos + BLOCK <= archive.size) {
    const head = new Uint8Array(await archive.slice(pos, pos + BLOCK).arrayBuffer());
    if (head.every((b) => b === 0)) {
      ended = true;
      break;
    }
    const readStr = (offset: number, length: number) => {
      const slice = head.subarray(offset, offset + length);
      const end = slice.indexOf(0);
      return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
    };
    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const sizeField = readStr(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) {
      throw new Error(`not a valid tar archive (bad header at byte ${pos})`);
    }
    let size = parseInt(sizeField || '0', 8);
    // header checksum: catches non-tar files and truncated/damaged archives
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
    const stored = parseInt(readStr(148, 8).trim() || 'x', 8);
    if (stored !== sum) {
      throw new Error(`not a valid tar archive (checksum mismatch at byte ${pos})`);
    }
    const typeflag = String.fromCharCode(head[156]);
    const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '7';
    if (isFile && nextSize !== null) size = nextSize;
    if (pos + BLOCK + size > archive.size) {
      throw new Error('tar archive is truncated');
    }
    pos += BLOCK;
    if (typeflag === 'x' || typeflag === 'L') {
      const text = decoder.decode(await archive.slice(pos, pos + size).arrayBuffer());
      if (typeflag === 'L') {
        nextPath = text.replace(/\0+$/, '');
      } else {
        for (const [key, value] of parsePax(text)) {
          if (key === 'path') nextPath = value;
          if (key === 'size' && /^\d+$/.test(value)) nextSize = Number(value);
        }
      }
    } else {
      if (isFile) {
        yield {
          path: nextPath ?? (prefix ? `${prefix}/${name}` : name),
          size,
          data: archive.slice(pos, pos + size),
        };
      }
      nextPath = null;
      nextSize = null;
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  // every tar ends with zero blocks; a missing end marker means the
  // download/copy was cut off and later entries are missing
  if (!ended) throw new Error('tar archive is truncated');
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
    // zip-slip guard: '..' / '.' / empty segments are dropped, backslashes
    // (Windows-made archives) count as separators, drive letters are ignored
    const parts = entry.path
      .split(/[/\\]/)
      .filter((p) => p !== '' && p !== '.' && p !== '..' && !/^[A-Za-z]:$/.test(p));
    if (parts.length === 0) continue;
    const fileName = parts.pop()!;
    const target = await getDirByPath(dir, parts, true);
    await writeFile(target, fileName, entry.data);
    count += 1;
  }
  return count;
}
