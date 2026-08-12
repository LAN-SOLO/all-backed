// End-to-end self-test of the backup engine, running entirely against OPFS
// (origin-private file system) so it needs no user gestures or native pickers.
// Exposed as window.abSelfTest() in dev builds; drives the exact same code
// paths as a real backup to an external drive.

import { runBackup } from './backup';
import { runRestore } from './restore';
import { findRepos, listManifests, openRepo } from './repo';
import { walkFiles, readFile, writeFile, getDirByPath } from './fsx';
import { EngineError } from './types';

type Log = (line: string) => void;

const PASS = 'correct horse battery staple';

async function makeSourceTree(root: FileSystemDirectoryHandle): Promise<void> {
  await writeFile(root, 'hello.txt', 'hello all backed\n');
  await writeFile(root, 'empty.bin', new ArrayBuffer(0));
  const nested = await getDirByPath(root, ['docs', 'deep'], true);
  await writeFile(nested, 'notes.md', '# notes\nsame content\n');
  // duplicate content in a second file → must dedup against notes.md
  const docs = await root.getDirectoryHandle('docs');
  await writeFile(docs, 'copy.md', '# notes\nsame content\n');
  // deterministic multi-chunk binary (chunkSize 64 KiB in the test run)
  const big = new Uint8Array(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251;
  await writeFile(docs, 'big.bin', big.buffer);
}

async function assertTreesEqual(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle
): Promise<number> {
  const collect = async (dir: FileSystemDirectoryHandle) => {
    const map = new Map<string, ArrayBuffer>();
    for await (const f of walkFiles(dir)) {
      map.set(f.path, await (await f.handle.getFile()).arrayBuffer());
    }
    return map;
  };
  const [ma, mb] = [await collect(a), await collect(b)];
  if (ma.size !== mb.size) throw new Error(`file count mismatch: ${ma.size} vs ${mb.size}`);
  for (const [path, bufA] of ma) {
    const bufB = mb.get(path);
    if (!bufB) throw new Error(`missing after restore: ${path}`);
    const [x, y] = [new Uint8Array(bufA), new Uint8Array(bufB)];
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) {
      throw new Error(`content mismatch: ${path}`);
    }
  }
  return ma.size;
}

export async function abSelfTest(log: Log = (l) => console.log(l)): Promise<boolean> {
  const t = (m: string) => log(`[ABTEST] ${m}`);
  try {
    const opfs = await navigator.storage.getDirectory();
    for (const name of ['ab-src', 'ab-dst', 'ab-restore']) {
      await opfs.removeEntry(name, { recursive: true }).catch(() => {});
    }
    const src = await opfs.getDirectoryHandle('ab-src', { create: true });
    const dst = await opfs.getDirectoryHandle('ab-dst', { create: true });
    const restoreTarget = await opfs.getDirectoryHandle('ab-restore', { create: true });
    await makeSourceTree(src);
    t('source tree created');

    const run1 = await runBackup({
      source: src,
      dest: dst,
      taskName: 'Selbsttest',
      passphrase: PASS,
      chunkSize: 64 * 1024,
    });
    t(`backup #1: ${run1.fileCount} files, ${run1.totalBytes} B, new=${run1.newBlocks} dedup=${run1.dedupBlocks} verified=${run1.verifiedOk}`);
    if (run1.fileCount !== 5) throw new Error(`expected 5 files, got ${run1.fileCount}`);
    // hello(1) + empty(1) + notes(1, copy dedups) + big(4×64KiB→200KiB=4 chunks) = 7 new
    if (run1.dedupBlocks < 1) throw new Error('expected dedup within first run (copy.md)');

    const run2 = await runBackup({
      source: src,
      dest: dst,
      taskName: 'Selbsttest',
      passphrase: PASS,
      chunkSize: 64 * 1024,
    });
    t(`backup #2: new=${run2.newBlocks} dedup=${run2.dedupBlocks}`);
    if (run2.newBlocks !== 0) throw new Error(`second run must fully dedup, got ${run2.newBlocks} new`);

    const repos = await findRepos(dst);
    if (repos.length !== 1) throw new Error(`expected 1 repo, found ${repos.length}`);
    try {
      await openRepo(repos[0].handle, 'wrong-passphrase');
      const bad = await listManifests(await openRepo(repos[0].handle, 'wrong-passphrase'));
      // key derivation succeeds; decryption must fail
      await runRestore({
        repo: await openRepo(repos[0].handle, 'wrong-passphrase'),
        manifestName: bad[0],
        target: restoreTarget,
      });
      throw new Error('wrong passphrase was accepted');
    } catch (err) {
      if (!(err instanceof EngineError) || err.code !== 'passphrase-wrong') throw err;
      t('wrong passphrase correctly rejected');
    }

    const repo = await openRepo(repos[0].handle, PASS);
    const manifests = await listManifests(repo);
    t(`manifests: ${manifests.length}`);
    if (manifests.length !== 2) throw new Error(`expected 2 manifests, got ${manifests.length}`);

    const restored = await runRestore({ repo, manifestName: manifests[0], target: restoreTarget });
    const compared = await assertTreesEqual(src, restoreTarget);
    t(`restore: ${restored.fileCount} files restored, ${compared} files byte-identical`);

    // sanity: stored blocks must not contain plaintext
    const blocks = await repos[0].handle.getDirectoryHandle('blocks');
    for await (const [, sub] of blocks.entries()) {
      if (sub.kind !== 'directory') continue;
      for await (const name of sub.keys()) {
        const data = new Uint8Array(await readFile(sub, name));
        const text = new TextDecoder('utf-8', { fatal: false }).decode(data.slice(0, 256));
        if (text.includes('hello all backed') || text.includes('same content')) {
          throw new Error('plaintext found in stored block');
        }
      }
      break;
    }
    t('stored blocks are opaque (no plaintext)');

    t('PASS — engine end-to-end OK');
    return true;
  } catch (err) {
    t(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
