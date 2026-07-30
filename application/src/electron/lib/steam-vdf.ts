import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BinaryVdfValue =
  | { type: 0; value: BinaryVdfObject }
  | { type: 1; value: string }
  | { type: 2; value: number }
  | { type: 3; value: number }
  | { type: 4; value: number }
  | { type: 5; value: string }
  | { type: 6; value: number }
  | { type: 7; value: bigint }
  | { type: 10; value: bigint };

export type BinaryVdfObject = Map<string, BinaryVdfValue>;

export interface SteamShortcut {
  index: string;
  fields: BinaryVdfObject;
  appId: number;
  appName: string;
  executable: string;
}

export interface SteamUser {
  accountId: string;
  steamId?: string;
  accountName?: string;
  personaName?: string;
  mostRecent: boolean;
  timestamp: number;
  userdataPath: string;
  shortcutsPath: string;
}

export interface SteamLocation {
  root: string;
  user: SteamUser;
  loginUsersPath: string;
}

const readCString = (buffer: Buffer, state: { offset: number }): string => {
  const end = buffer.indexOf(0, state.offset);
  if (end < 0) throw new Error('Invalid binary VDF: unterminated string');
  const value = buffer.toString('utf8', state.offset, end);
  state.offset = end + 1;
  return value;
};

const ensureBytes = (buffer: Buffer, offset: number, count: number): void => {
  if (offset + count > buffer.length) {
    throw new Error('Invalid binary VDF: unexpected end of file');
  }
};

const parseBinaryObject = (
  buffer: Buffer,
  state: { offset: number }
): BinaryVdfObject => {
  const result: BinaryVdfObject = new Map();
  while (state.offset < buffer.length) {
    const type = buffer[state.offset++];
    if (type === 8 || type === 11) return result;
    const key = readCString(buffer, state);
    switch (type) {
      case 0:
        result.set(key, { type, value: parseBinaryObject(buffer, state) });
        break;
      case 1:
        result.set(key, { type, value: readCString(buffer, state) });
        break;
      case 2:
        ensureBytes(buffer, state.offset, 4);
        result.set(key, { type, value: buffer.readInt32LE(state.offset) });
        state.offset += 4;
        break;
      case 3:
        ensureBytes(buffer, state.offset, 4);
        result.set(key, { type, value: buffer.readFloatLE(state.offset) });
        state.offset += 4;
        break;
      case 4:
      case 6:
        ensureBytes(buffer, state.offset, 4);
        result.set(key, { type, value: buffer.readUInt32LE(state.offset) });
        state.offset += 4;
        break;
      case 5: {
        let end = -1;
        for (
          let cursor = state.offset;
          cursor + 1 < buffer.length;
          cursor += 2
        ) {
          if (buffer[cursor] === 0 && buffer[cursor + 1] === 0) {
            end = cursor;
            break;
          }
        }
        if (end < 0)
          throw new Error('Invalid binary VDF: unterminated wide string');
        const byteLength = end - state.offset;
        result.set(key, {
          type,
          value: buffer.toString(
            'utf16le',
            state.offset,
            state.offset + byteLength
          ),
        });
        state.offset += byteLength + 2;
        break;
      }
      case 7:
        ensureBytes(buffer, state.offset, 8);
        result.set(key, { type, value: buffer.readBigUInt64LE(state.offset) });
        state.offset += 8;
        break;
      case 10:
        ensureBytes(buffer, state.offset, 8);
        result.set(key, { type, value: buffer.readBigInt64LE(state.offset) });
        state.offset += 8;
        break;
      default:
        throw new Error(
          `Unsupported binary VDF type ${type} at offset ${state.offset - 1}`
        );
    }
  }
  throw new Error('Invalid binary VDF: missing object terminator');
};

export function parseBinaryVdf(buffer: Buffer): BinaryVdfObject {
  if (buffer.length === 0) return new Map();
  const state = { offset: 0 };
  const result = parseBinaryObject(buffer, state);
  if (state.offset !== buffer.length) {
    throw new Error('Invalid binary VDF: trailing bytes');
  }
  return result;
}

const cString = (value: string): Buffer => {
  if (value.includes('\0'))
    throw new Error('VDF strings cannot contain NUL bytes');
  return Buffer.from(`${value}\0`, 'utf8');
};

