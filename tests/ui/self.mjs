// Engine self-test (src/engine/selftest.ts) in real Chromium with real OPFS.
export default async ({ ev, nav, check }) => {
  await nav('http://127.0.0.1:5794/');
  const ok = await ev('window.abSelfTest()');
  check(ok === true, 'abSelfTest()', ok);
};
