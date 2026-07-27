import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Data, Effect, Exit } from 'effect';
import {
  normalizeElectronArgumentPath,
  resolveElectronExecutable,
} from '../electron-service-options';
import { createObserverServer } from './observer-server';

class ObserverAccessibilityError extends Data.TaggedError(
  'ObserverAccessibilityError'
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message() {
    return this.detail;
  }
}

const electronPath = resolveElectronExecutable();
const resultDirectory = mkdtempSync(join(tmpdir(), 'ogi-observer-axe-'));
const resultPath = join(resultDirectory, 'violations.json');

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
    Effect.async<void, ObserverAccessibilityError>((resume) => {
      const appEntryPoint = normalizeElectronArgumentPath(
        join(import.meta.dir, 'observer-accessibility-main.cjs')
      );
      const electronArgs = [
        '--disable-gpu',
        '--no-sandbox',
        `--app=${appEntryPoint}`,
        server.url,
        normalizeElectronArgumentPath(resultPath),
      ];
      const command = process.platform === 'linux' ? 'xvfb-run' : electronPath;
      const args =
        process.platform === 'linux'
          ? ['-a', electronPath, ...electronArgs]
          : electronArgs;
      const child = spawn(command, args, {
        cwd: join(import.meta.dir, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        process.stderr.write(chunk);
      });
      const onError = (cause: Error) =>
        resume(
          Effect.fail(
            new ObserverAccessibilityError({
              detail: 'Observer accessibility Electron process failed to start',
              cause,
            })
          )
        );
      const onExit = (status: number | null) =>
        resume(
          status === 0
            ? Effect.void
            : Effect.fail(
                new ObserverAccessibilityError({
                  detail: `Observer accessibility Electron process exited with status ${status}${
                    stderr.trim() ? `: ${stderr.trim()}` : ''
                  }${stdout.trim() ? `; stdout: ${stdout.trim()}` : ''}`,
                })
              )
        );
      child.once('error', onError);
      child.once('exit', onExit);
      return Effect.sync(() => {
        child.off('error', onError);
        child.off('exit', onExit);
        if (child.exitCode === null) child.kill('SIGTERM');
      });
    }).pipe(
      Effect.timeoutFail({
        duration: '1 minute',
        onTimeout: () =>
          new ObserverAccessibilityError({
            detail:
              'Observer accessibility scan did not complete within 1 minute',
          }),
      }),
      Effect.flatMap(() =>
        Effect.try({
          try: () => {
            const violations = JSON.parse(
              readFileSync(resultPath, 'utf8')
            ) as Array<{ id: string; impact: string; help: string }>;
            if (violations.length > 0) {
              throw new Error(
                violations
                  .map(
                    (violation) =>
                      `${violation.id} (${violation.impact}): ${violation.help}`
                  )
                  .join('\n')
              );
            }
            console.log('Observer Window accessibility scan passed.');
          },
          catch: (cause) =>
            new ObserverAccessibilityError({
              detail: `Observer Window accessibility violations detected: ${(cause as Error).message}`,
              cause,
            }),
        })
      )
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
