import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

function resolveAppBuilderPath() {
  const searchPaths = [
    process.cwd(),
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), 'application'),
    path.join(process.cwd(), 'application', 'node_modules'),
    path.join(process.cwd(), 'updater'),
    path.join(process.cwd(), 'updater', 'node_modules'),
  ];

  for (const searchPath of searchPaths) {
    try {
      const modulePath = require.resolve('app-builder-bin', {
        paths: [searchPath],
      });
      return require(modulePath).appBuilderPath;
    } catch {
      // Try the next candidate path.
    }
  }

  throw new Error(
    'Unable to resolve app-builder-bin. Ensure dependencies are installed before generating blockmaps.'
  );
}

const appBuilderPath = resolveAppBuilderPath();

function runAppBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(appBuilderPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`app-builder exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: bun run .github/workflows/js/generate-blockmaps.mjs <file> [file...]');
    process.exit(1);
  }

  for (const artifact of args) {
    const artifactPath = path.resolve(artifact);
    const blockmapPath = `${artifactPath}.blockmap`;

    if (!existsSync(artifactPath)) {
      console.error(`Artifact not found: ${artifactPath}`);
      process.exit(1);
    }

    console.log(`Generating blockmap: ${blockmapPath}`);
    await runAppBuilder(['blockmap', '--input', artifactPath, '--output', blockmapPath]);
  }
}

await main();
