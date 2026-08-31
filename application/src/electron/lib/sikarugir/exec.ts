import { execFile } from 'node:child_process';
import { SikarugirError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

/**
 * Run an absolute system executable with a fixed PATH. Every Sikarugir helper
 * (`tar`, `plutil`, `codesign`, `xattr`, `ps`) goes through here so a user's
 * shell environment can never redirect them.
 */
export const executeAbsolute = (
  executablePath: string,
  args: readonly string[],
  step: string
): Effect.Effect<string, SikarugirError> =>
  Effect.async<string, SikarugirError>((resume) => {
    const child = execFile(
      executablePath,
      [...args],
      {
        env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        // Sized for the largest caller (`ps -ax -o command=`), whose full
        // command lines can exceed the 1 MiB execFile default.
        maxBuffer: 16 * 1024 * 1024,
      },
      (cause, stdout, stderr) => {
        if (cause) {
          resume(
            Effect.fail(
              new SikarugirError({
                message: `${cause.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                step,
                cause,
              })
            )
          );
        } else {
          resume(Effect.succeed(stdout));
        }
      }
    );
    return Effect.sync(() => child.kill());
  });
