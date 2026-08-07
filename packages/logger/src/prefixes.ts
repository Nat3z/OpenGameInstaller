export const LOGGER_PREFIXES = {
  electron: 'electron',
  frontend: 'frontend',
  updater: 'updater',
  addonServer: 'addon-server',
  clientKit: 'client-kit',
  connection: 'connection',
  errors: 'errors',
  executor: 'executor',
  addon: 'addon',
  allDebrid: 'all-debrid',
  realDebrid: 'real-debrid',
  web: 'web',
  tooling: 'tooling',
  testAddon: 'test-addon',
} as const;

export type LoggerPrefix =
  (typeof LOGGER_PREFIXES)[keyof typeof LOGGER_PREFIXES];

export const makeLoggerPrefix = (
  prefix: LoggerPrefix,
  ...segments: ReadonlyArray<string | number | undefined>
): string =>
  [prefix, ...segments]
    .filter((segment): segment is string | number => segment !== undefined)
    .map(String)
    .filter(Boolean)
    .join(':');
