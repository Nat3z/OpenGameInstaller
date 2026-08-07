import tailwind from '@astrojs/tailwind';
import { defineConfig } from 'astro/config';
import remarkGfm from 'remark-gfm';
import remarkCallouts from './remark/callouts.mjs';
import { generateLlmsBundle } from './scripts/generate-llms.mjs';

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
