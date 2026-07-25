import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'observer'),
  plugins: [svelte()],
  build: {
    outDir: resolve(import.meta.dirname, 'observer-dist'),
    emptyOutDir: true,
  },
});
