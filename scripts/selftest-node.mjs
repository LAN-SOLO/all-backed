// Runs the engine self-test (src/engine/selftest.ts) under Node against an
// in-memory File System Access implementation — no browser, no dialogs.
// `pnpm test` builds the engine with Vite (SSR mode, no extra deps) and then
// executes this script. Exit code 0 = PASS.
import { build } from 'vite';
import { rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { installMemOpfs } from './memfs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.selftest-build');

await build({
  root,
  logLevel: 'warn',
  configFile: false,
  build: {
    ssr: join(root, 'src/engine/selftest.ts'),
    outDir,
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: 'selftest.mjs', format: 'es' } },
  },
});

installMemOpfs();
const { abSelfTest } = await import(pathToFileURL(join(outDir, 'selftest.mjs')).href);
const watchdog = setTimeout(() => {
  console.error('[ABTEST] FAIL — timeout (engine hangs?)');
  process.exit(2);
}, 180_000);
const ok = await abSelfTest();
clearTimeout(watchdog);
rmSync(outDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
