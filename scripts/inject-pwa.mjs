// Post-export step for the web PWA.
//
// Expo's SPA web output (`web.output: "single"`) emits a fixed index.html
// template and does NOT run app/+html.tsx, so there is no in-framework hook
// to add the PWA manifest link, theme-color, iOS standalone meta, or the
// service-worker registration. This script injects them into dist/index.html
// after `expo export`. Idempotent — running it twice is a no-op.
//
// Wired up as part of `npm run build:web` (see package.json), so it runs
// both locally and on Vercel.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');
const indexPath = join(distDir, 'index.html');

if (!existsSync(indexPath)) {
  console.error(
    '[inject-pwa] dist/index.html not found — run `expo export --platform web` first.',
  );
  process.exit(1);
}

const MARKER = '<!-- pwa:injected -->';
let html = readFileSync(indexPath, 'utf8');

if (html.includes(MARKER)) {
  console.log('[inject-pwa] already injected — skipping.');
  process.exit(0);
}

const headTags = `
    ${MARKER}
    <link rel="manifest" href="/manifest.json" />
    <meta name="theme-color" content="#a4501f" />
    <meta name="description" content="Plan meals, get a smart grocery list that subtracts your pantry, and stop overbuying." />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="RecipeGen" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />`;

const swScript = `
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js').catch(function (err) {
            console.warn('SW registration failed:', err);
          });
        });
      }
    </script>`;

// Inject head tags right before </head> and the SW registration before </body>.
html = html.replace('</head>', `${headTags}\n  </head>`);
html = html.replace('</body>', `${swScript}\n  </body>`);

writeFileSync(indexPath, html, 'utf8');
console.log('[inject-pwa] injected PWA manifest, meta tags, and SW registration.');