const serializeBinaryObject = (object: BinaryVdfObject): Buffer => {
  const chunks: Buffer[] = [];
  for (const [key, field] of object) {
    chunks.push(Buffer.from([field.type]), cString(key));
    switch (field.type) {
      case 0:
        chunks.push(serializeBinaryObject(field.value));
        break;
      case 1:
        chunks.push(cString(field.value));
        break;
      case 2: {
        const value = Buffer.allocUnsafe(4);
        value.writeInt32LE(field.value);
        chunks.push(value);
        break;
      }
      case 3: {
        const value = Buffer.allocUnsafe(4);
        value.writeFloatLE(field.value);
        chunks.push(value);
        break;
      }
      case 4:
      case 6: {
        const value = Buffer.allocUnsafe(4);
        value.writeUInt32LE(field.value);
        chunks.push(value);
        break;
      }
      case 5:
        chunks.push(Buffer.from(`${field.value}\0`, 'utf16le'));
        break;
      case 7: {
        const value = Buffer.allocUnsafe(8);
        value.writeBigUInt64LE(field.value);
        chunks.push(value);
        break;
      }
      case 10: {
        const value = Buffer.allocUnsafe(8);
        value.writeBigInt64LE(field.value);
        chunks.push(value);
        break;
      }
    }
  }
  chunks.push(Buffer.from([8]));
  return Buffer.concat(chunks);
};

export function serializeBinaryVdf(object: BinaryVdfObject): Buffer {
  return serializeBinaryObject(object);
}

const stringField = (fields: BinaryVdfObject, key: string): string => {
  const field = fields.get(key);
  return field?.type === 1 ? field.value : '';
};

const numberField = (fields: BinaryVdfObject, key: string): number => {
  const field = fields.get(key);
  return field?.type === 2 ? field.value >>> 0 : 0;
};

