export const ACCESSIBILITY_STATES = ['welcome', 'oobe-resume', 'main'] as const;

export type AccessibilityState = (typeof ACCESSIBILITY_STATES)[number];

export function oobeIncludesSteamGridDb(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32';
}

export function clientOptionsIncludesSteamGridDb(
  platform: NodeJS.Platform = process.platform
): boolean {
  // Client Options mirrors the production General setting condition.
  return platform === 'linux';
}

export function getAccessibilityState(
  value = process.env.OGI_ACCESSIBILITY_STATE
): AccessibilityState {
  const state = value ?? 'welcome';
  if (!ACCESSIBILITY_STATES.includes(state as AccessibilityState)) {
    throw new Error(`Unknown accessibility state: ${state}`);
  }
  return state as AccessibilityState;
}
