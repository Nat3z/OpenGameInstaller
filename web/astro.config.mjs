import { defineConfig } from 'astro/config';

import tailwind from '@astrojs/tailwind';
import remarkCallouts from './remark/callouts.mjs';
import remarkGfm from 'remark-gfm';

// https://astro.build/config
export default defineConfig({
  integrations: [tailwind()],
  markdown: {
    remarkPlugins: [remarkGfm, remarkCallouts],
  },
});
