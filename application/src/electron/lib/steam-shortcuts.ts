import { SteamShortcutConflictError } from '@ogi/errors';
import {
  type BinaryVdfObject,
  type BinaryVdfValue,
  parseBinaryVdf,
  serializeBinaryVdf,
} from '@/electron/lib/steam-vdf.js';

export interface SteamShortcut {
  index: string;
  fields: BinaryVdfObject;
  appId: number;
  appName: string;
  executable: string;
  launchOptions: string;
  tags: string[];
}

const stringField = (fields: BinaryVdfObject, key: string): string => {
  const field = fields.get(key);
  return field?.type === 1 ? field.value : '';
};

const integerField = (
  fields: BinaryVdfObject,
  key: string
): number | undefined => {
  const field = fields.get(key);
  if (!field) return undefined;
  if (field.type === 2 || field.type === 4 || field.type === 6) {
    return field.value >>> 0;
  }
  if (field.type === 7 || field.type === 10) {
    const value = field.value;
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value) >>> 0;
  }
  return undefined;
};

const tagsField = (fields: BinaryVdfObject): string[] => {
  const tags = fields.get('tags');
  if (tags?.type !== 0) return [];
  return [...tags.value.values()].flatMap((field) =>
    field.type === 1 ? [field.value] : []
  );
};

export function readShortcuts(buffer: Buffer): {
  root: BinaryVdfObject;
  shortcuts: SteamShortcut[];
} {
  const root = buffer.length === 0 ? new Map() : parseBinaryVdf(buffer);
  let container = root.get('shortcuts');
  if (!container) {
    container = { type: 0, value: new Map() };
    root.set('shortcuts', container);
  }
  if (container.type !== 0) throw new Error('Invalid shortcuts.vdf root');

  const shortcuts: SteamShortcut[] = [];
  for (const [index, value] of container.value) {
    if (value.type !== 0) continue;
    const appId = integerField(value.value, 'appid');
    if (appId === undefined) continue;
    shortcuts.push({
      index,
      fields: value.value,
      appId,
      appName: stringField(value.value, 'AppName'),
      executable: stringField(value.value, 'Exe'),
      launchOptions: stringField(value.value, 'LaunchOptions'),
      tags: tagsField(value.value),
    });
  }
  return { root, shortcuts };
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

export function crc32(value: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value, 'utf8')) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function quoteSteamPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed
    : `"${trimmed.replaceAll('"', '\\"')}"`;
}

export function generateNonSteamAppId(
  executable: string,
  appName: string,
  gameId?: number
): number {
  const identity =
    gameId === undefined
      ? `${quoteSteamPath(executable)}${appName}`
      : `${quoteSteamPath(executable)}${appName}\0${gameId}`;
  return (crc32(identity) | 0x80000000) >>> 0;
}

export function getNonSteamLaunchId(appId: number): string {
  return ((BigInt(appId >>> 0) << 32n) | 0x02000000n).toString();
}

const launchGameId = (launchOptions: string): number | undefined => {
  const match = launchOptions.match(/(?:^|\s)--game-id=(\d+)(?=\s|$)/);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : undefined;
};

const isOgiTagged = (shortcut: SteamShortcut): boolean =>
  shortcut.tags.includes('OpenGameInstaller');

export interface ShortcutIdentity {
  gameId: number;
  knownAppId?: number;
  executable: string;
  legacyExecutables?: readonly string[];
  legacyNames?: readonly string[];
}

export function findOwnedShortcut(
  shortcuts: readonly SteamShortcut[],
  identity: ShortcutIdentity
): SteamShortcut | undefined {
  const expectedExecutables = new Set(
    [identity.executable, ...(identity.legacyExecutables ?? [])].map(
      quoteSteamPath
    )
  );
  const names = new Set(identity.legacyNames ?? []);
  const isOwned = (shortcut: SteamShortcut): boolean =>
    (isOgiTagged(shortcut) &&
      launchGameId(shortcut.launchOptions) === identity.gameId) ||
    (expectedExecutables.has(shortcut.executable) &&
      names.has(shortcut.appName) &&
      launchGameId(shortcut.launchOptions) === identity.gameId);

  if (identity.knownAppId !== undefined) {
    const knownMatches = shortcuts.filter(
      (shortcut) => shortcut.appId === (identity.knownAppId as number)
    );
    if (knownMatches.length > 1) {
      throw new SteamShortcutConflictError({
        message: `Multiple Steam shortcuts use app ID ${identity.knownAppId}`,
        gameId: identity.gameId,
      });
    }
    if (knownMatches.length === 1) {
      if (isOwned(knownMatches[0])) return knownMatches[0];
      throw new SteamShortcutConflictError({
        message: `Steam shortcut app ID ${identity.knownAppId} is not owned by OpenGameInstaller game ${identity.gameId}`,
        gameId: identity.gameId,
      });
    }
  }

  const ownedMatches = shortcuts.filter(
    (shortcut) =>
      isOgiTagged(shortcut) &&
      launchGameId(shortcut.launchOptions) === identity.gameId
  );
  if (ownedMatches.length > 1) {
    throw new SteamShortcutConflictError({
      message: `Multiple OpenGameInstaller shortcuts belong to game ${identity.gameId}`,
      gameId: identity.gameId,
    });
  }
  if (ownedMatches.length === 1) return ownedMatches[0];

  const legacyMatches = shortcuts.filter(
    (shortcut) =>
      expectedExecutables.has(shortcut.executable) &&
      names.has(shortcut.appName) &&
      launchGameId(shortcut.launchOptions) === identity.gameId
  );
  if (legacyMatches.length > 1) {
    throw new SteamShortcutConflictError({
      message: `Multiple legacy Steam shortcuts match game ${identity.gameId}`,
      gameId: identity.gameId,
    });
  }
  return legacyMatches[0];
}

