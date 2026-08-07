import {
  Cause,
  Effect,
  HashMap,
  Layer,
  Logger,
  LogLevel,
  Option,
} from 'effect';
import type { LoggerPrefix } from './prefixes.js';

export type { LoggerPrefix } from './prefixes.js';
export { LOGGER_PREFIXES, makeLoggerPrefix } from './prefixes.js';

const PREFIX_ANNOTATION = '@ogi/logger/prefix';

type ConsoleMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const getConsoleMethod = (level: LogLevel.LogLevel): ConsoleMethod => {
  switch (level._tag) {
    case 'Trace':
      return 'trace';
    case 'Debug':
      return 'debug';
    case 'Warning':
      return 'warn';
    case 'Error':
    case 'Fatal':
      return 'error';
    case 'All':
    case 'Info':
    case 'None':
      return 'info';
  }
};

const ogiLogger = Logger.make<unknown, void>(
  ({ annotations, cause, logLevel, message }) => {
    const prefix = Option.getOrElse(
      HashMap.get(annotations, PREFIX_ANNOTATION),
      () => 'ogi'
    );
    const context = Object.fromEntries(
      Array.from(HashMap.entries(annotations)).filter(
        ([key]) => key !== PREFIX_ANNOTATION
      )
    );
    const details = Array.isArray(message) ? [...message] : [message];

    if (Object.keys(context).length > 0) {
      details.push(context);
    }
    if (!Cause.isEmpty(cause)) {
      details.push(Cause.pretty(cause));
    }

    globalThis.console[getConsoleMethod(logLevel)](
      `[${String(prefix)} ${logLevel.label}]`,
      ...details
    );
  }
);

export const OgiLoggerLayer = Layer.merge(
  Logger.replace(Logger.defaultLogger, ogiLogger),
  Logger.minimumLogLevel(LogLevel.All)
);

export const withLoggerPrefix =
  (prefix: LoggerPrefix | string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.annotateLogs(PREFIX_ANNOTATION, prefix),
      Effect.provide(OgiLoggerLayer)
    );

export type EffectLogger = {
  readonly trace: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly debug: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly info: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly warn: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly error: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
  readonly fatal: (...message: ReadonlyArray<unknown>) => Effect.Effect<void>;
};

export type OgiLogger = EffectLogger & {
  readonly sync: {
    readonly trace: (...message: ReadonlyArray<unknown>) => void;
    readonly debug: (...message: ReadonlyArray<unknown>) => void;
    readonly info: (...message: ReadonlyArray<unknown>) => void;
    readonly warn: (...message: ReadonlyArray<unknown>) => void;
    readonly error: (...message: ReadonlyArray<unknown>) => void;
    readonly fatal: (...message: ReadonlyArray<unknown>) => void;
  };
  readonly observe: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
};

export const createLogger = (prefix: LoggerPrefix | string): OgiLogger => {
  const observe = withLoggerPrefix(prefix);
  const effect: EffectLogger = {
    trace: (...message) => observe(Effect.logTrace(...message)),
    debug: (...message) => observe(Effect.logDebug(...message)),
    info: (...message) => observe(Effect.logInfo(...message)),
    warn: (...message) => observe(Effect.logWarning(...message)),
    error: (...message) => observe(Effect.logError(...message)),
    fatal: (...message) => observe(Effect.logFatal(...message)),
  };

  return {
    ...effect,
    sync: {
      trace: (...message) => Effect.runSync(effect.trace(...message)),
      debug: (...message) => Effect.runSync(effect.debug(...message)),
      info: (...message) => Effect.runSync(effect.info(...message)),
      warn: (...message) => Effect.runSync(effect.warn(...message)),
      error: (...message) => Effect.runSync(effect.error(...message)),
      fatal: (...message) => Effect.runSync(effect.fatal(...message)),
    },
    observe,
  };
};
