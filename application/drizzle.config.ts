import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/electron/database/schema.ts',
  out: './drizzle',
  // Studio opens the dev database, or OGI_DIRECTORY's when set.
  dbCredentials: {
    url: join(process.env.OGI_DIRECTORY ?? './development', 'ogi.sqlite'),
  },
});
