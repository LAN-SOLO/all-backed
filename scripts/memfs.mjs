// In-memory implementation of the File System Access API surface the engine
// uses (directory/file handles, writable streams). Mirrors Chromium's
// semantics where they matter for correctness:
//   - names '', '.', '..' and names containing '/' or '\' are rejected
//     (TypeError), so path traversal attempts fail exactly like in Chrome
//   - createWritable() writes to a swap buffer; close() commits atomically,
//     abort() discards (a failed restore must not leave a half file)
//   - missing entries throw NotFoundError, wrong kinds TypeMismatchError
// Used by scripts/selftest-node.mjs to run the engine self-test under Node.

function domError(name, message) {
  return new DOMException(message, name);
}

function checkName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`Name is not allowed: ${JSON.stringify(name)}`);
  }
}

async function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (data && typeof data === 'object' && data.type === 'write') return toBytes(data.data);
  throw new TypeError('unsupported write payload');
}

export class MemFileHandle {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.data = new Uint8Array(0);
    this.mtime = Date.now();
  }
  async getFile() {
    return new File([this.data], this.name, { lastModified: this.mtime });
  }
  async createWritable() {
    const parts = [];
    let state = 'open';
    return {
      write: async (data) => {
        if (state !== 'open') throw new TypeError('stream closed');
        parts.push(await toBytes(data));
      },
      close: async () => {
        if (state !== 'open') throw new TypeError('stream closed');
        state = 'closed';
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          out.set(p, off);
          off += p.length;
        }
        this.data = out;
        this.mtime = Date.now();
      },
      abort: async () => {
        state = 'aborted';
      },
    };
  }
  async queryPermission() {
    return 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
  async isSameEntry(other) {
    return other === this;
  }
}

export class MemDirHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }
  async getDirectoryHandle(name, opts = {}) {
    checkName(name);
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw domError('TypeMismatchError', `${name} is a file`);
      return existing;
    }
    if (!opts.create) throw domError('NotFoundError', `${name} not found`);
    const dir = new MemDirHandle(name);
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name, opts = {}) {
    checkName(name);
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw domError('TypeMismatchError', `${name} is a directory`);
      return existing;
    }
    if (!opts.create) throw domError('NotFoundError', `${name} not found`);
    const file = new MemFileHandle(name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name, opts = {}) {
    checkName(name);
    const existing = this.children.get(name);
    if (!existing) throw domError('NotFoundError', `${name} not found`);
    if (existing.kind === 'directory' && existing.children.size > 0 && !opts.recursive) {
      throw domError('InvalidModificationError', `${name} not empty`);
    }
    this.children.delete(name);
  }
  async *entries() {
    for (const [name, handle] of [...this.children]) yield [name, handle];
  }
  async *keys() {
    for (const name of [...this.children.keys()]) yield name;
  }
  async *values() {
    for (const handle of [...this.children.values()]) yield handle;
  }
  async queryPermission() {
    return 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
  async isSameEntry(other) {
    return other === this;
  }
}

/** Install navigator.storage.getDirectory() backed by a fresh memory root. */
export function installMemOpfs() {
  const root = new MemDirHandle('');
  const storage = {
    getDirectory: async () => root,
    estimate: async () => ({ quota: 1e12, usage: 0 }),
  };
  if (globalThis.navigator) {
    Object.defineProperty(globalThis.navigator, 'storage', { value: storage, configurable: true });
  } else {
    globalThis.navigator = { storage };
  }
  return root;
}
