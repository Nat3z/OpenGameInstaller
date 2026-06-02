/**
 * WebSocket message shapes for the addon runtime and the in-process addon SDK.
 *
 * Add events in one place: `addonProtocol` below. The exported unions/maps are
 * derived from that registry so event names, args, responses, listener support,
 * and proxy packing metadata stay together.
 */
import type { WebsocketMessage } from './types';
import type {
  AddonMessageArgs,
  AddonListenerEventNames,
  ResolveProtocolValue,
  SDKMessageRequestArgs,
  SDKMessageResponseArgs,
  SDKToServerMessageArgs,
  ServerCommandArgs,
  ServerToSDKMessageArgs,
  ServerCommandResponse,
  SlotValues,
} from './protocol-builder';
import {
  addonMessage,
  defineAddonProtocol,
  sdkMessage,
  serverCommand,
} from './protocol-builder';
import type {
  AddonNotificationMessage,
  AddonTaskRunEventArgs,
  BasicLibraryInfo,
  CatalogResponse,
  ConfigurationFile,
  LibraryInfo,
  OGIAddonConfiguration,
  SearchResult,
  SetupResponse,
  StoreData,
} from './protocol-base';

export type {
  AddonMessageSpec,
  AddonProtocolSlots,
  ProtocolSlot,
  ProtocolSlotMerge,
  SDKMessageRequestArgs,
  SDKMessageResponseArgs,
  SDKMessageSpec,
  ServerCommandPack,
  ServerCommandSpec,
} from './protocol-builder';
export {
  addonMessage,
  defineAddonProtocol,
  sdkMessage,
  serverCommand,
} from './protocol-builder';
export type {
  AddonNotificationMessage,
  AddonTaskRunEventArgs,
  BasicLibraryInfo,
  CatalogResponse,
  CatalogCarouselItem,
  CatalogSection,
  CatalogWithCarousel,
  ConfigurationFile,
  ConfigurationOptionType,
  ConfigurationOptionWire,
  StringConfigurationOption,
  NumberConfigurationOption,
  BooleanConfigurationOption,
  ActionConfigurationOption,
  LibraryInfo,
  OGIAddonConfiguration,
  SearchResult,
  SetupEventResponse,
  SetupResponse,
  StoreData,
  UmuId,
} from './protocol-base';

// -----------------------------------------------------------------------------
// Protocol registry
// -----------------------------------------------------------------------------

/**
 * Source of truth for addon websocket protocol relationships.
 *
 * Sections:
 * - `serverToAddon`: desktop/server commands sent to an addon.
 * - `addonToServer`: addon push messages sent back to the server.
 * - `sdkToServer`: in-process SDK bridge envelope events sent to the server.
 * - `serverToSdk`: server replies sent to the in-process SDK bridge.
 */
