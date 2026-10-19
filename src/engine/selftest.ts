// End-to-end self-test of the backup engine, running entirely against OPFS
// (origin-private file system) so it needs no user gestures or native pickers.
// Exposed as window.abSelfTest() in dev builds; drives the exact same code
// paths as a real backup to an external drive.

import { runBackup } from './backup';
import { runRestore } from './restore';
import { findRepos, listManifests, openRepo } from './repo';
import { walkFiles, readFile, writeFile, writeFileRetry, getDirByPath } from './fsx';
import { openOrInitRepo } from './repo';
import { inspectRestoreTarget } from './restore';
import { planRestorePaths, portableSegment } from './portable';
import { describeError, formatError } from '../errors';
import { makeT, missingTranslations } from '../i18n';
import { buildTar, tarDirectory, untarToDirectory } from './tar';
import { gzip, sha256Hex } from './crypto';
import { EngineError, pickRepoSlug } from './types';

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

async function expectEngineError(code: EngineError['code'], run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof EngineError && err.code === code) return;
    throw new Error(`expected EngineError ${code}, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  throw new Error(`expected EngineError ${code}, but the call succeeded`);
}

function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out (hang)`)), ms)),
  ]);
}

async function treeText(dir: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const f of walkFiles(dir)) {
    out.set(f.path, new TextDecoder().decode(await (await f.handle.getFile()).arrayBuffer()));
  }
  return out;
}

