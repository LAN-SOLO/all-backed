// End-to-end user journeys in real Chromium (direct mode, OPFS folders stand
// in for user folders; the native picker is stubbed like a user choosing a
// folder or pressing Cancel). Error cases are injected at the File System
// Access prototypes, so the app keeps real handles (IndexedDB can store them).
//   LANG_UI=de|en  THEME=dark|light  W=  H=
const U = 'http://127.0.0.1:5794/';
const OUT = (process.env.AB_UI_OUT || 'testdata-out/ui') + '/';

const HELPERS = `
window.__h = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  btn: (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent)),
  click: async (re) => { const b = window.__h.btn(re); if (!b) throw new Error('no button ' + re); b.click(); await window.__h.sleep(300); return !b.disabled; },
  type: async (el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); await window.__h.sleep(150); },
  text: () => document.querySelector('main').innerText,
  key: async (k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); await window.__h.sleep(300); },
  idle: async () => { for (let i = 0; i < 600; i++) { await window.__h.sleep(100); if (!document.querySelector('.ab-running') && !window.__h.btn(/\\[(Abbrechen|Cancel)\\]/)) return true; } return false; },
  alert: () => [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(' | '),
  status: () => [...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(' | '),
  w: async (dir, name, data) => { const h = await dir.getFileHandle(name, { create: true }); const s = await h.createWritable(); await s.write(data); await s.close(); },
  tree: async (dir, prefix = '') => { const out = []; for await (const [n, h] of dir.entries()) { const p = prefix ? prefix + '/' + n : n; if (h.kind === 'file') out.push(p); else out.push(...(await window.__h.tree(h, p))); } return out.sort(); },
};
1`;

// Fault injection mirroring what Chromium reports: a full drive
// (QuotaExceededError on write), a read-only / denied folder
// (requestPermission → 'denied'), a file another program holds
// (NoModificationAllowedError on close), and a cancelled picker (AbortError).
const FAULTS = `(() => {
  if (window.__faults) return 1;
  const f = (window.__faults = { quota: false, deny: null, lockNames: new Map(), lockAttempts: 0 });
  const names = new WeakMap();
  const P = FileSystemFileHandle.prototype, W = FileSystemWritableFileStream.prototype, D = FileSystemHandle.prototype;
  const cw = P.createWritable;
  P.createWritable = async function (...a) { const s = await cw.apply(this, a); names.set(s, this.name); if (f.lockNames.has(this.name)) f.lockAttempts++; return s; };
  const wr = W.write;
  W.write = function (...a) { if (f.quota) return Promise.reject(new DOMException('The disk is full.', 'QuotaExceededError')); return wr.apply(this, a); };
  const cl = W.close;
  W.close = async function () {
    const n = names.get(this); const left = f.lockNames.get(n) ?? 0;
    if (left > 0) { f.lockNames.set(n, left - 1); await this.abort(); throw new DOMException('locked', 'NoModificationAllowedError'); }
    return cl.call(this);
  };
  const qp = D.queryPermission, rp = D.requestPermission;
  D.queryPermission = function (...a) { return f.deny && this.name === f.deny ? Promise.resolve('prompt') : qp.apply(this, a); };
  D.requestPermission = function (...a) { return f.deny && this.name === f.deny ? Promise.resolve('denied') : rp.apply(this, a); };
  return 1;
})()`;

// Home/ (source, contains Backup/ = destination) and allbacked/ (a source
// folder that happens to carry the repository folder's name)
const SETUP = (reset) => `(async () => {
  const h = window.__h;
  const opfs = await navigator.storage.getDirectory();
  const reset = ${reset};
  if (reset) for (const n of ['J-Home', 'J-Other', 'J-Restore']) await opfs.removeEntry(n, { recursive: true }).catch(() => {});
  const home = await opfs.getDirectoryHandle('J-Home', { create: true });
  if (reset) await h.w(home, 'Brief.txt', 'Sehr geehrte Damen und Herren');
  const docs = await home.getDirectoryHandle('Dokumente', { create: true });
  if (reset) for (let i = 0; i < 12; i++) await h.w(docs, 'teil-' + i + '.bin', new Uint8Array(512 * 1024).map((_, j) => (j * 3 + i) % 249));
  const dest = await home.getDirectoryHandle('Backup', { create: true });
  const other = await opfs.getDirectoryHandle('J-Other', { create: true });
  const named = await other.getDirectoryHandle('allbacked', { create: true });
  if (reset) await h.w(named, 'eigene-datei.txt', 'gehört mir');
  const restore = await opfs.getDirectoryHandle('J-Restore', { create: true });
  window.__pick = { home, dest, named, restore, queue: [] };
  window.showDirectoryPicker = async (opts) => {
    const next = window.__pick.queue.shift();
    if (next === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
    if (next) return next;
    throw new Error('unexpected picker ' + (opts && opts.id));
  };
  return 'ok';
})()`;