export const addonProtocol = defineAddonProtocol({
  serverToAddon: {
    authenticate: serverCommand<[config?: unknown], unknown, true>({
      addonListener: true,
    }),
    configure: serverCommand<[config: ConfigurationFile], unknown, true>({
      addonListener: true,
    }),
    'config-update': serverCommand<[config: ConfigurationFile], unknown>(),
    'launch-app': serverCommand<
      [data: { libraryInfo: LibraryInfo; launchType: 'pre' | 'post' }],
      void,
      true
    >({ addonListener: true }),
    search: serverCommand<
      [
        query: {
          storefront: string;
          appID: number;
        } & (
          | { for: 'game' | 'task' | 'all' }
          | { for: 'update'; libraryInfo: LibraryInfo }
        ),
      ],
      SearchResult[],
      true
    >({ addonListener: true }),
    setup: serverCommand<
      [
        data: {
          path: string;
          type: 'direct' | 'torrent' | 'magnet' | 'empty';
          name: string;
          usedRealDebrid: boolean;
          clearOldFilesBeforeUpdate?: boolean;
          multiPartFiles?: { name: string; downloadURL: string }[];
          appID: number;
          storefront: string;
          manifest?: Record<string, unknown>;
        } & (
          | { for: 'game' }
          | { for: 'update'; currentLibraryInfo: LibraryInfo }
        ),
      ],
      SetupResponse,
      true
    >({ addonListener: true }),
    response: serverCommand<
      [id: string, response?: unknown, statusError?: string],
      unknown
    >({
      pack: { type: 'response' },
    }),
    'library-search': serverCommand<[query: string], BasicLibraryInfo[], true>({
      addonListener: true,
    }),
    'check-for-updates': serverCommand<
      [data: { appID: number; storefront: string; currentVersion: string }],
      { available: true; version: string } | { available: false },
      true
    >({ addonListener: true }),
    'task-run': serverCommand<[task: AddonTaskRunEventArgs], void>(),
    'game-details': serverCommand<
      [details: { appID: number; storefront: string }],
      StoreData | undefined,
      true
    >({ addonListener: true }),
    'request-dl': serverCommand<
      [appID: number, info: SearchResult],
      SearchResult,
      true
    >({
      addonListener: true,
      pack: { type: 'object', keys: ['appID', 'info'] },
    }),
    catalog: serverCommand<[], CatalogResponse, true>({
      addonListener: true,
      pack: { type: 'none' },
    }),
  },
  addonToServer: {
    response: addonMessage<unknown>(),
    authenticate: addonMessage<
      OGIAddonConfiguration & {
        secret: string;
        ogiVersion: string;
      }
    >(),
    configure: addonMessage<ConfigurationFile>(),
    'defer-update': addonMessage<{
      logs: string[];
      progress: number;
      deferID: string;
      failed?: string;
    }>(),
    notification: addonMessage<AddonNotificationMessage>(),
    'input-asked': addonMessage<{
      config: ConfigurationFile;
      name: string;
      description: string;
    }>(),
    'task-update': addonMessage<{
      id: string;
      progress: number;
      logs: string[];
      finished: boolean;
      failed?: string;
    }>(),
    'get-app-details': addonMessage<{ appID: number; storefront: string }>(),
    'search-app-name': addonMessage<{ query: string; storefront: string }>(),
    flag: addonMessage<{ flag: string; value: string | string[] }>(),
  },
  sdkToServer: {
    forward: sdkMessage('forward'),
    'defer-forward': sdkMessage<
      'defer-forward',
      {
        addonId: string;
        event: string;
        args: unknown[];
      },
      { taskID: string }
    >('defer-forward'),
    'query-connected-addons': sdkMessage<
      'query-connected-addons',
      { type: 'addons' },
      {
        addons: ({
          id: string;
          name: string;
          eventsAvailable: string[];
          configTemplate?: ConfigurationFile;
          icon?: string;
          iconPath?: string;
        } & Partial<OGIAddonConfiguration>)[];
      }
    >('query-connected-addons'),
    'get-deferred-task': sdkMessage<
      'get-deferred-task',
      { taskID: string },
      {
        task?: {
          id: string;
          addonOwner: string;
          finished: boolean;
          progress: number;
          logs: string[];
          failed?: string;
          data?: unknown;
          resolved: boolean;
        };
      }
    >('get-deferred-task'),
    'get-deferred-tasks': sdkMessage<
      'get-deferred-tasks',
      Record<string, never>,
      {
        tasks: {
          id: string;
          addonOwner: string;
          finished: boolean;
          progress: number;
          logs: string[];
          failed?: string;
        }[];
      }
    >('get-deferred-tasks'),
    'input-response': sdkMessage<
      'input-response',
      Record<string, string | number | boolean>,
      Record<string, string | number | boolean>
    >('input-response'),
  },
  serverToSdk: {
    /** Correlated reply for `query` (and similar); body shape is defined on each request spec, not here. */
    response: sdkMessage<'response', never, unknown>('response'),
    'forward-response': sdkMessage('forward-response'),
    notification: sdkMessage<
      'notification',
      AddonNotificationMessage,
      AddonNotificationMessage
    >('notification'),
    'input-asked': sdkMessage<
      'input-asked',
      never,
      {
        config: ConfigurationFile;
        name: string;
        description: string;
      }
    >('input-asked'),
  },
} as const);

// -----------------------------------------------------------------------------
// Derived protocol types
// -----------------------------------------------------------------------------

type ServerToAddonProtocol = typeof addonProtocol.serverToAddon;
type AddonToServerProtocol = typeof addonProtocol.addonToServer;
/** Registry of SDK→server requests (`addonProtocol.sdkToServer`). */
export type SDKToServerProtocol = typeof addonProtocol.sdkToServer;
/** Registry of server→SDK responses (`addonProtocol.serverToSdk`). */
export type ServerToSDKProtocol = typeof addonProtocol.serverToSdk;

