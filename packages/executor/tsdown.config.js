import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['lib/index.ts'],
  splitting: false,
  sourcemap: true,
  clean: true,
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'build',
  target: false,
});
