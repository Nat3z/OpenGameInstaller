export const UPDATER_ACCESSIBILITY_STATES = [
  'selection',
  'progress',
  'failure',
  'recovery',
] as const;

export type UpdaterAccessibilityState =
  (typeof UPDATER_ACCESSIBILITY_STATES)[number];

export function getUpdaterAccessibilityState(
  value = process.env.OGI_UPDATER_ACCESSIBILITY_STATE
): UpdaterAccessibilityState {
  const state = value ?? 'selection';
  if (
    !UPDATER_ACCESSIBILITY_STATES.includes(state as UpdaterAccessibilityState)
  ) {
    throw new Error(`Unknown updater accessibility state: ${state}`);
  }
  return state as UpdaterAccessibilityState;
}