/** Lifecycle and command hooks the addon SDK exposes to addon code (local listeners). */
export type OGIAddonSDKEventListener =
  | 'connect'
  | 'disconnect'
  | 'exit'
  | Extract<AddonListenerEventNames<ServerToAddonProtocol>, string>;

/** Events the addon (or its relay) sends to the server. */
export type AddonClientToServerEventName = keyof AddonToServerProtocol & string;

/** Events the server sends to the addon. Tuple values are positional args for the wire handler. */
export type AddonServerToClientEventName = keyof ServerToAddonProtocol & string;

/** Payload map for each `AddonClientToServerEventName` (object args, not tuples). */
export type AddonClientToServerEventArgs<
  ConfigurationFileType = ConfigurationFile,
  Configuration extends OGIAddonConfiguration = OGIAddonConfiguration,
  Notification = AddonNotificationMessage,
> = {
  [Event in keyof AddonToServerProtocol]: ResolveProtocolValue<
    AddonMessageArgs<AddonToServerProtocol[Event]>,
    SlotValues<ConfigurationFileType, Configuration, Notification>
  >;
};

/**
 * Positional argument tuple for each `AddonServerToClientEventName`.
 * Matches how the server invokes the corresponding addon handler.
 */
export type AddonServerToClientEventArgs<
  ConfigurationFileType = ConfigurationFile,
  LibraryInfoType = LibraryInfo,
  SearchResultType = SearchResult,
  SetupResponseType = SetupResponse,
  BasicLibraryInfoType = BasicLibraryInfo,
  StoreDataType = StoreData,
  CatalogResponseType = CatalogResponse,
> = {
  [Event in keyof ServerToAddonProtocol]: ResolveProtocolValue<
    ServerCommandArgs<ServerToAddonProtocol[Event]>,
    SlotValues<
      ConfigurationFileType,
      OGIAddonConfiguration,
      AddonNotificationMessage,
      LibraryInfoType,
      SearchResultType,
      SetupResponseType,
      BasicLibraryInfoType,
      StoreDataType,
      CatalogResponseType
    >
  >;
};

/**
 * Success payload (or `void`) returned from the addon for each server→client event,
 * after the addon finishes handling that command.
 */
export type AddonServerToClientResponseArgs<
  SearchResultType = SearchResult,
  SetupResponseType = SetupResponse,
  BasicLibraryInfoType = BasicLibraryInfo,
  StoreDataType = StoreData,
  CatalogResponseType = CatalogResponse,
> = {
  [Event in keyof ServerToAddonProtocol]: ResolveProtocolValue<
    ServerCommandResponse<ServerToAddonProtocol[Event]>,
    SlotValues<
      ConfigurationFile,
      OGIAddonConfiguration,
      AddonNotificationMessage,
      LibraryInfo,
      SearchResultType,
      SetupResponseType,
      BasicLibraryInfoType,
      StoreDataType,
      CatalogResponseType
    >
  >;
};

// -----------------------------------------------------------------------------
// Wire envelopes
// -----------------------------------------------------------------------------

/** Full message from addon to server: `event` discriminant + typed `args`. */
export interface AddonClientToServerWebsocketMessage<
  Event extends AddonClientToServerEventName = AddonClientToServerEventName,
> extends WebsocketMessage {
  event: Event;
  args: AddonClientToServerEventArgs[Event];
}

/** Full message from server to addon. `args` is a tuple on the wire; typed loosely here. */
export interface AddonServerToClientWebsocketMessage<
  Event extends AddonServerToClientEventName = AddonServerToClientEventName,
> extends WebsocketMessage {
  event: Event;
  args: unknown;
}

/** Desktop / bridge → server: “run this server→addon command for `addonId`”. */
export type AddonForwardRequest<
  Event extends AddonServerToClientEventName = AddonServerToClientEventName,
  ConfigurationFileType = ConfigurationFile,
  LibraryInfoType = LibraryInfo,
  SearchResultType = SearchResult,
  SetupResponseType = SetupResponse,
  BasicLibraryInfoType = BasicLibraryInfo,
  StoreDataType = StoreData,
  CatalogResponseType = CatalogResponse,
> = {
  addonId: string;
  event: Event;
  args: AddonServerToClientEventArgs<
    ConfigurationFileType,
    LibraryInfoType,
    SearchResultType,
    SetupResponseType,
    BasicLibraryInfoType,
    StoreDataType,
    CatalogResponseType
  >[Event];
};

