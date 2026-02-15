import { defineConfig } from 'astro/config';

import tailwind from '@astrojs/tailwind';
import { generateLlmsBundle } from './scripts/generate-llms.mjs';
import remarkCallouts from './remark/callouts.mjs';
import remarkGfm from 'remark-gfm';

function llmsBuildIntegration() {
  return {
    name: 'llms-build-integration',
    hooks: {
      'astro:build:start': async () => {
        const generatedPath = await generateLlmsBundle();
        console.log(`Generated ${generatedPath}`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: 'https://ogi.nat3z.com',
  integrations: [tailwind(), llmsBuildIntegration()],
  markdown: {
    remarkPlugins: [remarkGfm, remarkCallouts],
  },
});
