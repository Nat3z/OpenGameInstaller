import type {
  AddonNotificationMessage,
  BasicLibraryInfo,
  CatalogResponse,
  ConfigurationFile,
  LibraryInfo,
  OGIAddonConfiguration,
  SearchResult,
  SetupResponse,
  StoreData,
} from './protocol-base';

const argsType = Symbol('argsType');
const responseType = Symbol('responseType');
const addonMessageType = Symbol('addonMessageType');
const sdkMessageKindType = Symbol('sdkMessageKindType');
const sdkMessageArgsType = Symbol('sdkMessageArgsType');
const sdkMessageResponseType = Symbol('sdkMessageResponseType');
const slotType = Symbol('slotType');
const slotMergeType = Symbol('slotMergeType');

/**
 * Named generic placeholders available inside `addonProtocol` definitions.
 *
 * Use `ProtocolSlot<'SearchResult'>`, for example, when an event's args or
 * response should resolve to the package-specific `SearchResult` generic used
 * by consumers of `AddonServerToClientEventArgs` / response maps.
 */
export type AddonProtocolSlots = {
  ConfigurationFile: ConfigurationFile;
  Configuration: OGIAddonConfiguration;
  Notification: AddonNotificationMessage;
  LibraryInfo: LibraryInfo;
  SearchResult: SearchResult;
  SetupResponse: SetupResponse;
  BasicLibraryInfo: BasicLibraryInfo;
  StoreData: StoreData;
  CatalogResponse: CatalogResponse;
};

/** Type-only placeholder for one named protocol generic slot. */
export type ProtocolSlot<Name extends keyof AddonProtocolSlots> = {
  readonly [slotType]: Name;
};

/**
 * Type-only placeholder for `Shape & Slot`.
 *
 * Useful when a payload has fixed protocol fields plus a consumer-provided
 * shape. Example: addon authentication is `{ secret, ogiVersion } & Configuration`.
 */
export type ProtocolSlotMerge<
  Name extends keyof AddonProtocolSlots,
  Shape,
> = {
  readonly [slotMergeType]: {
    name: Name;
    shape: Shape;
  };
};

export type SlotValues<
  ConfigurationFileType = ConfigurationFile,
  Configuration extends OGIAddonConfiguration = OGIAddonConfiguration,
  Notification = AddonNotificationMessage,
  LibraryInfoType = LibraryInfo,
  SearchResultType = SearchResult,
  SetupResponseType = SetupResponse,
  BasicLibraryInfoType = BasicLibraryInfo,
  StoreDataType = StoreData,
  CatalogResponseType = CatalogResponse,
> = {
  ConfigurationFile: ConfigurationFileType;
  Configuration: Configuration;
  Notification: Notification;
  LibraryInfo: LibraryInfoType;
  SearchResult: SearchResultType;
  SetupResponse: SetupResponseType;
  BasicLibraryInfo: BasicLibraryInfoType;
  StoreData: StoreDataType;
  CatalogResponse: CatalogResponseType;
};

/** Replaces `ProtocolSlot<...>` markers in a protocol spec with concrete generic values. */
export type ResolveProtocolValue<
  T,
  Slots extends Record<keyof AddonProtocolSlots, unknown>,
> = T extends ProtocolSlotMerge<infer Name, infer Shape>
  ? ResolveProtocolValue<Shape, Slots> & Slots[Name]
  : T extends ProtocolSlot<infer Name>
    ? Slots[Name]
    : T extends readonly unknown[]
      ? { [Key in keyof T]: ResolveProtocolValue<T[Key], Slots> }
      : T extends object
        ? { [Key in keyof T]: ResolveProtocolValue<T[Key], Slots> }
        : T;

/**
 * Describes how positional server→addon event args are packed onto the wire.
 *
 * - `args`: default; first tuple item becomes `{ args }`.
 * - `none`: sends `{ args: undefined }` for no-arg events.
 * - `object`: multiple tuple items become an object using `keys`.
 * - `response`: special response envelope: tuple is `[id, response, statusError]`.
 */
export type ServerCommandPack =
  | { type: 'args' }
  | { type: 'none' }
  | { type: 'object'; keys: readonly string[] }
  | { type: 'response' };

export type ServerCommandSpec<
  Args extends readonly unknown[],
  Response,
  AddonListener extends boolean = false,
> = {
  readonly type: 'server-command';
  readonly addonListener: AddonListener;
  readonly pack: ServerCommandPack;
  readonly [argsType]?: Args;
  readonly [responseType]?: Response;
};

export type AddonMessageSpec<Args> = {
  readonly type: 'addon-message';
  readonly [addonMessageType]?: Args;
};

export type SDKMessageSpec<Kind extends string, Args = never, Response = never> = {
  readonly type: 'sdk-bridge-message';
  readonly kind: Kind;
  readonly [sdkMessageKindType]?: Kind;
  readonly [sdkMessageArgsType]?: Args;
  readonly [sdkMessageResponseType]?: Response;
};

