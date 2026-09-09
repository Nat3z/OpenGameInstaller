import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/electron/database/schema.ts',
  out: './drizzle',
});
