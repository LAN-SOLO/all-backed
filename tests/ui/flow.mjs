const U = 'http://127.0.0.1:5794/';
const OUT = (process.env.AB_UI_OUT || 'testdata-out/ui') + '/';
const HELPERS = `
window.__h = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  btn: (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent)),
  click: async (re) => { const b = window.__h.btn(re); if (!b) throw new Error('no button ' + re); b.click(); await window.__h.sleep(250); return !b.disabled; },
  type: async (el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); await window.__h.sleep(150); },
  text: () => document.querySelector('main').innerText,
  key: async (k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); await window.__h.sleep(300); },
  overflow: () => document.documentElement.scrollWidth - innerWidth,
};
1`;
const SETUP = `(async () => {
  const opfs = await navigator.storage.getDirectory();
  for (const n of ['Quelle', 'Ziel', 'Restore']) await opfs.removeEntry(n, { recursive: true }).catch(() => {});
  const src = await opfs.getDirectoryHandle('Quelle', { create: true });
  const w = async (dir, name, data) => { const h = await dir.getFileHandle(name, { create: true }); const s = await h.createWritable(); await s.write(data); await s.close(); };
  await w(src, 'Bericht März.txt', 'Umlaute ok');
  const sub = await src.getDirectoryHandle('Unterordner mit Leerzeichen', { create: true });
  for (let i = 0; i < 40; i++) await w(sub, 'daten-' + i + '.bin', new Uint8Array(1024 * 1024).map((_, j) => (j * 7 + i) % 251));
  const dst = await opfs.getDirectoryHandle('Ziel', { create: true });
  const tgt = await opfs.getDirectoryHandle('Restore', { create: true });
  await w(tgt, 'schon-da.txt', 'alt');
  await w(tgt, '.DS_Store', 'x');
  window.__pick = { src, dst, tgt, next: null };
  window.showDirectoryPicker = async (opts) => {
    if (window.__pick.next) { const n = window.__pick.next; window.__pick.next = null; return n; }
    const id = opts?.id ?? '';
    if (id.startsWith('ab-source')) return src;
    if (id.startsWith('ab-dest') || id === 'ab-restore-repo') return dst;
    return tgt;
  };
  return 'ok';
})()`;
export default async ({ ev, shot, nav, view, sleep, check }) => {
  const lang = process.env.LANG_UI || 'de';
  const theme = process.env.THEME || 'dark';
  const W = Number(process.env.W || 760), H = Number(process.env.H || 520);
  const P = `${OUT}flow-${lang}-${theme}-${W}`;
  await nav(U);
  await ev(`indexedDB.deleteDatabase('allbacked'); localStorage.clear(); localStorage.setItem('ab-lang','${lang}'); localStorage.setItem('theme','${theme}'); localStorage.setItem('ab.tutorialSeen','1'); 1`);
  await view(W, H);
  await nav(U);
  await ev(HELPERS);
  console.log('setup', await ev(SETUP));
  const step = async (name, js) => { const r = await ev(`(async () => { const h = window.__h; ${js} })()`); console.log(name, JSON.stringify(r)); return r; };
  await step('new task', `await h.key('F2'); return document.querySelector('input[aria-label]')?.value;`);
  await step('add source', `await h.click(/Ordner hinzufügen|add folder/); await h.sleep(800); return h.text().slice(0, 300);`);
  await step('pick dest', `const card = [...document.querySelectorAll('button.card')][0]; card.click(); await h.sleep(400); return card.textContent;`);
  await step('passphrase', `await h.type(document.querySelector('input[type=password]'), 'richtig-geheim'); return 1;`);
  { const r = await step('run1', `await h.key('F5'); for (let i=0;i<200;i++){ await h.sleep(100); if (!document.querySelector('.ab-running')) break; } return { text: (document.querySelector('[role=status]')||{}).innerText, ov: h.overflow() };`); check(/Verify OK|verify OK/.test(r.text) && r.ov <= 0, 'flow: first backup OK, no overflow', r); }
  await shot(`${P}-1-success.png`);
  await step('ok', `await h.click(/^OK$/); return 1;`);
  // cancel run: add more data so it takes a moment
  { const r = await step('run2-cancel', `
    const src = window.__pick.src; const sub = await src.getDirectoryHandle('Unterordner mit Leerzeichen');
    for (let i = 40; i < 120; i++) { const f = await sub.getFileHandle('neu-' + i + '.bin', { create: true }); const s = await f.createWritable(); await s.write(new Uint8Array(1024*1024).map((_, j) => (j * 13 + i) % 253)); await s.close(); }
    await h.key('F5');
    let sawCancel = false;
    for (let i=0;i<100;i++){ await h.sleep(20); const b = h.btn(/\\[(Abbrechen|Cancel)\\]/); if (b) { sawCancel = true; await h.sleep(300); b.click(); break; } }
    for (let i=0;i<200;i++){ await h.sleep(100); if (!document.querySelector('.ab-running')) break; }
    await h.sleep(600); const r = document.querySelector('[role=status]')?.getBoundingClientRect(); const sc = document.querySelector('main > div'); return { top: r && r.top, scrollTop: sc.scrollTop, inView: r && r.top >= 0 && r.top < innerHeight, sawCancel, banner: (document.querySelector('[role=status]')||{}).innerText, navEnabled: !h.btn(/Wiederherstellen|Restore/).disabled };`); check(r.sawCancel && r.navEnabled && /abgebrochen|cancelled/i.test(r.banner), 'flow: cancel → yellow banner, navigation free', r); }
  await shot(`${P}-2-cancelled.png`);
  await step('ok', `await h.click(/^OK$/); return 1;`);
  { const r = await step('run3-wrongpass', `await h.type(document.querySelector('input[type=password]'), 'falsch'); await h.key('F5'); for (let i=0;i<200;i++){ await h.sleep(100); if (!document.querySelector('.ab-running')) break; } const a = document.querySelector('[role=alert]'); return a && a.innerText;`); check(/Passphrase|passphrase/.test(r || ''), 'flow: wrong passphrase → red message', r); }
  await step('ok', `await h.click(/^OK$/); return 1;`);
  await shot(`${P}-3-lastrun-failed.png`);
  await step('switch lang', `await h.click(/^${lang === 'de' ? 'en' : 'de'}$/i); const card = [...document.querySelectorAll('.card')].find((c) => /Last run|Letzter Lauf/i.test(c.innerText)); return card && card.innerText;`);
  await shot(`${P}-4-lastrun-switched.png`);
  await step('switch back', `await h.click(/^${lang}$/i); return 1;`);
  // restore
  await step('restore open', `await h.key('F6'); await h.click(/Backup-Ort wählen|Choose backup location/); await h.sleep(600); return h.text().slice(0, 400);`);
  await step('unlock', `await h.type(document.querySelector('input[type=password]'), 'richtig-geheim'); await h.click(/Entsperren|Unlock/); await h.sleep(1500); return h.text().slice(0, 500);`);
  { const r = await step('target inside repo', `const repoRoot = await (await window.__pick.dst.getDirectoryHandle('allbacked')).getDirectoryHandle('${lang === 'de' ? 'neue-aufgabe' : 'new-task'}'); window.__pick.next = await repoRoot.getDirectoryHandle('blocks'); await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(500); return document.querySelector('[role=alert]')?.innerText;`); check(!!r, 'flow: target inside repository refused', r); }
  await step('target nonempty', `await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(600); return document.querySelector('[role=alertdialog]')?.innerText;`);
  await shot(`${P}-5-confirm.png`);
  { const r = await step('cancel confirm', `await h.click(/^(Abbrechen|Cancel)$/); const names = []; for await (const n of window.__pick.tgt.keys()) names.push(n); return { dialog: !!document.querySelector('[role=alertdialog]'), names };`); check(!r.dialog && r.names.length === 2, 'flow: cancelled overwrite prompt writes nothing', r); }
  { const r = await step('overwrite', `await h.click(/Diese Version wiederherstellen|Restore this version/); await h.sleep(600); await h.click(/Überschreiben|Overwrite/); for (let i=0;i<300;i++){ await h.sleep(100); if (!h.btn(/\\[(Abbrechen|Cancel)\\]/)) break; } await h.sleep(300); const q = await window.__pick.tgt.getDirectoryHandle('Quelle'); const f = await (await q.getFileHandle('Bericht März.txt')).getFile(); return { text: h.text().slice(-400), content: await f.text(), ov: h.overflow() };`); check(r.content === 'Umlaute ok' && r.ov <= 0, 'flow: overwrite restores content', r); }
  await shot(`${P}-6-restored.png`);
  await step('help', `await h.key('F1'); return h.overflow();`);
  await shot(`${P}-7-help.png`);
  await step('close help', `await h.key('Escape'); return 1;`);
  await ev(`(async () => { const opfs = await navigator.storage.getDirectory(); for (const n of ['Quelle', 'Ziel', 'Restore']) await opfs.removeEntry(n, { recursive: true }).catch(() => {}); })()`);
};
