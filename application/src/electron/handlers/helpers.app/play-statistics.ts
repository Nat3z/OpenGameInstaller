/**
 * Play statistics: load/save internals/play-statistics.json,
 * record session start/end, reconcile stale sessions on load.
 */
import { join } from 'path';
import * as fs from 'fs';
import { __dirname } from '../../manager/manager.paths.js';
import { ensureInternalsDir } from './library.js';

const STATS_FILENAME = 'play-statistics.json';
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

export interface PlayStatisticsEntry {
  totalPlaytimeMs: number;
  launchCount: number;
  lastPlayedAt: number;
}

export interface PlayStatistics {
  byAppId: Record<string, PlayStatisticsEntry>;
  activeSession: {
    appID: number;
    startTime: number;
  } | null;
}

const defaultStatistics = (): PlayStatistics => ({
  byAppId: {},
  activeSession: null,
});

export function getPlayStatisticsPath(): string {
  return join(__dirname, 'internals', STATS_FILENAME);
}

export function loadPlayStatistics(): PlayStatistics {
  ensureInternalsDir();
  const path = getPlayStatisticsPath();
  if (!fs.existsSync(path)) {
    return defaultStatistics();
  }
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as PlayStatistics;
    if (!data || typeof data !== 'object') {
      return defaultStatistics();
    }
    const byAppId =
      data.byAppId && typeof data.byAppId === 'object' ? data.byAppId : {};
    const activeSession =
      data.activeSession &&
      typeof data.activeSession === 'object' &&
      typeof data.activeSession.appID === 'number' &&
      typeof data.activeSession.startTime === 'number'
        ? data.activeSession
        : null;

    const stats: PlayStatistics = { byAppId, activeSession };

    // Reconcile stale activeSession on load (e.g. app quit while game was running)
    if (stats.activeSession) {
      closeStaleSession(stats);
      savePlayStatistics(stats);
    }

    return stats;
  } catch {
    return defaultStatistics();
  }
}

export function savePlayStatistics(stats: PlayStatistics): void {
  ensureInternalsDir();
  const path = getPlayStatisticsPath();
  fs.writeFileSync(path, JSON.stringify(stats, null, 2), 'utf-8');
}

function closeStaleSession(stats: PlayStatistics): void {
  if (!stats.activeSession) return;
  const { appID, startTime } = stats.activeSession;
  const now = Date.now();
  const durationMs = Math.min(
    Math.max(0, now - startTime),
    MAX_SESSION_MS
  );
  const key = String(appID);
  if (!stats.byAppId[key]) {
    stats.byAppId[key] = {
      totalPlaytimeMs: 0,
      launchCount: 0,
      lastPlayedAt: 0,
    };
  }
  stats.byAppId[key].totalPlaytimeMs += durationMs;
  stats.byAppId[key].launchCount += 1;
  stats.byAppId[key].lastPlayedAt = now;
  stats.activeSession = null;
}

export function recordSessionStart(appID: number): void {
  const stats = loadPlayStatistics();
  if (stats.activeSession) {
    closeStaleSession(stats);
  }
  stats.activeSession = { appID, startTime: Date.now() };
  savePlayStatistics(stats);
}

export function recordSessionEnd(appID: number): void {
  const stats = loadPlayStatistics();
  if (!stats.activeSession || stats.activeSession.appID !== appID) {
    stats.activeSession = null;
    savePlayStatistics(stats);
    return;
  }
  const { startTime } = stats.activeSession;
  const now = Date.now();
  const durationMs = Math.min(
    Math.max(0, now - startTime),
    MAX_SESSION_MS
  );
  const key = String(appID);
  if (!stats.byAppId[key]) {
    stats.byAppId[key] = {
      totalPlaytimeMs: 0,
      launchCount: 0,
      lastPlayedAt: 0,
    };
  }
  stats.byAppId[key].totalPlaytimeMs += durationMs;
  stats.byAppId[key].launchCount += 1;
  stats.byAppId[key].lastPlayedAt = now;
  stats.activeSession = null;
  savePlayStatistics(stats);
}

export function removeAppFromPlayStatistics(appID: number): void {
  const stats = loadPlayStatistics();
  const key = String(appID);
  if (key in stats.byAppId) {
    delete stats.byAppId[key];
  }
  if (stats.activeSession?.appID === appID) {
    stats.activeSession = null;
  }
  savePlayStatistics(stats);
}
