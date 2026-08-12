import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Build identity (#298): bake the short sha of the commit being built into
// the main bundle (`__BUILD_SHA__`, read by src/main/appVersion.ts). A
// packaged app can't ask git at runtime, and the semver alone can't
// distinguish two builds of the same release. Prefer the checkout's actual
// HEAD; fall back to CI's GITHUB_SHA for builds from an export without .git.
function buildSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if (sha) return sha;
  } catch {
    // Not a git checkout (or git missing) — fall through.
  }
  return process.env.GITHUB_SHA?.slice(0, 7) || null;
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __BUILD_SHA__: JSON.stringify(buildSha()) },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // Inline bundled fonts as data: URIs. The renderer is served over
      // `file://` (win.loadFile), where an emitted-as-a-file @font-face woff2
      // fails to load ("A network error occurred"); a data: URI works. Scoped
      // to woff2 so other assets keep Vite's default size threshold.
      assetsInlineLimit: (filePath: string) =>
        filePath.endsWith('.woff2') ? true : undefined,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
});
