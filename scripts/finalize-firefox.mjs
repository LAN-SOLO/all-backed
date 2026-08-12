// Replace the Chrome manifest in dist-firefox/ with the Firefox one
// (background.scripts instead of background.service_worker, gecko id).
import { copyFileSync } from 'node:fs';

copyFileSync('manifest.firefox.json', 'dist-firefox/manifest.json');
console.log('dist-firefox/manifest.json ← manifest.firefox.json');
