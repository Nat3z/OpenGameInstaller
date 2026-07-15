import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ['ogi-addon'] })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/electron/main.ts'),
        },
        external: ['original-fs', 'node-datachannel', 'utp-native'],
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ['ogi-addon'] })],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/electron/preload.mts'),
          splash: resolve(__dirname, 'src/electron/splash-preload.mts'),
        },
        external: ['original-fs'],
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    root: '.',
    publicDir: 'public',
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    plugins: [tailwindcss(), svelte()],
    server: {
      port: 8080,
      watch: {
        ignored: ['**/development/**'],
      },
    },
  },
});
