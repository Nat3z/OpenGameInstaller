/** Shared domain shapes used by the addon websocket protocol. */

export interface OGIAddonConfiguration {
  name: string;
  id: string;
  description: string;
  version: string;
  author: string;
  repository: string;
  storefronts: string[];
}

/** User-visible toast-style message from addon to UI. */
export interface AddonNotificationMessage {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  id: string;
}

export type ConfigurationOptionType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'action'
  | 'unset';

interface ConfigurationOptionBase {
  name: string;
  displayName: string;
  description: string;
  type: ConfigurationOptionType;
  defaultValue?: unknown;
}

export interface StringConfigurationOption extends ConfigurationOptionBase {
  type: 'string';
  defaultValue?: string;
  allowedValues?: string[];
  minTextLength?: number;
  maxTextLength?: number;
  inputType?: 'text' | 'file' | 'password' | 'folder';
}

export interface NumberConfigurationOption extends ConfigurationOptionBase {
  type: 'number';
  defaultValue?: number;
  min?: number;
  max?: number;
  inputType?: 'number' | 'range';
}

export interface BooleanConfigurationOption extends ConfigurationOptionBase {
  type: 'boolean';
  defaultValue?: boolean;
}

export interface ActionConfigurationOption extends ConfigurationOptionBase {
  type: 'action';
  buttonText?: string;
  taskName?: string;
  manifest?: Record<string, unknown>;
}

/** Serialized configuration option (wire template and UI config screens). */
export type ConfigurationOptionWire =
  | StringConfigurationOption
  | NumberConfigurationOption
  | BooleanConfigurationOption
  | ActionConfigurationOption
  | ConfigurationOptionBase;

/** Addon configuration template keyed by option name. */
export type ConfigurationFile = Record<string, ConfigurationOptionWire>;

export type BasicLibraryInfo = {
  name: string;
  capsuleImage: string;
  appID: number;
  storefront: string;
};

export interface CatalogSection {
  name: string;
  description: string;
  listings: BasicLibraryInfo[];
}

export interface CatalogCarouselItem {
  name: string;
  description: string;
  carouselImage: string;
  fullBannerImage?: string;
  appID?: number;
  storefront?: string;
  capsuleImage?: string;
}

export interface CatalogWithCarousel {
  sections: Record<string, CatalogSection>;
  carousel?: Record<string, CatalogCarouselItem> | CatalogCarouselItem[];
}

export type CatalogResponse =
  | Record<string, CatalogSection>
  | CatalogWithCarousel;

/**
 * UMU ID format: 'steam:${number}' or 'umu:${string | number}'
 * - steam:${number} → maps to umu-${number} for Steam games
 * - umu:${string | number} → maps to umu-${string | number} for non-Steam games
 */
export type UmuId = `steam:${number}` | `umu:${string | number}`;

export interface LibraryInfo {
  name: string;
  version: string;
  cwd: string;
  launchExecutable: string;
  launchArguments?: string;
  launchEnv?: Record<string, string>;
  appID: number;
  capsuleImage: string;
  storefront: string;
  addonsource: string;
  coverImage: string;
  titleImage?: string;
  umu?: {
    umuId: string;
    dllOverrides?: string[];
    protonVersion?: string;
    store?: string;
    winePrefixPath?: string;
    steamShortcutId?: number;
  };
  redistributables?: {
    name: string;
    path: string;
  }[];
}

export type SetupResponse = Omit<
  LibraryInfo,
  | 'capsuleImage'
  | 'coverImage'
  | 'name'
  | 'appID'
  | 'storefront'
  | 'addonsource'
  | 'titleImage'
> & {
  redistributables?: {
    name: string;
    path: string;
  }[];
  umu?: {
    umuId: string;
    dllOverrides?: string[];
    protonVersion?: string;
    store?: string;
    steamShortcutId?: number;
  };
};

/** @deprecated Use {@link SetupResponse}. */
export type SetupEventResponse = SetupResponse;

type SearchResultBase = {
  name: string;
  manifest?: Record<string, unknown>;
  clearOldFilesBeforeUpdate?: boolean;
};

export type SearchResult = SearchResultBase &
  (
    | {
        downloadType: 'torrent' | 'magnet';
        filename: string;
        downloadURL: string;
      }
    | {
        downloadType: 'direct';
        files: {
          name: string;
          downloadURL: string;
          headers?: Record<string, string>;
        }[];
      }
    | {
        downloadType: 'task';
        taskName: string;
      }
    | {
        downloadType: 'request' | 'empty';
      }
  );

export interface StoreData {
  name: string;
  publishers: string[];
  developers: string[];
  appID: number;
  releaseDate: string;
  capsuleImage: string;
  coverImage: string;
  basicDescription: string;
  description: string;
  headerImage: string;
  latestVersion: string;
}

export type AddonTaskRunEventArgs<LibraryInfoType = LibraryInfo> = {
  manifest?: Record<string, unknown>;
  downloadPath?: string;
  name?: string;
  taskName?: string;
  libraryInfo?: LibraryInfoType;
  deferID?: string;
};
