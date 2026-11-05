import { defineConfig } from 'vite';

// fleet-host: one self-contained ESM file for plain Node 22 (no node_modules in the image).
export default defineConfig({
  build: {
    ssr: 'src/host/cli.ts',
    outDir: 'out/host',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'fleet-host.mjs', format: 'es' } }
  },
  ssr: { noExternal: true, target: 'node' }
});