export function readShortcuts(buffer: Buffer): {
  root: BinaryVdfObject;
  shortcuts: SteamShortcut[];
} {
  const root =
    buffer.length === 0
      ? new Map<string, BinaryVdfValue>()
      : parseBinaryVdf(buffer);
  let container = root.get('shortcuts');
  if (!container) {
    container = { type: 0, value: new Map() };
    root.set('shortcuts', container);
  }
  if (container.type !== 0) throw new Error('Invalid shortcuts.vdf root');
  const shortcuts: SteamShortcut[] = [];
  for (const [index, value] of container.value) {
    if (value.type !== 0) continue;
    shortcuts.push({
      index,
      fields: value.value,
      appId: numberField(value.value, 'appid'),
      appName: stringField(value.value, 'AppName'),
      executable: stringField(value.value, 'Exe'),
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
  appName: string
): number {
  return (crc32(`${quoteSteamPath(executable)}${appName}`) | 0x80000000) >>> 0;
}

export function getNonSteamLaunchId(appId: number): string {
  return ((BigInt(appId >>> 0) << 32n) | 0x02000000n).toString();
}

export function getSteamCompatDataPath(root: string, appId?: number): string {
  const compatData = path.join(root, 'steamapps', 'compatdata');
  return appId === undefined
    ? compatData
    : path.join(compatData, String(appId));
}

export function findShortcut(
  shortcuts: readonly SteamShortcut[],
  names: readonly string[],
  executable?: string
): SteamShortcut | undefined {
  const expectedNames = new Set(names.filter(Boolean));
  const quotedExecutable = executable ? quoteSteamPath(executable) : undefined;
  return shortcuts.find(
    (shortcut) =>
      expectedNames.has(shortcut.appName) &&
      (!quotedExecutable || shortcut.executable === quotedExecutable)
  );
}

export interface UpsertShortcutOptions {
  appName: string;
  executable: string;
  startDir: string;
  launchOptions?: string;
  icon?: string;
  tags?: string[];
  previousNames?: string[];
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

  const current = readShortcuts(serializeBinaryVdf(root)).shortcuts;
  const existing = findShortcut(current, [
    options.appName,
    ...(options.previousNames ?? []),
  ]);
  const storedExecutable = quoteSteamPath(options.executable);
  const appId = generateNonSteamAppId(options.executable, options.appName);
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

export function removeShortcut(
  root: BinaryVdfObject,
  predicate: (shortcut: SteamShortcut) => boolean
): boolean {
  const container = root.get('shortcuts');
  if (container?.type !== 0) return false;
  const shortcuts = readShortcuts(serializeBinaryVdf(root)).shortcuts;
  const target = shortcuts.find(predicate);
  return target ? container.value.delete(target.index) : false;
}

export type TextVdfObject = Map<string, string | TextVdfObject>;

const tokenizeTextVdf = (source: string): string[] => {
  const tokens: string[] = [];
  const expression =
    /\s*(?:\/\/[^\r\n]*|([{}])|"((?:\\.|[^"\\])*)"|([^\s{}"]+))/gy;
  let offset = 0;
  while (offset < source.length) {
    expression.lastIndex = offset;
    const match = expression.exec(source);
    if (!match) {
      if (/\s/.test(source[offset])) {
        offset++;
        continue;
      }
      throw new Error(`Invalid text VDF at offset ${offset}`);
    }
    offset = expression.lastIndex;
    if (match[1]) tokens.push(match[1]);
    else if (match[2] !== undefined)
      tokens.push(match[2].replace(/\\([\\"])/g, '$1'));
    else if (match[3]) tokens.push(match[3]);
  }
  return tokens;
};

export function parseTextVdf(source: string): TextVdfObject {
  const tokens = tokenizeTextVdf(source);
  let offset = 0;
  const parseObject = (nested: boolean): TextVdfObject => {
    const object: TextVdfObject = new Map();
    while (offset < tokens.length) {
      if (tokens[offset] === '}') {
        if (!nested) throw new Error('Unexpected VDF object terminator');
        offset++;
        return object;
      }
      const key = tokens[offset++];
      const value = tokens[offset++];
      if (value === '{') object.set(key, parseObject(true));
      else if (value === undefined || value === '}')
        throw new Error(`Missing VDF value for ${key}`);
      else object.set(key, value);
    }
    if (nested) throw new Error('Missing VDF object terminator');
    return object;
  };
  return parseObject(false);
}

const escapeTextVdf = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

export function serializeTextVdf(object: TextVdfObject, depth = 0): string {
  const indentation = '\t'.repeat(depth);
  const lines: string[] = [];
  for (const [key, value] of object) {
    lines.push(`${indentation}"${escapeTextVdf(key)}"`);
    if (value instanceof Map) {
      lines.push(`${indentation}{`);
      lines.push(serializeTextVdf(value, depth + 1).trimEnd());
      lines.push(`${indentation}}`);
    } else {
      lines[lines.length - 1] += `\t\t"${escapeTextVdf(value)}"`;
    }
  }
  return `${lines.join('\n')}\n`;
}

const ensureTextObject = (
  object: TextVdfObject,
  key: string
): TextVdfObject => {
  const existing = getTextObject(object, key);
  if (existing) return existing;
  const created: TextVdfObject = new Map();
  object.set(key, created);
  return created;
};

/** Configure Steam's compatibility mapping without invoking an external tool. */
export function setCompatibilityTool(
  configPath: string,
  appId: number,
  toolName: string | null,
  steamRunning = isSteamRunning()
): void {
  assertSteamClosed(steamRunning);
  const root = fs.existsSync(configPath)
    ? parseTextVdf(fs.readFileSync(configPath, 'utf8'))
    : new Map<string, string | TextVdfObject>();
  const mappings = ensureTextObject(
    ensureTextObject(
      ensureTextObject(
        ensureTextObject(
          ensureTextObject(root, 'InstallConfigStore'),
          'Software'
        ),
        'Valve'
      ),
      'Steam'
    ),
    'CompatToolMapping'
  );
  const key = String(appId >>> 0);
  if (toolName) {
    mappings.set(
      key,
      new Map<string, string | TextVdfObject>([
        ['name', toolName],
        ['config', ''],
        ['priority', '250'],
      ])
    );
  } else {
    mappings.delete(key);
  }
  writeFileAtomic(configPath, serializeTextVdf(root));
}

const getTextObject = (
  object: TextVdfObject,
  key: string
): TextVdfObject | undefined => {
  const direct = object.get(key);
  if (direct instanceof Map) return direct;
  const lowerKey = key.toLowerCase();
  for (const [candidate, value] of object) {
    if (candidate.toLowerCase() === lowerKey && value instanceof Map)
      return value;
  }
  return undefined;
};

const textValue = (object: TextVdfObject, key: string): string | undefined => {
  const lowerKey = key.toLowerCase();
  for (const [candidate, value] of object) {
    if (candidate.toLowerCase() === lowerKey && typeof value === 'string')
      return value;
  }
  return undefined;
};

export function parseLoginUsers(
  source: string
): Omit<SteamUser, 'userdataPath' | 'shortcutsPath'>[] {
  const root = parseTextVdf(source);
  const users = getTextObject(root, 'users') ?? root;
  const result: Omit<SteamUser, 'userdataPath' | 'shortcutsPath'>[] = [];
  for (const [steamId, value] of users) {
    if (!(value instanceof Map) || !/^\d+$/.test(steamId)) continue;
    result.push({
      steamId,
      accountId: (BigInt(steamId) & 0xffffffffn).toString(),
      accountName: textValue(value, 'AccountName'),
      personaName: textValue(value, 'PersonaName'),
      mostRecent: textValue(value, 'MostRecent') === '1',
      timestamp: Number.parseInt(textValue(value, 'Timestamp') ?? '0', 10) || 0,
    });
  }
  return result;
}

export function getSteamRootCandidates(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const candidates =
    platform === 'win32'
      ? [
          process.env.STEAM_PATH,
          process.env.PROGRAMFILES_X86
            ? path.join(process.env.PROGRAMFILES_X86, 'Steam')
            : undefined,
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, 'Steam')
            : undefined,
        ]
      : platform === 'darwin'
        ? [path.join(home, 'Library/Application Support/Steam')]
        : [
            process.env.STEAM_PATH,
            path.join(home, '.steam/steam'),
            path.join(home, '.local/share/Steam'),
            path.join(
              home,
              '.var/app/com.valvesoftware.Steam/.local/share/Steam'
            ),
            path.join(home, 'snap/steam/common/.local/share/Steam'),
          ];
  return [
    ...new Set(
      candidates.filter((candidate): candidate is string => Boolean(candidate))
    ),
  ];
}

export function selectSteamUser(root: string): SteamUser | undefined {
  const userdataRoot = path.join(root, 'userdata');
  if (!fs.existsSync(userdataRoot)) return undefined;
  const accountIds = fs
    .readdirSync(userdataRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name !== '0' && /^\d+$/.test(entry.name)
    )
    .map((entry) => entry.name);
  if (accountIds.length === 0) return undefined;

  const loginUsersPath = path.join(root, 'config/loginusers.vdf');
  let loginUsers: Omit<SteamUser, 'userdataPath' | 'shortcutsPath'>[] = [];
  if (fs.existsSync(loginUsersPath)) {
    try {
      loginUsers = parseLoginUsers(fs.readFileSync(loginUsersPath, 'utf8'));
    } catch (error) {
      console.warn(`[steam] Could not parse ${loginUsersPath}:`, error);
    }
  }
  const candidates = loginUsers
    .filter((user) => accountIds.includes(user.accountId))
    .sort(
      (left, right) =>
        Number(right.mostRecent) - Number(left.mostRecent) ||
        right.timestamp - left.timestamp ||
        right.accountId.localeCompare(left.accountId, undefined, {
          numeric: true,
        })
    );
  const selected = candidates[0] ?? {
    accountId: accountIds.sort((left, right) => {
      const leftTime = fs.statSync(path.join(userdataRoot, left)).mtimeMs;
      const rightTime = fs.statSync(path.join(userdataRoot, right)).mtimeMs;
      return (
        rightTime - leftTime ||
        right.localeCompare(left, undefined, { numeric: true })
      );
    })[0],
    mostRecent: false,
    timestamp: 0,
  };
  const userdataPath = path.join(userdataRoot, selected.accountId);
  return {
    ...selected,
    userdataPath,
    shortcutsPath: path.join(userdataPath, 'config/shortcuts.vdf'),
  };
}

export function locateSteam(
  candidates = getSteamRootCandidates()
): SteamLocation | undefined {
  return candidates
    .map((root, index) => {
      const user = selectSteamUser(root);
      return user
        ? {
            root,
            user,
            loginUsersPath: path.join(root, 'config/loginusers.vdf'),
            index,
          }
        : undefined;
    })
    .filter(
      (location): location is SteamLocation & { index: number } =>
        location !== undefined
    )
    .sort(
      (left, right) =>
        Number(right.user.mostRecent) - Number(left.user.mostRecent) ||
        right.user.timestamp - left.user.timestamp ||
        left.index - right.index
    )[0];
}

export function isSteamRunning(
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'linux') {
    try {
      return fs.readdirSync('/proc').some((entry) => {
        if (!/^\d+$/.test(entry)) return false;
        try {
          const command = fs
            .readFileSync(`/proc/${entry}/comm`, 'utf8')
            .trim()
            .toLowerCase();
          return command === 'steam' || command === 'steam.sh';
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
  return false;
}

export function assertSteamClosed(running = isSteamRunning()): void {
  if (running) {
    throw new Error(
      'Close Steam before changing shortcuts so Steam does not overwrite shortcuts.vdf'
    );
  }
}

export function writeFileAtomic(
  filePath: string,
  contents: Buffer | string
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ogi-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export function updateShortcutsFile(
  filePath: string,
  update: (root: BinaryVdfObject) => void,
  steamRunning = isSteamRunning()
): void {
  assertSteamClosed(steamRunning);
  const contents = fs.existsSync(filePath)
    ? fs.readFileSync(filePath)
    : Buffer.alloc(0);
  const { root } = readShortcuts(contents);
  update(root);
  writeFileAtomic(filePath, serializeBinaryVdf(root));
}
