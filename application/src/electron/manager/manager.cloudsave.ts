/**
 * Cloud save config and path resolution.
 * Config: config/option/cloudsave.json
 * Last sync: internals/cloudsave-last.json
 */
import * as fs from 'fs';
import { join, normalize, sep } from 'path';
import { __dirname } from './manager.paths.js';
import { loadLibraryInfo } from '../handlers/helpers.app/library.js';
import { ensureInternalsDir } from '../handlers/helpers.app/library.js';

const CONFIG_PATH = join(__dirname, 'config/option/cloudsave.json');
const LAST_SYNC_PATH = join(__dirname, 'internals/cloudsave-last.json');

export interface CloudSavePathEntry {
  name: string;
  path: string;
}

export interface PerGameCloudSaveConfig {
  enabled: boolean;
  paths: CloudSavePathEntry[];
}

export interface CloudSaveConfig {
  enabled: boolean;
  perGame: Record<string, PerGameCloudSaveConfig>;
}

const DEFAULT_CONFIG: CloudSaveConfig = {
  enabled: false,
  perGame: {},
};

function ensureConfigDir(): void {
  const dir = join(__dirname, 'config/option');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getCloudSaveConfig(): CloudSaveConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      enabled: Boolean(raw.enabled),
      perGame: typeof raw.perGame === 'object' && raw.perGame !== null ? raw.perGame : {},
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setCloudSaveConfig(config: CloudSaveConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Resolve paths for an app. Relative paths are resolved against library cwd.
 * Returns only paths that are under allowed roots (cwd or existing absolute) to avoid escaping.
 */
export function getPathsForApp(appID: number): string[] {
  const config = getCloudSaveConfig();
  const appKey = String(appID);
  const perGame = config.perGame[appKey];
  if (!perGame?.enabled || !perGame.paths?.length) {
    return [];
  }

  const lib = loadLibraryInfo(appID);
  if (!lib?.cwd) {
    return [];
  }

  const cwd = lib.cwd;
  const resolved: string[] = [];

  for (const entry of perGame.paths) {
    const p = entry.path.trim();
    if (!p) continue;
    const absolute = p.startsWith('/') || (p.length >= 2 && p[1] === ':')
      ? p
      : join(cwd, p);
    const normalized = join(absolute); // removes ..
    if (!isPathUnderAllowedRoot(normalized, cwd)) {
      continue;
    }
    if (fs.existsSync(normalized)) {
      resolved.push(normalized);
    }
  }

  return resolved;
}

function isPathUnderAllowedRoot(candidate: string, cwd: string): boolean {
  const cwdNorm = normalize(join(cwd)).replace(/\/$|\\$/, '') || cwd;
  const candNorm = normalize(join(candidate)).replace(/\/$|\\$/, '') || candidate;
  if (candNorm === cwdNorm) return true;
  const prefix = cwdNorm + sep;
  return candNorm.startsWith(prefix);
}

export interface LastSyncInfo {
  up?: number;
  down?: number;
}

let lastSyncCache: Record<string, LastSyncInfo> | null = null;

function loadLastSync(): Record<string, LastSyncInfo> {
  if (lastSyncCache !== null) return lastSyncCache;
  ensureInternalsDir();
  if (!fs.existsSync(LAST_SYNC_PATH)) {
    lastSyncCache = {};
    return lastSyncCache;
  }
  try {
    lastSyncCache = JSON.parse(fs.readFileSync(LAST_SYNC_PATH, 'utf-8'));
    return lastSyncCache!;
  } catch {
    lastSyncCache = {};
    return lastSyncCache;
  }
}

function saveLastSync(data: Record<string, LastSyncInfo>): void {
  ensureInternalsDir();
  fs.writeFileSync(LAST_SYNC_PATH, JSON.stringify(data, null, 2));
  lastSyncCache = data;
}

export function getLastSyncTime(appID: number): LastSyncInfo | null {
  const data = loadLastSync();
  const key = String(appID);
  return data[key] ?? null;
}

export function setLastSyncTime(
  appID: number,
  direction: 'up' | 'down',
  time: number
): void {
  const data = loadLastSync();
  const key = String(appID);
  if (!data[key]) data[key] = {};
  if (direction === 'up') data[key].up = time;
  else data[key].down = time;
  saveLastSync(data);
}

export function isCloudSaveEnabledForApp(appID: number): boolean {
  const config = getCloudSaveConfig();
  if (!config.enabled) return false;
  const perGame = config.perGame[String(appID)];
  return Boolean(perGame?.enabled && perGame.paths?.length);
}
