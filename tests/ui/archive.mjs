const U = 'http://127.0.0.1:5794/?fallback';
const OUT = (process.env.AB_UI_OUT || 'testdata-out/ui') + '/';
export default async ({ ev, shot, nav, view, sleep, check }) => {
  const lang = process.env.LANG_UI || 'de';
  const theme = process.env.THEME || 'dark';
  const W = Number(process.env.W || 760), H = Number(process.env.H || 520);
  const P = `${OUT}archive-${lang}-${theme}-${W}`;
  await nav(U);
  await ev(`indexedDB.deleteDatabase('allbacked'); localStorage.clear(); localStorage.setItem('ab-lang','${lang}'); localStorage.setItem('theme','${theme}'); localStorage.setItem('ab.tutorialSeen','1'); 1`);
  await view(W, H);
  await nav(U);
  const step = async (name, js) => { const r = await ev(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent)); const key = async (k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); await sleep(300); }; ${js} })()`); console.log(name, JSON.stringify(r).slice(0, 700)); return r; };
  await step('task', `await key('F2'); window.dispatchEvent(new CustomEvent('ab:test:add-source', { detail: { name: 'Docs', files: ['a','b','c','d','e','f'].map((n) => ({ path: 'Docs/' + n + '.txt', file: new File(['inhalt ' + n], n + '.txt') })) } })); await sleep(200); const enc = document.querySelector('input[type=checkbox]'); if (enc.checked) enc.click(); await sleep(200); return 1;`);
  { const r = await step('backup', `await key('F5'); for (let i=0;i<100;i++){ await sleep(100); if (!document.querySelector('.ab-running')) break; } return { dl: window.__lastDownload?.name, banner: document.querySelector('[role=status]')?.innerText };`); check(/^allbacked-.*-\d{4}-\d{2}-\d{2}\.tar$/.test(r.dl || ''), 'archive: backup downloads allbacked-<task>-<date>.tar', r); }
  { const r = await step('garbage tar', `await key('F6'); window.dispatchEvent(new CustomEvent('ab:test:restore-tar', { detail: { file: new Blob([new Uint8Array(2048).fill(66)]) } })); await sleep(800); return document.querySelector('[role=alert]')?.innerText;`); check(!!r && !/not a valid tar/.test(r), 'archive: garbage file → translated message', r); }
  await shot(`${P}-1-garbage.png`);
  { const r = await step('truncated tar', `const tar = window.__lastDownload.blob; window.dispatchEvent(new CustomEvent('ab:test:restore-tar', { detail: { file: tar.slice(0, tar.size - 1024) } })); await sleep(800); return document.querySelector('[role=alert]')?.innerText;`); check(!!r, 'archive: truncated .tar → message', r); }
  await step('import', `window.__backupTar = window.__lastDownload.blob; window.dispatchEvent(new CustomEvent('ab:test:restore-tar', { detail: { file: window.__backupTar } })); await sleep(1200); return document.querySelector('main').innerText.slice(0, 300);`);
  await step('exotic manifest', `
    const opfs = await navigator.storage.getDirectory();
    const imp = await opfs.getDirectoryHandle('restore-import');
    const man = await imp.getDirectoryHandle('manifests');
    let name; for await (const n of man.keys()) name = n;
    const m = JSON.parse(await (await (await man.getFileHandle(name)).getFile()).text());
    const paths = ['Docs/a:b.txt', 'Docs/CON.txt', 'Docs/README.txt', 'Docs/readme.txt', 'Docs/Kunde.lnk', 'Docs/fam\u{1F468}\u200D\u{1F469}.jpg'];
    m.files.forEach((f, i) => (f.path = paths[i]));
    const h = await man.getFileHandle(name.replace('manifest-', 'manifest-9'), { create: true }); const w = await h.createWritable(); await w.write(JSON.stringify(m)); await w.close();
    // re-select the repo so the version list shows the edited manifest
    [...document.querySelectorAll('main .card button')].find((b) => /Neue Aufgabe|New task/.test(b.textContent))?.click(); await sleep(600);
    return document.querySelector('main').innerText.slice(0, 400);`);
  { const r = await step('restore', `const b = btn(/Diese Version wiederherstellen|Restore this version/); b.click(); for (let i=0;i<100;i++){ await sleep(100); if (window.__lastDownload?.name?.startsWith('restored-')) break; } await sleep(300); return { dl: window.__lastDownload?.name, text: [...document.querySelectorAll('[role=status]')].map((e) => e.innerText) };`); check(/^restored-/.test(r.dl || '') && r.text.join(' ').includes('a_b.txt'), 'archive: restored-<date>.tar with rename list', r); }
  await shot(`${P}-2-renamed.png`);
  { const r = await step('restored tar names', `const { iterTar } = await import('/src/engine/tar.ts'); const out = []; for await (const e of iterTar(window.__lastDownload.blob)) out.push(e.path); return out;`); check(r.includes('Docs/a_b.txt') && r.includes('Docs/_CON.txt') && r.includes('Docs/readme (2).txt'), 'archive: portable names inside restored tar', r); }
};
