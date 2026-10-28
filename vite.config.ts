import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';

// Google Analytics for robotron.hatch.org. Injected into production builds
// only, so dev play-testing isn't counted; game events: js/core/Analytics.ts.
const GA_ID = 'G-X8M1RT1GMP';
const GA_TAG = `<!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());

      gtag('config', '${GA_ID}');
    </script>`;

// Production is served from the root of its domain (deploy.sh);
// the dev server keeps the /robotron/ path.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/' : '/robotron/',
  plugins: [{
    name: 'google-analytics',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    ${GA_TAG}`);
    },
  }, {
    // sprites/ and sounds/ are fetched at runtime (not imported), so Vite
    // doesn't bundle them — copy them into dist explicitly.
    name: 'copy-runtime-assets',
    closeBundle() {
      cpSync('sprites', 'dist/sprites', { recursive: true });
      cpSync('sounds', 'dist/sounds', { recursive: true });
    },
  }],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          'pixi': ['pixi.js'],
          'howler': ['howler']
        }
      }
    }
  },
  server: {
    port: 5173,
    open: true
  }
}));
