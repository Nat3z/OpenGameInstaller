/// <reference types="svelte" />
/// <reference path="../../typings/vite-hmr.d.ts" />

type LibraryInfo = import('@ogi-sdk/connect').LibraryInfo;
type $GamepadNavigator =
  import('@/frontend/managers/GamepadManager').GamepadNavigator;
type ElectronApi = import('@/electron/preload.mjs').ElectronApi;

interface Window {
  electronAPI: ElectronApi;
  gamepadNavigator: $GamepadNavigator;
}