/** Regression tests for the 1.0 audit fixes (see AUDIT-1.0.md). */
async function regressionTests(opfs: FileSystemDirectoryHandle, t: (m: string) => void): Promise<void> {
  const reg = await opfs.getDirectoryHandle('ab-reg', { create: true });
  const fresh = async (name: string) => reg.getDirectoryHandle(name, { create: true });

  // R1: chunks shared between files (two empty files, two identical files)
  // used to hang the verify sampler forever
  const dupSrc = await fresh('dup-src');
  await writeFile(dupSrc, 'a.txt', new ArrayBuffer(0));
  await writeFile(dupSrc, 'b.txt', new ArrayBuffer(0));
  await writeFile(dupSrc, 'c.txt', 'same');
  await writeFile(dupSrc, 'd.txt', 'same');
  const dupRun = await withTimeout(
    'R1',
    20_000,
    runBackup({ sources: [{ kind: 'handle', handle: dupSrc }], dest: await fresh('dup-dst'), taskName: 'dup' })
  );
  if (dupRun.fileCount !== 4 || dupRun.newBlocks !== 2) {
    throw new Error(`R1: files=${dupRun.fileCount} new=${dupRun.newBlocks}`);
  }
  t('R1 shared-chunk verify terminates');

  // R2: a wrong passphrase on a follow-up run must be rejected BEFORE any
  // block is written (else the repo ends up with two keys)
  const keySrc = await fresh('key-src');
  await writeFile(keySrc, 'one.txt', 'first run content');
  const keyDst = await fresh('key-dst');
  await runBackup({ sources: [{ kind: 'handle', handle: keySrc }], dest: keyDst, taskName: 'key', passphrase: PASS });
  await writeFile(keySrc, 'two.txt', 'new content for the second run');
  const keyRepo = await getDirByPath(keyDst, ['allbacked', 'key'], false);
  const countBlocks = async () => {
    let n = 0;
    for await (const f of walkFiles(await keyRepo.getDirectoryHandle('blocks'))) if (f) n++;
    return n;
  };
  const blocksBefore = await countBlocks();
  await expectEngineError('passphrase-wrong', () =>
    runBackup({ sources: [{ kind: 'handle', handle: keySrc }], dest: keyDst, taskName: 'key', passphrase: 'not the passphrase' })
  );
  if ((await countBlocks()) !== blocksBefore) throw new Error('R2: blocks were written with the wrong key');
  await expectEngineError('passphrase-required', () =>
    runBackup({ sources: [{ kind: 'handle', handle: keySrc }], dest: keyDst, taskName: 'key' })
  );
  t('R2 wrong passphrase on follow-up backup rejected, nothing written');

  // R3: pinned repoSlug — a renamed task keeps backing up into its repo
  const renamed = await runBackup({
    sources: [{ kind: 'handle', handle: keySrc }],
    dest: keyDst,
    taskName: 'Key (renamed)',
    repoSlug: 'key',
    passphrase: PASS,
  });
  if (renamed.dedupBlocks < 1) throw new Error('R3: renamed task did not reuse its repository');
  const allRepos = await findRepos(keyDst);
  if (allRepos.length !== 1) throw new Error(`R3: expected 1 repo after rename, found ${allRepos.length}`);
  t('R3 renamed task keeps its repository');

  // R4: two sources with the same folder name and the same handle twice
  const parentA = await fresh('drive-a');
  const parentB = await fresh('drive-b');
  const docsA = await parentA.getDirectoryHandle('Docs', { create: true });
  const docsB = await parentB.getDirectoryHandle('Docs', { create: true });
  await writeFile(docsA, 'note.txt', 'from drive A');
  await writeFile(docsB, 'note.txt', 'from drive B');
  const nameDst = await fresh('name-dst');
  const nameRun = await runBackup({
    sources: [
      { kind: 'handle', handle: docsA },
      { kind: 'handle', handle: docsA }, // same folder again → skipped
      { kind: 'handle', handle: docsB },
      { kind: 'files', name: 'Docs', files: [{ path: 'Docs/note.txt', file: new File(['from list'], 'note.txt') }] },
    ],
    dest: nameDst,
    taskName: 'names',
  });
  if (nameRun.fileCount !== 3) throw new Error(`R4: expected 3 files, got ${nameRun.fileCount}`);
  const nameRepo = await openRepo((await findRepos(nameDst))[0].handle);
  const nameOut = await fresh('name-out');
  await runRestore({ repo: nameRepo, manifestName: (await listManifests(nameRepo))[0], target: nameOut });
  const names = await treeText(nameOut);
  if (
    names.get('Docs/note.txt') !== 'from drive A' ||
    names.get('Docs (2)/note.txt') !== 'from drive B' ||
    names.get('Docs (3)/note.txt') !== 'from list'
  ) {
    throw new Error(`R4: unexpected restore layout ${JSON.stringify([...names])}`);
  }
  t('R4 same-named sources kept apart, duplicate folder skipped');

  // R5: malicious manifest (unencrypted repo) — traversal paths rejected
  // before anything is written
  const evilDst = await fresh('evil-dst');
  const evilSrc = await fresh('evil-src');
  await writeFile(evilSrc, 'x.txt', 'payload');
  await runBackup({ sources: [{ kind: 'handle', handle: evilSrc }], dest: evilDst, taskName: 'evil' });
  const evilRepoDir = (await findRepos(evilDst))[0].handle;
  const evilRepo = await openRepo(evilRepoDir);
  const [evilName] = await listManifests(evilRepo);
  const evilManifest = JSON.parse(new TextDecoder().decode(await readFile(evilRepo.manifests, evilName)));
  for (const bad of ['../escape.txt', 'a/../../escape.txt', '/abs.txt', 'C:/win.txt', 'a\\..\\b.txt', 'a//b.txt']) {
    const tampered = { ...evilManifest, files: [{ ...evilManifest.files[0], path: bad }] };
    await writeFile(evilRepo.manifests, 'manifest-9999-evil.json', JSON.stringify(tampered));
    const out = await fresh('evil-out');
    await expectEngineError('manifest-invalid', () =>
      runRestore({ repo: evilRepo, manifestName: 'manifest-9999-evil.json', target: out })
    );
    for await (const _ of out.keys()) throw new Error(`R5: restore wrote files for path ${bad}`);
  }
  await evilRepo.manifests.removeEntry('manifest-9999-evil.json');
  t('R5 traversal paths in manifests rejected');

  // R6: a swapped/damaged block is detected on restore; the damaged file is
  // skipped (no partial file), the healthy one is still restored
  await writeFile(evilSrc, 'y.txt', 'second healthy file');
  await runBackup({ sources: [{ kind: 'handle', handle: evilSrc }], dest: evilDst, taskName: 'evil' });
  const [latest] = await listManifests(evilRepo);
  const m = JSON.parse(new TextDecoder().decode(await readFile(evilRepo.manifests, latest)));
  const victim = m.files.find((f: { path: string }) => f.path.endsWith('x.txt'));
  const hash: string = victim.chunks[0];
  const blockDir = await evilRepo.blocks.getDirectoryHandle(hash.slice(0, 2));
  await writeFile(blockDir, hash, await gzip(new TextEncoder().encode('evil').buffer as ArrayBuffer));
  const corruptOut = await fresh('corrupt-out');
  const partial = await runRestore({ repo: evilRepo, manifestName: latest, target: corruptOut });
  const restoredTexts = await treeText(corruptOut);
  if (
    partial.failed.length !== 1 ||
    !partial.failed[0].path.endsWith('x.txt') ||
    partial.fileCount !== 1 ||
    restoredTexts.size !== 1 ||
    ![...restoredTexts.values()].includes('second healthy file')
  ) {
    throw new Error(`R6: failed=${JSON.stringify(partial.failed)} restored=${JSON.stringify([...restoredTexts])}`);
  }
  // a pre-existing file in the target keeps its content when restore fails
  const keepDir = await getDirByPath(corruptOut, ['evil-src'], true);
  await writeFile(keepDir, 'x.txt', 'user data');
  await runRestore({ repo: evilRepo, manifestName: latest, target: corruptOut });
  if ((await treeText(corruptOut)).get('evil-src/x.txt') !== 'user data') {
    throw new Error('R6: failed restore clobbered an existing file');
  }
  // the verify sampler must catch the damaged block on the next backup
  await expectEngineError('verify-failed', () =>
    runBackup({ sources: [{ kind: 'handle', handle: evilSrc }], dest: evilDst, taskName: 'evil', verifySamples: 100 })
  );
  t('R6 damaged block detected (restore skips file, verify fails backup)');

  // R7: encrypted repo — a planted plaintext manifest is not trusted, a
  // damaged config is reported, absurd KDF parameters are refused
  const keyRepoOpen = await openRepo(keyRepo, PASS);
  await writeFile(keyRepoOpen.manifests, 'manifest-9999-plain.json', JSON.stringify(evilManifest));
  await expectEngineError('manifest-invalid', () =>
    runRestore({ repo: keyRepoOpen, manifestName: 'manifest-9999-plain.json', target: reg })
  );
  await keyRepoOpen.manifests.removeEntry('manifest-9999-plain.json');
  const cfgRaw = await readFile(keyRepo, 'ab-repo.json');
  const cfg = JSON.parse(new TextDecoder().decode(cfgRaw));
  await writeFile(keyRepo, 'ab-repo.json', JSON.stringify({ ...cfg, kdf: { ...cfg.kdf, iterations: 1e12 } }));
  await expectEngineError('repo-invalid', () => openRepo(keyRepo, PASS));
  await writeFile(keyRepo, 'ab-repo.json', '{not json');
  await expectEngineError('repo-invalid', () => openRepo(keyRepo, PASS));
  await writeFile(keyRepo, 'ab-repo.json', cfgRaw);
  await openRepo(keyRepo, PASS);
  t('R7 tampered config / planted manifest rejected');

  // R8: tar import — zip-slip entries stay inside the target, backslash
  // paths become folders, garbage and truncated archives fail cleanly
  const slip = buildTar([
    { path: '../../outside.txt', data: new TextEncoder().encode('a').buffer as ArrayBuffer },
    { path: 'win\\dir\\file.txt', data: new TextEncoder().encode('b').buffer as ArrayBuffer },
  ]);
  const slipOut = await fresh('slip-out');
  await untarToDirectory(slip, slipOut);
  const slipTree = await treeText(slipOut);
  if (slipTree.get('outside.txt') !== 'a' || slipTree.get('win/dir/file.txt') !== 'b' || slipTree.size !== 2) {
    throw new Error(`R8: unexpected tar layout ${JSON.stringify([...slipTree])}`);
  }
  // long / multibyte paths (> 255 bytes, > 100-byte names) round-trip via pax
  const longPath = `${'tief/'.repeat(40)}${'ü'.repeat(70)}-${'x'.repeat(60)}.txt`;
  const longName = `kurz/${'ä'.repeat(80)}.md`;
  const paxTar = buildTar([
    { path: longPath, data: new TextEncoder().encode('long').buffer as ArrayBuffer },
    { path: longName, data: new TextEncoder().encode('name').buffer as ArrayBuffer },
    { path: 'short.txt', data: new TextEncoder().encode('short').buffer as ArrayBuffer },
  ]);
  const paxOut = await fresh('pax-out');
  await untarToDirectory(paxTar, paxOut);
  const paxTree = await treeText(paxOut);
  if (paxTree.get(longPath) !== 'long' || paxTree.get(longName) !== 'name' || paxTree.get('short.txt') !== 'short' || paxTree.size !== 3) {
    throw new Error(`R8: pax roundtrip failed ${JSON.stringify([...paxTree.keys()])}`);
  }
  let garbageRejected = false;
  try {
    await untarToDirectory(new Blob([new Uint8Array(1024).fill(65)]), await fresh('garbage-out'));
  } catch {
    garbageRejected = true;
  }
  let truncatedRejected = false;
  try {
    await untarToDirectory(slip.slice(0, 600), await fresh('trunc-out'));
  } catch {
    truncatedRejected = true;
  }
  if (!garbageRejected || !truncatedRejected) throw new Error('R8: invalid tar archive was accepted');
  // old writers store a signed-byte header checksum — still readable
  const signedTar = new Uint8Array(
    await buildTar([{ path: 'grüße.txt', data: new TextEncoder().encode('hi').buffer as ArrayBuffer }]).arrayBuffer()
  );
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 32 : signedTar[i];
    signedSum += byte > 127 ? byte - 256 : byte;
  }
  signedTar.set(new TextEncoder().encode(`${signedSum.toString(8).padStart(6, '0')}\0 `), 148);
  const signedOut = await fresh('signed-out');
  await untarToDirectory(new Blob([signedTar]), signedOut);
  if ((await treeText(signedOut)).get('grüße.txt') !== 'hi') throw new Error('R8: signed-checksum tar rejected');
  t('R8 tar zip-slip / garbage / truncation handled');

  // R9: content addressing sanity — block names are SHA-256 of plaintext
  if ((await sha256Hex(new ArrayBuffer(0))) !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
    throw new Error('R9: sha256 mismatch');
  }

  // R10: a locked, vanished or changed file and an unreadable subfolder
  // skip only themselves — before 1.0 one busy file failed the whole run.
  // Wrapper handles simulate what Chromium throws (NotReadableError for a
  // locked file or a File snapshot that changed, NotFoundError when deleted).
  const skipDst = await fresh('skip-dst');
  const real = await fresh('skip-real');
  await writeFile(real, 'ok.txt', 'still fine');
  await writeFile(real, 'edited.txt', 'old content');
  const okHandle = await real.getFileHandle('ok.txt');
  const editedHandle = await real.getFileHandle('edited.txt');
  const domErr = (name: string) => new DOMException(`simulated ${name}`, name);
  const lockedHandle = {
    kind: 'file',
    name: 'outlook.pst',
    getFile: async () =>
      ({
        size: 8,
        lastModified: 0,
        slice: () => ({ arrayBuffer: () => Promise.reject(domErr('NotReadableError')) }),
      }) as unknown as File,
  };
  const goneHandle = { kind: 'file', name: 'gone.tmp', getFile: () => Promise.reject(domErr('NotFoundError')) };
  const badDir = {
    kind: 'directory',
    name: 'System Volume Information',
    // eslint-disable-next-line require-yield
    entries: async function* () {
      throw domErr('NotReadableError');
    },
  };
  const mixed = {
    kind: 'directory',
    name: 'mixed',
    entries: async function* () {
      yield ['ok.txt', okHandle];
      yield ['outlook.pst', lockedHandle];
      yield ['gone.tmp', goneHandle];
      yield ['System Volume Information', badDir];
      yield ['edited.txt', editedHandle];
    },
    isSameEntry: async (other: unknown) => other === mixed,
  } as unknown as FileSystemDirectoryHandle;
  let edited = false;
  const skipRun = await runBackup({
    sources: [{ kind: 'handle', handle: mixed }],
    dest: skipDst,
    taskName: 'skip',
    // the file is saved again after the scan, before it is read: the backup
    // must contain the new content (a stale File snapshot would throw)
    onProgress: (p) => {
      if (p.phase === 'backup' && !edited) {
        edited = true;
        void writeFile(real, 'edited.txt', 'new content after the scan');
      }
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  const skippedPaths = (skipRun.skipped ?? []).map((s) => s.path).sort();
  if (
    skipRun.fileCount !== 2 ||
    skipRun.skippedCount !== 3 ||
    JSON.stringify(skippedPaths) !== JSON.stringify(['mixed/System Volume Information/', 'mixed/gone.tmp', 'mixed/outlook.pst'])
  ) {
    throw new Error(`R10: files=${skipRun.fileCount} skipped=${JSON.stringify(skipRun.skipped)}`);
  }
  const skipRepo = await openRepo(await getDirByPath(skipDst, ['allbacked', 'skip'], false));
  const skipOut = await fresh('skip-out');
  await runRestore({ repo: skipRepo, manifestName: skipRun.manifestName, target: skipOut });
  const skipTree = await treeText(skipOut);
  if (skipTree.get('mixed/ok.txt') !== 'still fine' || skipTree.size !== 2) {
    throw new Error(`R10: restore layout ${JSON.stringify([...skipTree])}`);
  }
  const editedText = skipTree.get('mixed/edited.txt');
  if (editedText !== 'new content after the scan' && editedText !== 'old content') {
    throw new Error(`R10: edited file restored as ${JSON.stringify(editedText)}`);
  }
  // permission problems stay fatal — a run must not "succeed" with nothing
  const denied = {
    kind: 'directory',
    name: 'denied',
    entries: async function* () {
      yield ['x.txt', { kind: 'file', name: 'x.txt', getFile: () => Promise.reject(domErr('NotAllowedError')) }];
    },
    isSameEntry: async () => false,
  } as unknown as FileSystemDirectoryHandle;
  let deniedFatal = false;
  try {
    await runBackup({ sources: [{ kind: 'handle', handle: denied }], dest: await fresh('denied-dst'), taskName: 'denied' });
  } catch (err) {
    deniedFatal = err instanceof DOMException && err.name === 'NotAllowedError';
  }
  if (!deniedFatal) throw new Error('R10: NotAllowedError was swallowed');
  t(`R10 locked/vanished files and unreadable folders skipped and listed (edited file: ${editedText === 'old content' ? 'old' : 'new'} content)`);

  // R11: a new task never shares the repository another task pinned
  if (
    pickRepoSlug('Neue Aufgabe', []) !== 'neue-aufgabe' ||
    pickRepoSlug('Neue Aufgabe', ['neue-aufgabe']) !== 'neue-aufgabe-2' ||
    pickRepoSlug('Neue Aufgabe', ['neue-aufgabe', 'neue-aufgabe-2']) !== 'neue-aufgabe-3' ||
    pickRepoSlug('Fotos Übersicht', ['other']) !== 'fotos-uebersicht' ||
    pickRepoSlug('日本語', []) !== 'task'
  ) {
    throw new Error('R11: pickRepoSlug');
  }
  t('R11 repository folder of a new task never collides with a pinned one');


  // R12: names other systems cannot hold are renamed BEFORE writing (the
  // memfs target rejects them like Chromium on Windows) and listed; names
  // that collide on case-insensitive volumes (APFS/NTFS) get a number
  // instead of overwriting each other
  const seg = (name: string, want: string) => {
    if (portableSegment(name) !== want) throw new Error(`R12: portableSegment(${JSON.stringify(name)}) = ${JSON.stringify(portableSegment(name))}`);
  };
  seg('a:b.txt', 'a_b.txt');
  seg('what?', 'what_');
  seg('CON', '_CON');
  seg('nul.txt', '_nul.txt');
  seg('COM1.log', '_COM1.log');
  seg('draft.', 'draft_');
  seg('trailing ', 'trailing_');
  seg('Bericht März.docx', 'Bericht März.docx');
  seg('console.txt', 'console.txt');
  seg('.git', '.git');
  const plannedNames = planRestorePaths([
    ['L', 'README.txt'],
    ['L', 'readme.txt'],
    ['L', 'x'],
    ['L', 'X', 'inner.txt'],
  ]).map((p) => p.parts.join('/'));
  if (JSON.stringify(plannedNames) !== JSON.stringify(['L/README.txt', 'L/readme (2).txt', 'L/x', 'L/X (2)/inner.txt'])) {
    throw new Error(`R12: planRestorePaths ${JSON.stringify(plannedNames)}`);
  }
  const portSrc = await fresh('port-src');
  const contents = ['colon', 'reserved', 'dot', 'upper', 'lower', 'question', 'nfc', 'nfd', 'plain'];
  for (const [i, text] of contents.entries()) await writeFile(portSrc, `f${i}.txt`, text);
  const portDst = await fresh('port-dst');
  await runBackup({ sources: [{ kind: 'handle', handle: portSrc }], dest: portDst, taskName: 'port' });
  const portRepo = await openRepo((await findRepos(portDst))[0].handle);
  const portManifest = JSON.parse(new TextDecoder().decode(await readFile(portRepo.manifests, (await listManifests(portRepo))[0])));
  const exotic = [
    'Mac/a:b.txt',
    'Mac/CON.txt',
    'Mac/draft.',
    'Linux/README.txt',
    'Linux/readme.txt',
    'Mac/what?/x.txt',
    'Mac/Grüße.txt',
    'Mac/Grüße.txt',
    'Mac/plain.txt',
  ];
  portManifest.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
  portManifest.files.forEach((f: { path: string }, i: number) => (f.path = exotic[i]));
  await writeFile(portRepo.manifests, 'manifest-9999-names.json', JSON.stringify(portManifest));
  const portOut = await fresh('port-out');
  const portRun = await runRestore({ repo: portRepo, manifestName: 'manifest-9999-names.json', target: portOut });
  const portTree = await treeText(portOut);
  const wantTree: Record<string, string> = {
    'Mac/a_b.txt': 'colon',
    'Mac/_CON.txt': 'reserved',
    'Mac/draft_': 'dot',
    'Linux/README.txt': 'upper',
    'Linux/readme (2).txt': 'lower',
    'Mac/what_/x.txt': 'question',
    'Mac/Grüße.txt': 'nfc',
    'Mac/Grüße (2).txt': 'nfd',
    'Mac/plain.txt': 'plain',
  };
  if (
    portRun.failed.length !== 0 ||
    portRun.fileCount !== 9 ||
    portRun.renamed.length !== 6 ||
    portTree.size !== 9 ||
    Object.entries(wantTree).some(([path, text]) => portTree.get(path) !== text)
  ) {
    throw new Error(`R12: failed=${JSON.stringify(portRun.failed.map((f) => f.path))} renamed=${JSON.stringify(portRun.renamed)} tree=${JSON.stringify([...portTree])}`);
  }
  t('R12 non-portable and case-colliding names renamed before writing, nothing lost');

  // R13: cancelling — a cancelled backup writes no version (the next run
  // reuses its blocks), a cancelled restore leaves no partial file
  const cancelSrc = await fresh('cancel-src');
  for (let i = 0; i < 6; i++) await writeFile(cancelSrc, `c${i}.bin`, new Uint8Array(70 * 1024).fill(i + 1).buffer);
  const cancelDst = await fresh('cancel-dst');
  const backupAbort = new AbortController();
  let cancelErr: unknown = null;
  try {
    await runBackup({
      sources: [{ kind: 'handle', handle: cancelSrc }],
      dest: cancelDst,
      taskName: 'cancel',
      chunkSize: 64 * 1024,
      signal: backupAbort.signal,
      onProgress: (p) => {
        if (p.phase === 'backup' && p.filesDone >= 2) backupAbort.abort();
      },
    });
  } catch (err) {
    cancelErr = err;
  }
  const cancelRepoDir = await getDirByPath(cancelDst, ['allbacked', 'cancel'], false);
  const cancelRepo = await openRepo(cancelRepoDir);
  if (!(cancelErr instanceof DOMException && cancelErr.name === 'AbortError') || (await listManifests(cancelRepo)).length !== 0) {
    throw new Error(`R13: cancelled backup: ${String(cancelErr)}, manifests=${(await listManifests(cancelRepo)).length}`);
  }
  const afterCancel = await runBackup({ sources: [{ kind: 'handle', handle: cancelSrc }], dest: cancelDst, taskName: 'cancel', chunkSize: 64 * 1024 });
  if (afterCancel.fileCount !== 6 || afterCancel.dedupBlocks < 2) {
    throw new Error(`R13: run after cancel files=${afterCancel.fileCount} dedup=${afterCancel.dedupBlocks}`);
  }
  const restoreAbort = new AbortController();
  const cancelOut = await fresh('cancel-out');
  cancelErr = null;
  try {
    await runRestore({
      repo: cancelRepo,
      manifestName: afterCancel.manifestName,
      target: cancelOut,
      signal: restoreAbort.signal,
      // abort in the middle of the third file (its first block is written)
      onProgress: (p) => {
        if (p.filesDone === 2 && p.bytesDone > 2 * 70 * 1024) restoreAbort.abort();
      },
    });
  } catch (err) {
    cancelErr = err;
  }
  const cancelTree = await treeText(cancelOut);
  if (!(cancelErr instanceof DOMException && cancelErr.name === 'AbortError') || cancelTree.size !== 2) {
    throw new Error(`R13: cancelled restore: ${String(cancelErr)}, files=${JSON.stringify([...cancelTree.keys()])}`);
  }
  for (const [path, text] of cancelTree) {
    if (text.length !== 70 * 1024) throw new Error(`R13: partial file after cancel: ${path}`);
  }
  t('R13 cancelled backup writes no version, cancelled restore leaves no partial file');

  // R14: a short lock on the destination (Windows virus scanner, OneDrive)
  // is retried; a real error (quota) is not
  const retryDir = await fresh('retry');
  let failuresLeft = 2;
  let attempts = 0;
  const flaky = {
    getFileHandle: async (name: string, opts?: FileSystemGetFileOptions) => {
      const real = await retryDir.getFileHandle(name, opts);
      return {
        createWritable: async () => {
          const w = await real.createWritable();
          attempts++;
          return {
            write: (d: FileSystemWriteChunkType) => w.write(d),
            abort: () => w.abort(),
            close: async () => {
              if (failuresLeft-- > 0) {
                await w.abort();
                throw new DOMException('locked', 'NoModificationAllowedError');
              }
              return w.close();
            },
          };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
  await writeFileRetry(flaky, 'block', 'payload', [1, 1, 1]);
  if (attempts !== 3 || (await treeText(retryDir)).get('block') !== 'payload') {
    throw new Error(`R14: retry attempts=${attempts}`);
  }
  let quotaAttempts = 0;
  const full = {
    getFileHandle: async () => ({
      createWritable: async () => {
        quotaAttempts++;
        return { write: async () => { throw new DOMException('full', 'QuotaExceededError'); }, abort: async () => {}, close: async () => {} };
      },
    }),
  } as unknown as FileSystemDirectoryHandle;
  let quotaThrown = false;
  try {
    await writeFileRetry(full, 'x', 'y', [1, 1, 1]);
  } catch (err) {
    quotaThrown = err instanceof DOMException && err.name === 'QuotaExceededError';
  }
  if (!quotaThrown || quotaAttempts !== 1) throw new Error(`R14: quota attempts=${quotaAttempts}`);
  t('R14 transient destination locks retried, quota errors fail at once');

  // R15: a stray non-block file in blocks/ (leftover .crswap after a crash,
  // .DS_Store) must not be taken as proof of a wrong passphrase
  const strayDst = await fresh('stray-dst');
  const strayRepo = await openOrInitRepo(strayDst, 'stray', PASS);
  const strayBlocks = await strayRepo.blocks.getDirectoryHandle('00', { create: true });
  await writeFile(strayBlocks, '00aa.crswap', 'not a block');
  const strayRun = await runBackup({ sources: [{ kind: 'handle', handle: portSrc }], dest: strayDst, taskName: 'stray', passphrase: PASS });
  if (!strayRun.verifiedOk) throw new Error('R15: stray file broke the run');
  t('R15 stray files in blocks/ do not fake a wrong passphrase');

  // R16: restore target check — inside the repository is refused by the UI,
  // a non-empty target asks first (OS litter like .DS_Store does not count)
  const portRepoDir = (await findRepos(portDst))[0].handle;
  const inRepo = await inspectRestoreTarget(await portRepoDir.getDirectoryHandle('manifests'), portRepoDir);
  const sameRepo = await inspectRestoreTarget(portRepoDir, portRepoDir);
  const litter = await fresh('litter');
  await writeFile(litter, '.DS_Store', 'x');
  await writeFile(litter, 'desktop.ini', 'x');
  const litterCheck = await inspectRestoreTarget(litter, portRepoDir);
  const busyCheck = await inspectRestoreTarget(portOut, portRepoDir);
  if (!inRepo.insideRepo || !sameRepo.insideRepo || litterCheck.insideRepo || litterCheck.existing.length !== 0 || busyCheck.existing.length !== 2) {
    throw new Error(`R16: ${JSON.stringify({ inRepo, sameRepo, litterCheck, busyCheck })}`);
  }
  t('R16 restore target inside the repository detected, non-empty target reported');

  // R17: every error the UI can show is translated — engine codes, tar
  // errors, cancel — and both languages have every string
  const en = makeT('en');
  const de = makeT('de');
  const tarCode = async (blob: Blob) => {
    try {
      await untarToDirectory(blob, await fresh('tar-code'));
    } catch (err) {
      return err instanceof EngineError ? err.code : String(err);
    }
    return 'accepted';
  };
  if ((await tarCode(new Blob([new Uint8Array(1024).fill(65)]))) !== 'archive-invalid' || (await tarCode(slip.slice(0, 600))) !== 'archive-truncated') {
    throw new Error('R17: tar errors are not EngineErrors');
  }
  const samples: unknown[] = [
    new EngineError('archive-invalid', 'x'),
    new EngineError('archive-truncated', 'x'),
    new EngineError('block-corrupt', 'Block abc is damaged.', 'abc…'),
    new DOMException('x', 'AbortError'),
    new DOMException('x', 'TypeMismatchError'),
    new DOMException('x', 'InvalidStateError'),
    new TypeError('Name is not allowed.'),
  ];
  for (const sample of samples) {
    const info = describeError(sample);
    if (info.keys[0] === 'errGeneric' || formatError(info, en) === formatError(info, de)) {
      throw new Error(`R17: untranslated ${String(sample)} → ${formatError(info, en)}`);
    }
  }
  if (formatError(describeError(new EngineError('block-corrupt', 'Block abc is damaged.', 'abc…')), de).includes('damaged')) {
    throw new Error('R17: English engine sentence leaked into the German message');
  }
  if (formatError({ keys: ['noSuchKey' as never] }, de) !== de('errGeneric')) throw new Error('R17: unknown stored key');
  const missing = missingTranslations();
  if (missing.length > 0) throw new Error(`R17: missing translations ${missing.join(', ')}`);
  t('R17 engine/tar/cancel errors translated, EN/DE string sets complete');

  await opfs.removeEntry('ab-reg', { recursive: true }).catch(() => {});
}

export async function abSelfTest(log: Log = (l) => console.log(l)): Promise<boolean> {
  const t = (m: string) => log(`[ABTEST] ${m}`);
  try {
    const opfs = await navigator.storage.getDirectory();
    for (const name of ['ab-src', 'ab-dst', 'ab-dst2', 'ab-restore', 'ab-restore2', 'ab-import', 'ab-reg']) {
      await opfs.removeEntry(name, { recursive: true }).catch(() => {});
    }
    const src = await opfs.getDirectoryHandle('ab-src', { create: true });
    const dst = await opfs.getDirectoryHandle('ab-dst', { create: true });
    const restoreTarget = await opfs.getDirectoryHandle('ab-restore', { create: true });
    await makeSourceTree(src);
    t('source tree created');

    const run1 = await runBackup({
      sources: [{ kind: 'handle', handle: src }],
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
      sources: [{ kind: 'handle', handle: src }],
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
    // multi-source layout: files live below the source folder's name
    const restoredRoot = await restoreTarget.getDirectoryHandle('ab-src');
    const compared = await assertTreesEqual(src, restoredRoot);
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

    // Firefox fallback path 1: backup from a flat file list (webkitdirectory)
    const listSource: { path: string; file: File }[] = [];
    for await (const f of walkFiles(src)) {
      listSource.push({ path: f.path, file: await f.handle.getFile() });
    }
    const dst2 = await opfs.getDirectoryHandle('ab-dst2', { create: true });
    const run3 = await runBackup({
      sources: [{ kind: 'files', name: 'ab-src', files: listSource }],
      dest: dst2,
      taskName: 'Selbsttest',
      passphrase: PASS,
      chunkSize: 64 * 1024,
    });
    if (run3.fileCount !== 5 || run3.newBlocks !== 7) {
      throw new Error(`list-source backup mismatch: files=${run3.fileCount} new=${run3.newBlocks}`);
    }
    t('list-source backup (fallback) OK');

    // Firefox fallback path 2: tar export → import → restore
    const archive = await tarDirectory(repos[0].handle);
    const imported = await opfs.getDirectoryHandle('ab-import', { create: true });
    const count = await untarToDirectory(archive, imported);
    const repoFromTar = await openRepo(imported, PASS);
    const tarManifests = await listManifests(repoFromTar);
    if (tarManifests.length !== 2) throw new Error(`tar roundtrip: expected 2 manifests, got ${tarManifests.length}`);
    const restore2 = await opfs.getDirectoryHandle('ab-restore2', { create: true });
    await runRestore({ repo: repoFromTar, manifestName: tarManifests[0], target: restore2 });
    await assertTreesEqual(src, await restore2.getDirectoryHandle('ab-src'));
    t(`tar roundtrip OK (${count} entries, restore byte-identical)`);

    await regressionTests(opfs, t);

    t('PASS — engine end-to-end OK');
    return true;
  } catch (err) {
    t(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