export default async ({ ev, shot, nav, view, check }) => {
  const lang = process.env.LANG_UI || 'de';
  const theme = process.env.THEME || 'dark';
  const W = Number(process.env.W || 1024), H = Number(process.env.H || 700);
  const P = `${OUT}journey-${lang}-${theme}-${W}`;
  await nav(U);
  await ev(`indexedDB.deleteDatabase('allbacked'); localStorage.clear(); localStorage.setItem('ab-lang','${lang}'); localStorage.setItem('theme','${theme}'); 1`);
  await view(W, H);
  await nav(U);
  const boot = async () => { await ev(HELPERS); await ev(FAULTS); await ev(`(async () => { window.__T = (await import('/src/i18n.ts')).makeT('${lang}'); return 1; })()`); };
  await boot();
  console.log('setup', await ev(SETUP(true)));
  const step = async (name, js) => { const r = await ev(`(async () => { const h = window.__h, T = window.__T, F = window.__faults, K = window.__pick; ${js} })()`); console.log('·', name, JSON.stringify(r).slice(0, 500)); return r; };

  // J1 first start: tutorial, Esc, F2, cancelled source picker
  let r = await step('J1 tutorial', `return { dialog: !!document.querySelector('[role=dialog]'), text: document.body.innerText.slice(0, 120) };`);
  check(r.dialog, 'J1 tutorial opens on first start', r);
  r = await step('J1 esc + F2 + cancel picker', `await h.key('Escape'); const closed = !document.querySelector('[role=dialog]'); await h.key('F2'); K.queue.push('cancel'); await h.click(/Ordner hinzufügen|add folder/i); await h.sleep(300); return { closed, alert: h.alert(), noSources: h.text().includes(T('noSources')) };`);
  check(r.closed && r.alert === '' && r.noSources, 'J1 Esc closes tutorial; cancelled picker adds nothing, no error', r);
  await shot(`${P}-j1.png`);

  // J2 sources incl. duplicate and a folder named "allbacked", destination inside a source
  r = await step('J2 sources', `K.queue.push(K.home); await h.click(/Ordner hinzufügen|add folder/i); await h.sleep(500); K.queue.push(K.home); await h.click(/Ordner hinzufügen|add folder/i); await h.sleep(500); const dup = h.alert(); K.queue.push(K.named); await h.click(/Ordner hinzufügen|add folder/i); await h.sleep(800); return { dup, text: h.text().slice(0, 600) };`);
  check(r.dup.includes(await ev(`window.__T('errDuplicateSource')`)), 'J2 same folder twice refused', r);
  r = await step('J2 cancel dest picker', `K.queue.push('cancel'); [...document.querySelectorAll('button.card')][0].click(); await h.sleep(300); return { alert: h.alert(), title: [...document.querySelectorAll('button.card')][0].innerText };`);
  check(r.alert === '' && r.title.includes('—'), 'J2 cancelled destination picker leaves destination unset', r);
  r = await step('J2 dest + passphrase + run', `K.queue.push(K.dest); [...document.querySelectorAll('button.card')][0].click(); await h.sleep(400); await h.type(document.querySelector('input[type=password]'), 'reise-nach-jerusalem'); await h.key('F5'); await h.idle(); await h.sleep(300); return { status: h.status(), alert: h.alert() };`);
  check(r.alert === '' && r.status.length > 0, 'J2 first backup succeeds', r);
  await shot(`${P}-j2.png`);
  r = await step('J2 manifest paths', `
    const { openRepo, listManifests, readManifest } = await import('/src/engine/repo.ts');
    const all = await K.dest.getDirectoryHandle('allbacked'); let repoDir; for await (const [, d] of all.entries()) repoDir = d;
    const repo = await openRepo(repoDir, 'reise-nach-jerusalem'); const names = await listManifests(repo);
    const m = await readManifest(repo, names[0]); return { versions: names.length, paths: m.files.map((f) => f.path) };`);
  check(r.versions === 1 && r.paths.includes('allbacked (2)/eigene-datei.txt') && r.paths.includes('J-Home/Brief.txt') && !r.paths.some((p) => p.startsWith('J-Home/Backup/allbacked')), 'J2 "allbacked" source stored as "allbacked (2)", own repository not backed up', r);
  await step('ok', `await h.click(/^OK$/); return 1;`);

  // J3 follow-up run deduplicates (repository inside the source is still skipped)
  r = await step('J3 second run', `await h.key('F5'); await h.idle(); await h.sleep(300); return h.status();`);
  check(r.includes('0 ' + (await ev(`window.__T('newBlocks')`))), 'J3 second run writes 0 new blocks', r);
  await step('ok', `await h.click(/^OK$/); return 1;`);

  // J4 drive full during a run
  r = await step('J4 disk full', `await h.w(K.home, 'neu.txt', 'neuer Inhalt ' + Date.now()); F.quota = true; await h.key('F5'); await h.idle(); F.quota = false; await h.sleep(300); return { alert: h.alert(), status: h.status() };`);
  check(r.alert.includes(await ev(`window.__T('errDiskFull')`)) || r.status.includes(await ev(`window.__T('errDiskFull')`)), 'J4 full drive → "target drive is full" message', r);
  await step('ok', `const b = h.btn(/^OK$/); if (b) { b.click(); await h.sleep(300); } return 1;`);
  r = await step('J4 last run card + versions', `const card = [...document.querySelectorAll('.card')].find((c) => c.innerText.toLowerCase().includes(T('lastRun').toLowerCase())); const all = await K.dest.getDirectoryHandle('allbacked'); let repoDir; for await (const [, d] of all.entries()) repoDir = d; const man = await repoDir.getDirectoryHandle('manifests'); let n = 0; for await (const _ of man.keys()) n++; return { card: card && card.innerText, manifests: n };`);
  check(r.manifests === 2 && r.card && r.card.includes(await ev(`window.__T('errDiskFull')`)), 'J4 failed run shown in "Last run", no new version', r);
  await shot(`${P}-j4.png`);

  // J5 destination access denied (read-only / permission refused)
  r = await step('J5 denied', `F.deny = 'Backup'; await h.key('F5'); await h.idle(); F.deny = null; await h.sleep(300); return h.alert() + ' ' + h.status();`);
  check(r.includes(await ev(`window.__T('errPermission')`)), 'J5 denied destination → permission message', r);
  await step('ok', `const b = h.btn(/^OK$/); if (b) { b.click(); await h.sleep(300); } return 1;`);

  // J6 app restart in the middle of a run
  r = await step('J6 start long run', `const docs = await K.home.getDirectoryHandle('Dokumente'); for (let i = 12; i < 70; i++) await h.w(docs, 'gross-' + i + '.bin', new Uint8Array(1024 * 1024).map((_, j) => (j * 11 + i) % 251)); await h.key('F5'); for (let i = 0; i < 100; i++) { await h.sleep(30); if (h.btn(/\\[(Abbrechen|Cancel)\\]/)) break; } return !!h.btn(/\\[(Abbrechen|Cancel)\\]/);`);
  await nav(U); // reload mid-run (the CDP harness accepts the beforeunload prompt)
  await boot();
  await ev(SETUP(false));
  r = await step('J6 after reload', `await h.sleep(500); const all = await K.dest.getDirectoryHandle('allbacked'); let repoDir; for await (const [, d] of all.entries()) repoDir = d; const man = await repoDir.getDirectoryHandle('manifests'); let n = 0; for await (const _ of man.keys()) n++; const card = [...document.querySelectorAll('.card')].find((c) => c.innerText.toLowerCase().includes(T('lastRun').toLowerCase())); return { manifests: n, task: h.text().includes('${lang === 'de' ? 'Neue Aufgabe' : 'New task'}'), card: card && card.innerText.slice(0, 200) };`);
  check(r.manifests === 2 && r.task, 'J6 reload mid-run: task kept, no half version', r);
  r = await step('J6 rerun', `await h.type(document.querySelector('input[type=password]'), 'reise-nach-jerusalem'); await h.key('F5'); await h.idle(); await h.sleep(300); return { status: h.status(), alert: h.alert() };`);
  check(r.alert === '' && r.status.includes(await ev(`window.__T('verified')`)), 'J6 run after restart succeeds', r);
  await step('ok', `const b = h.btn(/^OK$/); if (b) { b.click(); await h.sleep(300); } return 1;`);

  // J7 restore: parent of the repository refused, allbacked/ refused,
  // cancelled target picker, locked target file retried
  r = await step('J7 open', `await h.key('F6'); K.queue.push('cancel'); await h.click(/Backup-Ort wählen|Choose backup location/); await h.sleep(300); const cancelled = h.text(); K.queue.push(K.dest); await h.click(/Backup-Ort wählen|Choose backup location/); await h.sleep(800); await h.type(document.querySelector('input[type=password]'), 'reise-nach-jerusalem'); await h.click(/Entsperren|Unlock/); await h.sleep(1500); return { cancelledHasRepo: cancelled.includes(T('reposFound')), text: h.text().slice(0, 400) };`);
  check(!r.cancelledHasRepo && /wiederherstellen|restore this version/i.test(r.text), 'J7 cancelled location picker does nothing; unlock lists versions', r);
  r = await step('J7 target = backup drive', `K.queue.push(K.dest); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(600); return h.alert();`);
  check(r.includes(await ev(`window.__T('errTargetContainsRepo')`)), 'J7 restore into the folder containing the repository refused', r);
  r = await step('J7 target = allbacked/', `K.queue.push(await K.dest.getDirectoryHandle('allbacked')); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(600); return h.alert();`);
  check(r.includes(await ev(`window.__T('errTargetContainsRepo')`)), 'J7 restore into allbacked/ refused', r);
  r = await step('J7 target picker cancelled', `K.queue.push('cancel'); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(400); return { alert: h.alert(), files: await h.tree(K.restore) };`);
  check(r.alert === '' && r.files.length === 0, 'J7 cancelled target picker writes nothing', r);
  await shot(`${P}-j7-refused.png`);
  r = await step('J7 locked file retried', `F.lockNames.set('Brief.txt', 2); F.lockAttempts = 0; K.queue.push(K.restore); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.idle(); await h.sleep(500); const files = await h.tree(K.restore); const brief = await (await (await (await K.restore.getDirectoryHandle('J-Home')).getFileHandle('Brief.txt')).getFile()).text(); return { attempts: F.lockAttempts, files: files.length, brief, own: files.includes('allbacked (2)/eigene-datei.txt'), backupInside: files.some((p) => p.startsWith('J-Home/Backup/allbacked')), alert: h.alert(), status: h.status() };`);
  check(r.attempts === 3 && r.brief === 'Sehr geehrte Damen und Herren' && r.own && !r.backupInside && r.alert === '', 'J7 briefly locked target file retried, restore complete', r);
  await shot(`${P}-j7-restored.png`);
  r = await step('J7 lasting lock', `F.lockNames.set('Brief.txt', 99); K.queue.push(K.restore); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(600); await h.click(/Überschreiben|Overwrite/); await h.idle(); await h.sleep(500); F.lockNames.clear(); return { alert: h.alert(), brief: await (await (await (await K.restore.getDirectoryHandle('J-Home')).getFileHandle('Brief.txt')).getFile()).text() };`);
  check(r.alert.includes('Brief.txt') && r.alert.includes(await ev(`window.__T('errLocked')`)) && r.brief === 'Sehr geehrte Damen und Herren', 'J7 lasting lock: only that file listed (translated), old content kept', r);
  await shot(`${P}-j7-locked.png`);
  check((await ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0, 'no horizontal overflow');

  // J8 archive mode: the same folder twice is refused
  await nav(U + '?fallback');
  await boot();
  r = await step('J8 archive duplicate', `await h.key('F2'); const mk = () => ({ name: 'Fotos', files: [{ path: 'Fotos/a.jpg', file: new File(['x'], 'a.jpg', { lastModified: 1 }) }] }); window.dispatchEvent(new CustomEvent('ab:test:add-source', { detail: mk() })); await h.sleep(200); window.dispatchEvent(new CustomEvent('ab:test:add-source', { detail: mk() })); await h.sleep(300); const rows = [...document.querySelectorAll('main li')].filter((li) => li.innerText.includes('Fotos')).length; return { rows, alert: h.alert() };`);
  check(r.rows === 1 && r.alert.includes(await ev(`window.__T('errDuplicateSource')`)), 'J8 archive mode: same folder twice refused', r);

  await ev(`(async () => { const opfs = await navigator.storage.getDirectory(); for (const n of ['J-Home', 'J-Other', 'J-Restore']) await opfs.removeEntry(n, { recursive: true }).catch(() => {}); })()`);
};
