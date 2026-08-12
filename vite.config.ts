import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Dev-only sink so the browser E2E test can persist exported archives to
// disk (testdata-out/) instead of relying on the Downloads folder.
function testSink(): Plugin {
  return {
    name: 'ab-test-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__abtest/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const name = basename(
          new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? 'out.bin'
        );
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          mkdirSync('testdata-out', { recursive: true });
          writeFileSync(join('testdata-out', name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

// base './' keeps asset URLs relative so the built page works as a
// chrome-extension:// tab page without further rewriting
export default defineConfig({
  base: './',
  plugins: [react(), testSink()],
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