/** Server → desktop / bridge: result of a forwarded command for `addonId`. */
export type AddonForwardResponse<
  Event extends AddonServerToClientEventName = AddonServerToClientEventName,
  SearchResultType = SearchResult,
  SetupResponseType = SetupResponse,
  BasicLibraryInfoType = BasicLibraryInfo,
  StoreDataType = StoreData,
  CatalogResponseType = CatalogResponse,
> = {
  addonId: string;
  event: Event;
  args: AddonServerToClientResponseArgs<
    SearchResultType,
    SetupResponseType,
    BasicLibraryInfoType,
    StoreDataType,
    CatalogResponseType
  >[Event];
};

// --- In-process addon SDK (same event names as server→addon, wrapped for forwarding) ---

/** SDK → server: `forward` runs a command on an addon; `query` asks the server (no addon round-trip). */
export type AddonClientSDKToServerEvent = keyof SDKToServerProtocol & string;
/** Maps each SDK→server event to its payload shape. */
export type AddonClientSDKToServerEventArgs<
  Event extends AddonServerToClientEventName = AddonServerToClientEventName,
> = {
  [MessageEvent in keyof SDKToServerProtocol]: SDKToServerMessageArgs<
    SDKToServerProtocol[MessageEvent],
    AddonForwardRequest<Event>
  >;
};

/** Wire message from in-process addon SDK to the connection server. */
export interface AddonClientSDKToServerWebsocketMessage<
  MessageEvent extends AddonClientSDKToServerEvent =
    AddonClientSDKToServerEvent,
  ForwardedEvent extends AddonServerToClientEventName =
    AddonServerToClientEventName,
> extends WebsocketMessage {
  event: MessageEvent;
  args: AddonClientSDKToServerEventArgs<ForwardedEvent>[MessageEvent];
}

/**
 * SDK→server messages as a discriminated union so `EventResponseSocket`
 * listeners narrow correctly. Derived from `addonProtocol.sdkToServer`; new
 * registry rows automatically join the union.
 */
export type AddonClientSDKToServerIncomingMessage = {
  [Name in AddonClientSDKToServerEvent]: AddonClientSDKToServerWebsocketMessage<
    Name,
    AddonServerToClientEventName
  >;
}[AddonClientSDKToServerEvent];

/** Server → SDK: `forward-response` for forwards; `response` for correlated replies (e.g. `query`). */
export type AddonServerToClientSDKEvent = keyof ServerToSDKProtocol & string;
/** Maps SDK response events to their payload shapes. */
export type AddonServerToClientSDKEventArgs<
  Event extends AddonServerToClientEventName = AddonServerToClientEventName,
> = {
  [MessageEvent in keyof ServerToSDKProtocol]: ServerToSDKMessageArgs<
    ServerToSDKProtocol[MessageEvent],
    AddonForwardResponse<Event>
  >;
};

/** Wire message from server back to the in-process addon SDK after `forward` or `query`. */
export interface AddonServerToClientSDKWebsocketMessage<
  MessageEvent extends AddonServerToClientSDKEvent =
    AddonServerToClientSDKEvent,
  ForwardedEvent extends AddonServerToClientEventName =
    AddonServerToClientEventName,
> extends WebsocketMessage {
  event: MessageEvent;
  args: AddonServerToClientSDKEventArgs<ForwardedEvent>[MessageEvent];
}

/**
 * Server→SDK messages as a discriminated union for the same narrowing reason as
 * {@link AddonClientSDKToServerIncomingMessage}. Derived from
 * `addonProtocol.serverToSdk`.
 */
export type AddonServerToClientSDKIncomingMessage = {
  [Name in AddonServerToClientSDKEvent]: AddonServerToClientSDKWebsocketMessage<
    Name,
    AddonServerToClientEventName
  >;
}[AddonServerToClientSDKEvent];

// -----------------------------------------------------------------------------
// Per-entry SDK helpers — index any `addonProtocol.sdkToServer` row by name to
// get its request body, response body, and full request/response messages.
//
// Adding a new request is just a new row in the registry — these helpers light
// up automatically. Use them like `SDKResponse<'query'>`.
// -----------------------------------------------------------------------------

/** All `sdkToServer` registry keys (e.g. `'forward'`, `'query'`). */
export type SDKRequestName = keyof SDKToServerProtocol & string;

