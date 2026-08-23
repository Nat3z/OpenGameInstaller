import { execFile } from 'node:child_process';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import type { BrowserWindow } from 'electron';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** True inside an embedded gamescope session (Steam Deck Game Mode). */
export function isGamescopeSession(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.XDG_CURRENT_DESKTOP === 'gamescope' ||
    env.GAMESCOPE_WAYLAND_DISPLAY !== undefined
  );
}

/**
 * Resolve the 32-bit appid gamescope associates with this launch session.
 * Steam exports SteamGameId as the 64-bit gameid; for non-Steam shortcuts the
 * shortcut appid lives in its upper 32 bits, so shift it back down.
 */
export function getGamescopeAppId(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  for (const value of [env.SteamGameId, env.SteamAppId]) {
    if (!value || !/^\d+$/.test(value)) continue;
    const gameId = BigInt(value);
    const appId = gameId > 0xffffffffn ? gameId >> 32n : gameId;
    if (appId > 0n && appId <= 0xffffffffn) return Number(appId);
  }
  return null;
}

function xprop(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('xprop', args, (cause) => (cause ? reject(cause) : resolve()));
  });
}

/**
 * Tag the window with STEAM_GAME so embedded gamescope will display it.
 * Steam only sets this property on Xlib clients (via gameoverlayrenderer.so);
 * Chromium talks XCB directly, so without the tag Game Mode leaves the window
 * as an unfocusable black layer. Best-effort: failure is logged, never fatal.
 */
export async function tagWindowForGamescope(
  window: BrowserWindow
): Promise<void> {
  if (!isGamescopeSession()) return;
  const appId = getGamescopeAppId();
  if (appId === null) {
    logger.sync.warn(
      '[gamescope] No SteamGameId/SteamAppId in environment, cannot tag window'
    );
    return;
  }
  const windowId = `0x${window.getNativeWindowHandle().readUInt32LE(0).toString(16)}`;
  try {
    await xprop([
      '-id',
      windowId,
      '-f',
      'STEAM_GAME',
      '32c',
      '-set',
      'STEAM_GAME',
      String(appId),
    ]);
    logger.sync.info(
      `[gamescope] Tagged window ${windowId} with STEAM_GAME=${appId}`
    );
  } catch (cause) {
    logger.sync.error(
      `[gamescope] Failed to tag window ${windowId} with STEAM_GAME=${appId}:`,
      cause
    );
  }
}
