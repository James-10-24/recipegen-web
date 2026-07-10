// Post-export step for the web PWA (served under the /app base path).
//
// `experiments.baseUrl: "/app"` makes Expo emit asset URLs prefixed with
// /app (e.g. /app/_expo/...), but the files themselves are written FLAT to
// dist/ (dist/_expo, dist/index.html, ...). So the physical layout doesn't
// match the URLs. This script:
//
//   1. Moves everything in dist/ into dist/app/ so the layout matches the
//      /app-prefixed URLs (and a static host can serve it directly).
//   2. Injects the PWA manifest link, theme/iOS meta, and the service-worker
//      registration into dist/app/index.html (SPA output doesn't run
//      app/+html.tsx, so there's no in-framework hook).
//
// Result: dist/app/ is a self-contained PWA rooted at /app. recipegen-web's
// own Vercel project serves it at <project>.vercel.app/app, and the
// marketing project proxies yourdomain.com/app/* to it.
//
// Idempotent: safe to re-run (skips the move if dist/app already exists and
// skips injection if the marker is present).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const appDir = join(dist, 'app');

if (!existsSync(dist)) {
  console.error('[postbuild-web] dist/ not found — run expo export first.');
  process.exit(1);
}

// 1. Move dist/* → dist/app/* (unless already nested).
if (!existsSync(appDir)) {
  mkdirSync(appDir);
  for (const entry of readdirSync(dist)) {
    if (entry === 'app') continue;
    renameSync(join(dist, entry), join(appDir, entry));
  }
  console.log('[postbuild-web] moved dist/* into dist/app/');
} else {
  console.log('[postbuild-web] dist/app already exists — skipping move.');
}

// 2. Inject PWA head tags + SW registration into dist/app/index.html.
const indexPath = join(appDir, 'index.html');
if (!existsSync(indexPath)) {
  console.error('[postbuild-web] dist/app/index.html not found.');
  process.exit(1);
}

const MARKER = '<!-- pwa:injected -->';
let html = readFileSync(indexPath, 'utf8');

if (html.includes(MARKER)) {
  console.log('[postbuild-web] PWA tags already injected — done.');
  process.exit(0);
}

const headTags = `
    ${MARKER}
    <link rel="manifest" href="/app/manifest.json" />
    <meta name="theme-color" content="#a4501f" />
    <!-- App is light-only; force light UA rendering of form controls so
         inputs don't get a dark background (black-on-black text) on a
         dark-mode OS. -->
    <meta name="color-scheme" content="light" />
    <meta name="description" content="Plan meals, get a smart grocery list that subtracts your pantry, and stop overbuying." />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="RecipeGen" />
    <link rel="apple-touch-icon" href="/app/icons/apple-touch-icon.png" />`;

const swScript = `
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker
            .register('/app/sw.js', { scope: '/app/' })
            .catch(function (err) { console.warn('SW registration failed:', err); });
        });
      }
    </script>`;

html = html.replace('</head>', `${headTags}\n  </head>`);
html = html.replace('</body>', `${swScript}\n  </body>`);

writeFileSync(indexPath, html, 'utf8');
console.log('[postbuild-web] injected PWA manifest, meta tags, and SW registration.');