/** Request body sent in `args` for `addonProtocol.sdkToServer[Name]`. */
export type SDKRequest<Name extends SDKRequestName> =
  AddonClientSDKToServerEventArgs[Name];

/** Typed response body returned by the server for `addonProtocol.sdkToServer[Name]`. */
export type SDKResponse<Name extends SDKRequestName> = SDKMessageResponseArgs<
  SDKToServerProtocol[Name]
>;

/** Full SDK→server wire message with `args` narrowed for `Name`. */
export type SDKRequestMessage<Name extends SDKRequestName> = Omit<
  AddonClientSDKToServerWebsocketMessage<Name>,
  'args'
> & {
  args: SDKRequest<Name>;
};

/**
 * Full server→SDK wire message for a correlated reply to `Name`.
 *
 * `forward` resolves to the `'forward-response'` envelope; everything else
 * resolves to the generic `'response'` envelope with `args` narrowed to
 * `SDKResponse<Name>`.
 */
export type SDKResponseMessage<Name extends SDKRequestName> =
  Name extends 'forward'
    ? AddonServerToClientSDKWebsocketMessage<'forward-response'>
    : Omit<AddonServerToClientSDKWebsocketMessage<'response'>, 'args'> & {
        args: SDKResponse<Name>;
      };

/** Metadata returned for each connected addon from `query-connected-addons`. */
export type ConnectedAddonInfo =
  SDKResponse<'query-connected-addons'>['addons'][number];

/** Converts kebab-case event names to camelCase for JS-side listener APIs. */
export type CamelCaseEvent<Event extends string> =
  Event extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<CamelCaseEvent<Tail>>}`
    : Event;

// -----------------------------------------------------------------------------
// Derived listener signatures (addon SDK + addon-server host)
// -----------------------------------------------------------------------------

/** Maps a server→addon command tuple to an addon-side listener callback. */
type ServerCommandListener<
  Event extends AddonServerToClientEventName,
  EventResponse,
> = AddonServerToClientEventArgs[Event] extends readonly []
  ? (event: EventResponse) => void
  : AddonServerToClientEventArgs[Event] extends readonly [infer Arg]
    ? (arg: Arg, event: EventResponse) => void
    : AddonServerToClientEventArgs[Event] extends readonly [infer A, infer B]
      ? (a: A, b: B, event: EventResponse) => void
      : never;

/**
 * Listener signatures for `addonProtocol.serverToAddon` rows with `addonListener: true`.
 * Pass your addon `EventResponse` class as the type parameter (`ogi-addon` does this).
 */
export type AddonProtocolEventListenerTypes<
  EventResponse,
  Excluded extends AddonServerToClientEventName = never,
> = {
  [Event in Exclude<
    Extract<AddonListenerEventNames<ServerToAddonProtocol>, string>,
    Excluded
  >]: ServerCommandListener<
    Event,
    EventResponse & {
      resolve(data: AddonServerToClientResponseArgs[Event]): void;
    }
  >;
};

/** Local SDK lifecycle hooks (not declared in `addonProtocol.serverToAddon`). */
export type AddonSDKLifecycleEventListenerTypes<EventResponse> = {
  connect: (event: EventResponse) => void;
  disconnect: (reason: string) => void;
  exit: () => void;
  response: (response: unknown) => void;
};

/** Host-side events emitted by `@ogi-sdk/addon-server`. */
export type AddonServerLifecycleEvent = 'connect' | 'disconnect' | 'start';

export type AddonServerHostEventName =
  | AddonServerLifecycleEvent
  | Extract<'notification' | 'input-asked', AddonClientToServerEventName>;

export type AddonServerHostEventListeners<Connection = unknown> = {
  connect: (connection: Connection) => void;
  disconnect: (reason: string) => void;
  start: () => void;
  notification: (notification: AddonNotificationMessage) => void;
  'input-asked': (
    name: AddonClientToServerEventArgs['input-asked']['name'],
    description: AddonClientToServerEventArgs['input-asked']['description'],
    configuration: AddonClientToServerEventArgs['input-asked']['config'],
    reply: (
      result: Record<string, string | number | boolean>
    ) => void | Promise<void>
  ) => void;
};

/** First argument to the addon `setup` listener (`addon.on('setup', ...)`). */
export type SetupCommandData = AddonServerToClientEventArgs['setup'][0];
