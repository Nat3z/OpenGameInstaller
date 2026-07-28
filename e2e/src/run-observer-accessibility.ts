import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Data, Effect, Exit } from 'effect';
import puppeteer from 'puppeteer-core';
import { createObserverServer } from './observer-server';

class ObserverAccessibilityError extends Data.TaggedError(
  'ObserverAccessibilityError'
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message() {
    return this.detail;
  }
}

const require = createRequire(import.meta.url);
const resultDirectory = mkdtempSync(join(tmpdir(), 'ogi-observer-axe-'));
const resultPath = join(resultDirectory, 'violations.json');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

function resolveChromeExecutable() {
  const candidates =
    process.platform === 'win32'
      ? [
          join(
            process.env.PROGRAMFILES ?? 'C:\\Program Files',
            'Google/Chrome/Application/chrome.exe'
          ),
          join(
            process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
            'Google/Chrome/Application/chrome.exe'
          ),
          join(
            process.env.LOCALAPPDATA ?? '',
            'Google/Chrome/Application/chrome.exe'
          ),
        ]
      : [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
        ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      try {
        accessSync(candidate, constants.F_OK);
        return candidate;
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error(
    `Unable to locate a Chrome/Chromium executable for Observer accessibility (platform=${process.platform})`
  );
}

const program = Effect.acquireUseRelease(
  Effect.tryPromise({
    try: () => createObserverServer({ openWindow: false }),
    catch: (cause) =>
      new ObserverAccessibilityError({
        detail: 'Observer Window server failed to start for accessibility scan',
        cause,
      }),
  }),
  (server) =>
    Effect.tryPromise({
      try: async () => {
        // Observer is a normal web page. Scan it with system Chrome instead of a
        // raw Electron main-process launch, which exits 255 on Windows CI hosts.
        const browser = await puppeteer.launch({
          executablePath: resolveChromeExecutable(),
          headless: true,
          args: ['--disable-gpu', '--no-sandbox'],
        });
        try {
          const page = await browser.newPage();
          await page.goto(server.url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('input[value="live-service"]', {
            timeout: 15_000,
          });
          await page.evaluate(axeSource);
          const violations = await page.evaluate(async () => {
            const options = {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
              },
            };
            const axe = (
              globalThis as typeof globalThis & {
                axe: {
                  run: (
                    root: Document,
                    runOptions: typeof options
                  ) => Promise<{ violations: unknown[] }>;
                };
              }
            ).axe;
            const deterministic = await axe.run(document, options);
            const liveService = document.querySelector(
              'input[value="live-service"]'
            );
            if (!(liveService instanceof HTMLInputElement)) {
              throw new Error('Observer live-service control did not appear');
            }
            liveService.click();
            await new Promise((resolve) =>
              requestAnimationFrame(() => resolve(undefined))
            );
            const live = await axe.run(document, options);
            return [...deterministic.violations, ...live.violations];
          });
          writeFileSync(resultPath, JSON.stringify(violations, null, 2));
          if (violations.length > 0) {
            throw new Error(
              (
                violations as Array<{
                  id: string;
                  impact?: string;
                  help: string;
                }>
              )
                .map(
                  (violation) =>
                    `${violation.id} (${violation.impact}): ${violation.help}`
                )
                .join('\n')
            );
          }
          console.log('Observer Window accessibility scan passed.');
        } finally {
          await browser.close();
        }
      },
      catch: (cause) =>
        new ObserverAccessibilityError({
          detail: `Observer Window accessibility scan failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: '1 minute',
        onTimeout: () =>
          new ObserverAccessibilityError({
            detail:
              'Observer accessibility scan did not complete within 1 minute',
          }),
      })
    ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        new ObserverAccessibilityError({
          detail:
            'Observer Window server failed to stop after accessibility scan',
          cause,
        }),
    }).pipe(Effect.orDie)
);

const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onFailure: (cause) => {
    console.error(Cause.pretty(cause));
    process.exitCode = 1;
  },
  onSuccess: () => {
    process.exitCode = 0;
  },
});