/**
 * Creates a server→addon command spec.
 *
 * Type params:
 * - `Args`: tuple of positional arguments used by `client.events.someEvent(...)`.
 * - `Response`: success value returned by the addon.
 * - `AddonListener`: set to `true` when addons can implement it via `ogiAddon.on(...)`
 *   and advertise it in `events-available`.
 *
 * Runtime options:
 * - `addonListener`: mirrors the third type param; keep both as `true` when opt-in.
 * - `pack`: only needed for non-default wire packing. Most one-argument events use
 *   the default `{ type: 'args' }`.
 */
export const serverCommand = <
  Args extends readonly unknown[],
  Response,
  AddonListener extends boolean = false,
>(options?: {
  addonListener?: AddonListener;
  pack?: ServerCommandPack;
}): ServerCommandSpec<Args, Response, AddonListener> => ({
  type: 'server-command',
  addonListener: (options?.addonListener ?? false) as AddonListener,
  pack: options?.pack ?? { type: 'args' },
}) as ServerCommandSpec<Args, Response, AddonListener>;

/**
 * Creates an addon→server message spec.
 *
 * Type param `Args` is the object payload carried in the message's `args` field.
 * Use this for pushes like `notification`, `task-update`, `flag`, etc.
 */
export const addonMessage = <Args>(): AddonMessageSpec<Args> => ({
  type: 'addon-message',
}) as AddonMessageSpec<Args>;

/**
 * Creates an SDK bridge envelope event spec.
 *
 * Type params:
 * - `Kind`: internal bridge kind used by derived helper types.
 * - `Args`: request payload for SDK→server events, or response payload for
 *   server→SDK events when that payload does not depend on a forwarded addon event.
 * - `Response`: optional companion response payload for request-style events.
 *
 * For normal SDK-only requests (server handles it directly), put both request
 * and response shapes in `Args` / `Response`. The wire `event` is still
 * `forward` / `query` / `response` / `forward-response`; the `kind` field is for
 * static typing only.
 *
 * For `serverToSdk.response`, use `Response = unknown` so the envelope accepts
 * any body; the per-request body comes from the matching `sdkToServer` row's
 * `Response` generic and is reachable via `SDKResponse<'name'>` from
 * `@ogi-sdk/connect`.
 */
export const sdkMessage = <Kind extends string, Args = never, Response = never>(
  kind: Kind
): SDKMessageSpec<Kind, Args, Response> => ({
  type: 'sdk-bridge-message',
  kind,
}) as SDKMessageSpec<Kind, Args, Response>;

/**
 * Defines the full addon protocol registry and preserves literal event names.
 *
 * Add new protocol events inside this registry instead of editing unions/maps by
 * hand. The exported event-name unions, arg maps, response maps, and proxy
 * generator all derive from this object.
 */
export const defineAddonProtocol = <
  ServerToAddon extends Record<
    string,
    ServerCommandSpec<readonly unknown[], unknown, boolean>
  >,
  AddonToServer extends Record<string, AddonMessageSpec<unknown>>,
  SDKToServer extends Record<string, SDKMessageSpec<string, unknown, unknown>>,
  ServerToSDK extends Record<string, SDKMessageSpec<string, unknown, unknown>>,
>(protocol: {
  serverToAddon: ServerToAddon;
  addonToServer: AddonToServer;
  sdkToServer: SDKToServer;
  serverToSdk: ServerToSDK;
}) => protocol;

export type ServerCommandArgs<Spec> = Spec extends ServerCommandSpec<
  infer Args,
  unknown,
  boolean
>
  ? Args
  : never;

export type ServerCommandResponse<Spec> = Spec extends ServerCommandSpec<
  readonly unknown[],
  infer Response,
  boolean
>
  ? Response
  : never;

export type AddonMessageArgs<Spec> = Spec extends AddonMessageSpec<infer Args>
  ? Args
  : never;

/** Resolves an SDK→server registry entry to its concrete wire `args` type. */
export type SDKMessageRequestArgs<Spec> = Spec extends SDKMessageSpec<
  string,
  infer Args,
  unknown
>
  ? Args
  : never;

export type SDKMessageResponseArgs<Spec> = Spec extends SDKMessageSpec<
  string,
  unknown,
  infer Response
>
  ? Response
  : never;

export type SDKToServerMessageArgs<Spec, ForwardRequest> =
  Spec extends SDKMessageSpec<'forward', unknown, unknown>
    ? ForwardRequest
    : SDKMessageRequestArgs<Spec>;

/** Resolves a server→SDK registry entry to its concrete wire `args` type. */
export type ServerToSDKMessageArgs<Spec, ForwardResponse> =
  Spec extends SDKMessageSpec<'forward-response', unknown, unknown>
    ? ForwardResponse
    : SDKMessageResponseArgs<Spec>;

export type AddonListenerEventNames<
  ServerToAddonProtocol extends Record<
    string,
    ServerCommandSpec<readonly unknown[], unknown, boolean>
  >,
> = {
  [Event in keyof ServerToAddonProtocol]: ServerToAddonProtocol[Event] extends ServerCommandSpec<
    readonly unknown[],
    unknown,
    true
  >
    ? Event
    : never;
}[keyof ServerToAddonProtocol];
