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

export interface SteamLoginUser {
  accountId: string;
  steamId?: string;
  accountName?: string;
  personaName?: string;
  mostRecent: boolean;
  timestamp: number;
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

type TextVdfSpanToken = {
  kind: 'brace' | 'value';
  value: string;
  start: number;
  end: number;
};

type TextVdfSpanEntry = {
  key: string;
  start: number;
  end: number;
  object?: TextVdfSpanObject;
};

type TextVdfSpanObject = {
  entries: TextVdfSpanEntry[];
  closeStart?: number;
};

const tokenizeTextVdfSpans = (source: string): TextVdfSpanToken[] => {
  const tokens: TextVdfSpanToken[] = [];
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
    const tokenStart =
      match.index +
      match[0].length -
      (match[1] ?? match[2] ?? match[3] ?? '').length;
    if (match[1]) {
      tokens.push({
        kind: 'brace',
        value: match[1],
        start: tokenStart,
        end: expression.lastIndex,
      });
    } else if (match[2] !== undefined) {
      tokens.push({
        kind: 'value',
        value: match[2].replace(/\\([\\"])/g, '$1'),
        start: tokenStart - 2,
        end: expression.lastIndex,
      });
    } else if (match[3]) {
      tokens.push({
        kind: 'value',
        value: match[3],
        start: tokenStart,
        end: expression.lastIndex,
      });
    }
  }
  return tokens;
};

const parseTextVdfSpans = (source: string): TextVdfSpanObject => {
  const tokens = tokenizeTextVdfSpans(source);
  let offset = 0;
  const parseObject = (nested: boolean): TextVdfSpanObject => {
    const entries: TextVdfSpanEntry[] = [];
    while (offset < tokens.length) {
      const token = tokens[offset];
      if (token.kind === 'brace' && token.value === '}') {
        if (!nested) throw new Error('Unexpected VDF object terminator');
        offset++;
        return { entries, closeStart: token.start };
      }
      if (token.kind !== 'value') {
        throw new Error(`Invalid VDF key at offset ${token.start}`);
      }
      const key = token;
      const value = tokens[++offset];
      if (!value) throw new Error(`Missing VDF value for ${key.value}`);
      offset++;
      if (value.kind === 'brace' && value.value === '{') {
        const object = parseObject(true);
        const close = tokens[offset - 1];
        entries.push({
          key: key.value,
          start: key.start,
          end: close.end,
          object,
        });
      } else if (value.kind === 'value') {
        entries.push({
          key: key.value,
          start: key.start,
          end: value.end,
        });
      } else {
        throw new Error(`Missing VDF value for ${key.value}`);
      }
    }
    if (nested) throw new Error('Missing VDF object terminator');
    return { entries };
  };
  return parseObject(false);
};

const findSpanEntry = (
  object: TextVdfSpanObject,
  key: string
): TextVdfSpanEntry | undefined => {
  const lowerKey = key.toLowerCase();
  return object.entries.find((entry) => entry.key.toLowerCase() === lowerKey);
};

const lineStart = (source: string, offset: number): number => {
  const newline = source.lastIndexOf('\n', offset - 1);
  return newline < 0 ? 0 : newline + 1;
};

const indentationAt = (source: string, offset: number): string => {
  const start = lineStart(source, offset);
  const indentation = source.slice(start, offset);
  return /^[\t ]*$/.test(indentation) ? indentation : '';
};

const detectIndentUnit = (
  source: string,
  object: TextVdfSpanObject,
  parentIndent: string
): string => {
  const child = object.entries[0];
  if (!child) return '\t';
  const childIndent = indentationAt(source, child.start);
  return childIndent.startsWith(parentIndent)
    ? childIndent.slice(parentIndent.length) || '\t'
    : '\t';
};

const quoteTextVdf = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const formatCompatMapping = (
  appId: number,
  tool: string,
  baseIndent: string,
  indentUnit: string,
  newline: string
): string =>
  [
    quoteTextVdf(String(appId >>> 0)),
    `${baseIndent}{`,
    `${baseIndent}${indentUnit}"name"${indentUnit}${quoteTextVdf(tool)}`,
    `${baseIndent}${indentUnit}"config"${indentUnit}""`,
    `${baseIndent}${indentUnit}"priority"${indentUnit}"250"`,
    `${baseIndent}}`,
  ].join(newline);

const formatNestedObject = (
  keys: readonly string[],
  leaf: string,
  baseIndent: string,
  indentUnit: string,
  newline: string
): string => {
  if (keys.length === 0) return leaf;
  const [key, ...rest] = keys;
  const childIndent = `${baseIndent}${indentUnit}`;
  const nested = formatNestedObject(
    rest,
    leaf,
    childIndent,
    indentUnit,
    newline
  );
  return [
    quoteTextVdf(key),
    `${baseIndent}{`,
    `${childIndent}${nested}`,
    `${baseIndent}}`,
  ].join(newline);
};

const insertionAtObjectEnd = (
  source: string,
  object: TextVdfSpanObject,
  block: string,
  indent: string,
  newline: string
): string => {
  const offset =
    object.closeStart === undefined
      ? source.length
      : lineStart(source, object.closeStart);
  const prefix = source.slice(0, offset);
  const separator = prefix.length > 0 && !prefix.endsWith('\n') ? newline : '';
  return `${prefix}${separator}${indent}${block}${newline}${source.slice(offset)}`;
};

const removeEntry = (source: string, entry: TextVdfSpanEntry): string => {
  const start = lineStart(source, entry.start);
  const before = source.slice(start, entry.start);
  let end = entry.end;
  while (end < source.length && /[\t ]/.test(source[end])) end++;
  if (
    /^[\t ]*$/.test(before) &&
    (source[end] === '\r' || source[end] === '\n')
  ) {
    if (source[end] === '\r') end++;
    if (source[end] === '\n') end++;
    return source.slice(0, start) + source.slice(end);
  }
  return source.slice(0, entry.start) + source.slice(entry.end);
};

export function updateSteamCompatToolMapping(
  source: string,
  appId: number,
  tool: string | null
): string {
  parseTextVdf(source);
  const root = parseTextVdfSpans(source);
  const path = [
    'InstallConfigStore',
    'Software',
    'Valve',
    'Steam',
    'CompatToolMapping',
  ];
  let object = root;
  let foundDepth = 0;
  for (const key of path) {
    const entry = findSpanEntry(object, key);
    if (!entry) break;
    if (!entry.object)
      throw new Error(`Steam VDF path ${key} is not an object`);
    object = entry.object;
    foundDepth++;
  }

  const existing =
    foundDepth === path.length
      ? findSpanEntry(object, String(appId >>> 0))
      : undefined;
  let updated = source;
  if (tool === null) {
    if (existing) updated = removeEntry(source, existing);
  } else {
    const trimmed = tool.trim();
    if (!trimmed) throw new Error('Steam compatibility tool cannot be blank');
    if (existing) {
      const baseIndent = indentationAt(source, existing.start);
      const indentUnit = detectIndentUnit(
        source,
        existing.object ?? object,
        baseIndent
      );
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const replacement = formatCompatMapping(
        appId,
        trimmed,
        baseIndent,
        indentUnit,
        newline
      );
      updated =
        source.slice(0, existing.start) +
        replacement +
        source.slice(existing.end);
    } else {
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const parentIndent =
        object.closeStart === undefined
          ? ''
          : indentationAt(source, object.closeStart);
      const indentUnit = detectIndentUnit(source, object, parentIndent);
      const childIndent = `${parentIndent}${indentUnit}`;
      const mapping = formatCompatMapping(
        appId,
        trimmed,
        childIndent,
        indentUnit,
        newline
      );
      const block = formatNestedObject(
        path.slice(foundDepth),
        mapping,
        childIndent,
        indentUnit,
        newline
      );
      updated = insertionAtObjectEnd(
        source,
        object,
        block,
        childIndent,
        newline
      );
    }
  }
  parseTextVdf(updated);
  return updated;
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

export function parseLoginUsers(source: string): SteamLoginUser[] {
  const root = parseTextVdf(source);
  const users = getTextObject(root, 'users') ?? root;
  const result: SteamLoginUser[] = [];
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