export interface UpsertShortcutOptions extends ShortcutIdentity {
  appName: string;
  startDir: string;
  launchOptions?: string;
  icon?: string;
  tags?: string[];
}

export function upsertShortcut(
  root: BinaryVdfObject,
  options: UpsertShortcutOptions
): { appId: number; created: boolean } {
  let container = root.get('shortcuts');
  if (!container) {
    container = { type: 0, value: new Map() };
    root.set('shortcuts', container);
  }
  if (container.type !== 0) throw new Error('Invalid shortcuts.vdf root');

  const existing = findOwnedShortcut(
    readShortcuts(serializeBinaryVdf(root)).shortcuts,
    options
  );
  const storedExecutable = quoteSteamPath(options.executable);
  const appId = generateNonSteamAppId(
    options.executable,
    options.appName,
    options.gameId
  );
  const tags: BinaryVdfObject = new Map(
    (options.tags ?? []).map((tag, index) => [
      String(index),
      { type: 1 as const, value: tag },
    ])
  );
  const fields: BinaryVdfObject = existing?.fields ?? new Map();
  fields.set('appid', { type: 2, value: appId | 0 });
  fields.set('AppName', { type: 1, value: options.appName });
  fields.set('Exe', { type: 1, value: storedExecutable });
  fields.set('StartDir', { type: 1, value: quoteSteamPath(options.startDir) });
  fields.set('icon', { type: 1, value: options.icon ?? '' });
  fields.set('ShortcutPath', { type: 1, value: '' });
  fields.set('LaunchOptions', { type: 1, value: options.launchOptions ?? '' });
  if (!fields.has('IsHidden')) fields.set('IsHidden', { type: 2, value: 0 });
  if (!fields.has('AllowDesktopConfig'))
    fields.set('AllowDesktopConfig', { type: 2, value: 1 });
  if (!fields.has('AllowOverlay'))
    fields.set('AllowOverlay', { type: 2, value: 1 });
  if (!fields.has('OpenVR')) fields.set('OpenVR', { type: 2, value: 0 });
  if (!fields.has('Devkit')) fields.set('Devkit', { type: 2, value: 0 });
  if (!fields.has('DevkitGameID'))
    fields.set('DevkitGameID', { type: 1, value: '' });
  if (!fields.has('DevkitOverrideAppID'))
    fields.set('DevkitOverrideAppID', { type: 2, value: 0 });
  if (!fields.has('LastPlayTime'))
    fields.set('LastPlayTime', { type: 2, value: 0 });
  if (!fields.has('FlatpakAppID'))
    fields.set('FlatpakAppID', { type: 1, value: '' });
  fields.set('tags', { type: 0, value: tags });

  if (existing) {
    container.value.set(existing.index, { type: 0, value: fields });
  } else {
    const used = new Set([...container.value.keys()]);
    let index = 0;
    while (used.has(String(index))) index++;
    container.value.set(String(index), { type: 0, value: fields });
  }
  return { appId, created: !existing };
}

export function removeOwnedShortcut(
  root: BinaryVdfObject,
  identity: ShortcutIdentity
): { removed: boolean; appId?: number } {
  const container = root.get('shortcuts');
  if (container?.type !== 0) return { removed: false };
  const target = findOwnedShortcut(
    readShortcuts(serializeBinaryVdf(root)).shortcuts,
    identity
  );
  if (!target) return { removed: false };
  return container.value.delete(target.index)
    ? { removed: true, appId: target.appId }
    : { removed: false };
}

export function setUnsignedIntegerField(
  fields: BinaryVdfObject,
  key: string,
  value: number,
  type: 2 | 4 | 6 = 2
): void {
  const field: BinaryVdfValue =
    type === 2 ? { type, value: value | 0 } : { type, value: value >>> 0 };
  fields.set(key, field);
}
