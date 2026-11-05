import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// fleet-host and fleet-host-cred for plain Node 22 (no node_modules in the image).
// Shared code and lazily imported modules land in out/host/chunks/.
export default defineConfig({
  resolve: { alias: { 'better-sqlite3': fileURLToPath(new URL('src/host/sqliteStub.ts', import.meta.url)) } },
  build: {
    ssr: true,
    outDir: 'out/host',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { 'fleet-host': 'src/host/cli.ts', 'fleet-host-cred': 'src/host/credMain.ts' },
      output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs', format: 'es' }
    }
  },
  ssr: { noExternal: true, target: 'node' }
});
