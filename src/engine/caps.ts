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

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
