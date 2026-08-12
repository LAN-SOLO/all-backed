// Crypto + compression primitives. Everything runs locally via WebCrypto
// and CompressionStream — no external libraries, nothing leaves the device.

const IV_BYTES = 12;

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomSaltB64(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...salt));
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function deriveKey(
  passphrase: string,
  saltB64: string,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Returns iv || ciphertext. */
export async function encrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out.buffer;
}

export async function decrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const iv = bytes.slice(0, IV_BYTES);
  const ct = bytes.slice(IV_BYTES);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

async function pipeThrough(
  buf: ArrayBuffer,
  transform: CompressionStream | DecompressionStream
): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(transform);
  return new Response(stream).arrayBuffer();
}

export function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return pipeThrough(buf, new CompressionStream('gzip'));
}

export function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return pipeThrough(buf, new DecompressionStream('gzip'));
}
