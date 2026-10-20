// usage: node cdp.mjs <port> <scenario.mjs>   — scenario exports default async ({ev, shot, nav, view, sleep, send, check})
// Exit code: 0 = every check() passed, 1 = a check failed or the scenario threw, 3 = timeout.
const [port, scenario] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') console.log('[console]', m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400));
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', JSON.stringify(m.params.exceptionDetails).slice(0, 600));
  if (m.method === 'Page.javascriptDialogOpening') { console.log('[dialog]', m.params.type, m.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable'); await send('Page.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails).slice(0, 800) };
  return r.result?.result?.value;
};
const view = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(3500); };
const { writeFileSync } = await import('node:fs');
const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
const mod = await import(scenario);
let failures = 0;
const check = (ok, label, info) => { console.log(ok ? 'PASS' : 'FAIL', label, ok ? '' : JSON.stringify(info ?? '').slice(0, 600)); if (!ok) failures++; };
const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 600000);
try { await mod.default({ ev, shot, nav, view, sleep, send, check }); } catch (e) { console.log('SCENARIO ERROR', e); failures++; }
clearTimeout(t); ws.close();
console.log(failures ? `RESULT FAIL (${failures})` : 'RESULT PASS');
process.exit(failures ? 1 : 0);
