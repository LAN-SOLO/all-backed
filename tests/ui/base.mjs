const U = 'http://127.0.0.1:5794/';
const OUT = (process.env.AB_UI_OUT || 'testdata-out/ui') + '/';
export default async ({ ev, shot, nav, view, sleep }) => {
  const tag = process.env.TAG || 'base';
  await nav(U);
  for (const [lang, theme] of [['de', 'dark'], ['en', 'light']]) {
    await ev(`localStorage.setItem('ab-lang','${lang}'); localStorage.setItem('theme','${theme}'); localStorage.removeItem('ab.tutorialSeen'); 1`);
    for (const [w, h] of [[760, 520]]) {
      await view(w, h);
      await nav(U + '?fallback');
      await shot(`${OUT}${tag}-${lang}-${theme}-${w}-tutorial.png`);
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await sleep(300);
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F2'})); 1`); await sleep(600);
      await ev(`window.dispatchEvent(new CustomEvent('ab:test:add-source',{detail:{name:'Dokumente mit sehr langem Namen Ümläut',files:[{path:'Dokumente mit sehr langem Namen Ümläut/a.txt',file:new File(['x'],'a.txt')}]}})); 1`); await sleep(300);
      await shot(`${OUT}${tag}-${lang}-${theme}-${w}-task.png`);
      const ov = await ev(`(() => { const o=[]; for (const el of document.querySelectorAll('*')) { if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth>0) o.push(el.tagName+'.'+(el.className||'').toString().slice(0,40)+' '+el.scrollWidth+'>'+el.clientWidth); } return {doc: document.documentElement.scrollWidth+'/'+innerWidth, o: o.slice(0,10)}; })()`);
      console.log(lang, theme, w, 'overflow', JSON.stringify(ov));
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F6'})); 1`); await sleep(400);
      await shot(`${OUT}${tag}-${lang}-${theme}-${w}-restore.png`);
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F1'})); 1`); await sleep(400);
      await shot(`${OUT}${tag}-${lang}-${theme}-${w}-help.png`);
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await sleep(200);
      await nav(U);
      await sleep(300);
      await shot(`${OUT}${tag}-${lang}-${theme}-${w}-direct.png`);
    }
  }
};
