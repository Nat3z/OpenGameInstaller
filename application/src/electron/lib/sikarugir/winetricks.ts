import * as fs from 'node:fs';
import * as path from 'node:path';
import { SikarugirError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

export interface WinetricksReconciliation {
  readonly requested: readonly string[];
  readonly installed: readonly string[];
  readonly missing: readonly string[];
}

const normalizeVerb = (verb: string): string => verb.trim().toLowerCase();

export const normalizeWinetricksVerbs = (
  requested: readonly (readonly string[])[]
): Effect.Effect<readonly string[], SikarugirError> =>
  Effect.try({
    try: () => {
      const verbs = requested.flat().map(normalizeVerb);
      const invalid = verbs.find(
        (verb) => !verb || verb.includes('\n') || verb.includes('\r')
      );
      if (invalid !== undefined) throw new Error('Invalid Winetricks verb');
      return [...new Set(verbs)];
    },
    catch: (cause) =>
      new SikarugirError({
        message: 'A requested Winetricks verb is invalid',
        step: 'winetricks-reconcile',
        cause,
      }),
  });

export const readInstalledWinetricksVerbs = (
  prefixPath: string
): Effect.Effect<readonly string[], SikarugirError> =>
  Effect.try({
    try: () => {
      const logPath = path.join(prefixPath, 'winetricks.log');
      if (!fs.existsSync(logPath)) return [];
      // The wrapper log is authoritative; failed attempts must remain retryable.
      return [
        ...new Set(
          fs
            .readFileSync(logPath, 'utf8')
            .split(/\r?\n/)
            .map(normalizeVerb)
            .filter((verb) => verb.length > 0 && !verb.startsWith('#'))
        ),
      ];
    },
    catch: (cause) =>
      new SikarugirError({
        message: `Could not read ${path.join(prefixPath, 'winetricks.log')}`,
        step: 'winetricks-reconcile',
        cause,
      }),
  });

export const reconcileWinetricksVerbs = (
  prefixPath: string,
  requested: readonly (readonly string[])[]
): Effect.Effect<WinetricksReconciliation, SikarugirError> =>
  Effect.gen(function* () {
    const requestedVerbs = yield* normalizeWinetricksVerbs(requested);
    const installed = yield* readInstalledWinetricksVerbs(prefixPath);
    const installedSet = new Set(installed);
    return {
      requested: requestedVerbs,
      installed,
      missing: requestedVerbs.filter((verb) => !installedSet.has(verb)),
    };
  });
