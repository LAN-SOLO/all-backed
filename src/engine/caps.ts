// Capability detection. Chromium exposes the full File System Access API
// (directory pickers + writable handles on user folders); Firefox does not,
// so there the app runs in fallback mode: sources are picked with a
// webkitdirectory input, repositories are staged in OPFS and exported as
// .tar downloads. Append ?fallback to the URL to force fallback mode for
// testing in Chrome.

export const supportsFsAccess: boolean =
  typeof window !== 'undefined' &&
  'showDirectoryPicker' in window &&
  !new URLSearchParams(window.location.search).has('fallback');

/** Persistent OPFS staging area for fallback-mode repositories. */
export async function opfsRepoContainer(taskId: string): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  const repos = await opfs.getDirectoryHandle('repos', { create: true });
  return repos.getDirectoryHandle(taskId, { create: true });
}

/** Fresh (emptied) OPFS scratch directory, e.g. for tar import/export. */
export async function opfsScratch(name: string): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(name, { recursive: true }).catch(() => {});
  return opfs.getDirectoryHandle(name, { create: true });
}

/** Scratch folders that may hold decrypted or imported data. */
export const SCRATCH_DIRS = ['restore-import', 'restore-out'] as const;
const SCRATCH_LOCK = 'ab-scratch';

/**
 * Run `work` while holding the scratch lock, so a second app tab cannot wipe
 * the scratch area mid-restore.
 */
export async function withScratchLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return work();
  return navigator.locks.request(SCRATCH_LOCK, work);
}

/**
 * Archive mode leaves the last import (and the decrypted restore result) in
 * OPFS so the download can finish. Wipe it on the next app start — restored
 * plaintext must not linger in browser storage.
 */
export async function cleanupScratch(): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  const wipe = async () => {
    const opfs = await navigator.storage.getDirectory();
    for (const name of SCRATCH_DIRS) {
      await opfs.removeEntry(name, { recursive: true }).catch(() => {});
    }
  };
  if (!navigator.locks) return wipe();
  await navigator.locks.request(SCRATCH_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) await wipe();
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (import.meta.env.DEV) {
    // test hook: lets the E2E driver grab exports without touching ~/Downloads
    (window as unknown as { __lastDownload?: { name: string; blob: Blob } }).__lastDownload = {
      name: filename,
      blob,
    };
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
