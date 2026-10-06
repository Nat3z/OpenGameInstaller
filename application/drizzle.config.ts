import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/electron/database/schema.ts',
  out: './drizzle',
  // Studio reads the dev database (or OGI_DIRECTORY's) through @libsql/client,
  // since better-sqlite3 is built for Electron and won't load under Node.
  dbCredentials: {
    url: join(process.env.OGI_DIRECTORY ?? './development', 'ogi.sqlite'),
  },
});
