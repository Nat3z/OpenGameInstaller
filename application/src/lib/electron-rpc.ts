import { Rpc, RpcGroup, type RpcMessage } from '@effect/rpc';
import type * as RpcClientError from '@effect/rpc/RpcClientError';
import type { LibraryInfo } from '@ogi-sdk/connect';
import type {
  $AddMagnetOrTorrent,
  $AllDebridTorrentInfo,
  $Hosts as AllDebridHosts,
  $UserInfo as AllDebridUserInfo,
} from 'all-debrid-js';
import type { AxiosRequestConfig } from 'axios';
import { Schema } from 'effect';
import type * as Effect from 'effect/Effect';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import type {
  $AddTorrentOrMagnet,
  $Hosts,
  $TorrentInfo,
  $UnrestrictLink,
  $UserInfo,
} from 'real-debrid-js';
import type { DownloadHandshakeResult } from '@/lib/download-handshake.js';

export const ELECTRON_RPC_CHANNEL = 'effect-rpc';

export interface ElectronRpcRequest {
  readonly sessionId: string;
  readonly message: RpcMessage.FromClientEncoded;
}

export interface ElectronRpcTransport {
  readonly invoke: (
    message: RpcMessage.FromClientEncoded
  ) => Promise<RpcMessage.FromServerEncoded | undefined>;
}

export const OperatingSystem = Schema.Literal('darwin', 'linux', 'win32');

export type OperatingSystem = typeof OperatingSystem.Type;

export class ElectronRpcError extends Schema.TaggedError<ElectronRpcError>()(
  'ElectronRpcError',
  {
    procedure: Schema.String,
    message: Schema.String,
  }
) {}

export type ElectronAxiosMethod = <A = unknown>(
  options: AxiosRequestConfig
) => Effect.Effect<
  { data: A; status: number; success: boolean },
  ElectronRpcError | RpcClientError.RpcClientError
>;

const opaque = <A>(): Schema.Schema<A> => Schema.Unknown as Schema.Schema<A>;
const withClient =
  <Client>() =>
  <Procedure extends Rpc.Any>(procedure: Procedure) =>
    procedure as Procedure & { readonly _Client: Client };
const rpc = <
  const Tag extends string,
  const Payload extends Schema.TupleType.Elements,
  Success extends Schema.Schema.Any,
>(
  tag: Tag,
  payload: Payload,
  success: Success
) =>
  Rpc.make(tag, {
    payload: Schema.Tuple(...payload),
    success,
    error: ElectronRpcError,
  });

const Void = Schema.Void;
const StringArray = Schema.mutable(Schema.Array(Schema.String));
const OptionalString = Schema.optionalElement(
  Schema.UndefinedOr(Schema.String)
);
const OptionalNumber = Schema.optionalElement(
  Schema.UndefinedOr(Schema.Number)
);
const ErrorResponse = Schema.Struct({
  status: Schema.Literal('error'),
  error: Schema.String,
});

export const ElectronRpc = {
  app: {
    close: rpc('app.close', [], Void),
    hideWindow: rpc('app.hideWindow', [], Void),
    showWindow: rpc('app.showWindow', [], Void),
    minimize: rpc('app.minimize', [], Void),
    quit: rpc('app.quit', [], Void),
    getOS: rpc('app.getOS', [], OperatingSystem),
    grantRootPassword: rpc('app.grantRootPassword', [Schema.String], Void),
    openSteamKeyboard: rpc(
      'app.openSteamKeyboard',
      [
        Schema.Struct({
          x: Schema.Number,
          y: Schema.Number,
          width: Schema.Number,
          height: Schema.Number,
        }),
      ],
      Schema.Boolean
    ),
    axios: withClient<ElectronAxiosMethod>()(
      rpc(
        'app.axios',
        [opaque<AxiosRequestConfig>()],
        opaque<{ data: unknown; status: number; success: boolean }>()
      )
    ),
    isSteamDeck: rpc('app.isSteamDeck', [], Schema.Boolean),
    inputSend: rpc('app.inputSend', [Schema.String, Schema.Unknown], Void),
    isOnline: rpc('app.isOnline', [], Schema.Boolean),
    getAddonPath: rpc(
      'app.getAddonPath',
      [Schema.String],
      Schema.NullOr(Schema.String)
    ),
    getAddonIcon: rpc(
      'app.getAddonIcon',
      [Schema.String],
      Schema.NullOr(Schema.String)
    ),
    getLocalImage: rpc(
      'app.getLocalImage',
      [Schema.String],
      Schema.NullOr(Schema.String)
    ),
    addToDesktop: rpc(
      'app.addToDesktop',
      [],
      Schema.Union(
        Schema.Struct({ success: Schema.Literal(true), path: Schema.String }),
        Schema.Struct({ success: Schema.Literal(false), error: Schema.String })
      )
    ),
    launchGame: rpc('app.launchGame', [Schema.String], Void),
    executeWrapperCommand: rpc(
      'app.executeWrapperCommand',
      [Schema.Number, Schema.String],
      opaque<{
        success: boolean;
        exitCode?: number;
        signal?: string;
        error?: string;
      }>()
    ),
    removeApp: rpc(
      'app.removeApp',
      [Schema.Number],
      opaque<
        | { status: 'success'; warning?: string }
        | { status: 'cancelled'; message: string }
        | { status: 'error'; error: string }
      >()
    ),
    insertApp: rpc(
      'app.insertApp',
      [
        opaque<
          LibraryInfo & { redistributables?: { name: string; path: string }[] }
        >(),
      ],
      Schema.Literal(
        'setup-failed',
        'setup-success',
        'setup-redistributables-failed',
        'setup-redistributables-success',
        'setup-prefix-required'
      )
    ),
    getAllApps: rpc('app.getAllApps', [], opaque<LibraryInfo[]>()),
    updateAppVersion: rpc(
      'app.updateAppVersion',
      [
        Schema.Number,
        Schema.String,
        Schema.String,
        Schema.String,
        OptionalString,
        OptionalString,
        Schema.optionalElement(
          Schema.UndefinedOr(opaque<LibraryInfo['umu']>())
        ),
        Schema.optionalElement(
          Schema.UndefinedOr(opaque<LibraryInfo['launchEnv']>())
        ),
      ],
      Schema.Literal('success', 'app-not-found')
    ),
    getLibraryInfo: rpc(
      'app.getLibraryInfo',
      [Schema.Number],
      Schema.NullOr(opaque<LibraryInfo>())
    ),
    installRedistributables: rpc(
      'app.installRedistributables',
      [Schema.Number, OptionalString],
      Schema.Literal('success', 'failed', 'not-found')
    ),
    checkUmuInstalled: rpc('app.checkUmuInstalled', [], Schema.Boolean),
    installUmu: rpc(
      'app.installUmu',
      [],
      opaque<{ success: boolean; error?: string }>()
    ),
    launchWithUmu: rpc(
      'app.launchWithUmu',
      [Schema.Number],
      opaque<{ success: boolean; error?: string; pid?: number }>()
    ),
    installRedistributablesUmu: rpc(
      'app.installRedistributablesUmu',
      [Schema.Number],
      Schema.Literal('success', 'failed', 'not-found')
    ),
    migrateToUmu: rpc(
      'app.migrateToUmu',
      [Schema.Number, OptionalNumber],
      opaque<{ success: boolean; error?: string }>()
    ),
    getSteamAppId: rpc(
      'app.getSteamAppId',
      [Schema.Number],
      Schema.Union(
        Schema.Struct({
          status: Schema.Literal('success'),
          appId: Schema.Number,
        }),
        ErrorResponse
      )
    ),
    launchSteamApp: rpc(
      'app.launchSteamApp',
      [Schema.Number],
      opaque<
        | { status: 'success'; shortcutId: number }
        | { status: 'cancelled'; message: string }
        | { status: 'error'; error: string }
      >()
    ),
    checkPrefixExists: rpc(
      'app.checkPrefixExists',
      [Schema.Number],
      opaque<{ exists: boolean; prefixPath?: string; error?: string }>()
    ),
    addToSteam: rpc(
      'app.addToSteam',
      [Schema.Number, OptionalNumber],
      opaque<
        | {
            status: 'success';
            steamAppId?: number;
            installation: 'native' | 'flatpak';
            warning?: string;
          }
        | { status: 'cancelled'; message: string }
        | { status: 'error'; error: string }
      >()
    ),
    removeFromSteam: rpc(
      'app.removeFromSteam',
      [Schema.Number],
      opaque<
        | {
            status: 'success';
            steamAppId?: number;
            installation: 'native' | 'flatpak';
            warning?: string;
          }
        | { status: 'cancelled'; message: string }
        | { status: 'error'; error: string }
      >()
    ),
  },
  fs: {
    dialog: {
      showOpenDialog: rpc(
        'fs.dialog.showOpenDialog',
        [opaque<OpenDialogOptions>()],
        Schema.UndefinedOr(Schema.String)
      ),
      showSaveDialog: rpc(
        'fs.dialog.showSaveDialog',
        [opaque<SaveDialogOptions>()],
        Schema.UndefinedOr(Schema.String)
      ),
    },
    getFilesInDir: rpc('fs.getFilesInDir', [Schema.String], StringArray),
    deleteAsync: rpc(
      'fs.deleteAsync',
      [Schema.String],
      Schema.Literal('success')
    ),
    move: rpc(
      'fs.move',
      [Schema.Struct({ source: Schema.String, destination: Schema.String })],
      Schema.Literal('success')
    ),
    unrar: rpc(
      'fs.unrar',
      [
        opaque<{
          outputDir: string;
          rarFilePath: string;
          downloadId?: string;
        }>(),
      ],
      Schema.NullOr(Schema.String)
    ),
    unzip: rpc(
      'fs.unzip',
      [
        opaque<{
          zipFilePath: string;
          outputDir: string;
          downloadId?: string;
        }>(),
      ],
      Schema.NullOr(Schema.String)
    ),
  },
  realdebrid: {
    setKey: rpc('realdebrid.setKey', [Schema.String], Schema.String),
    updateKey: rpc('realdebrid.updateKey', [], Schema.Boolean),
    addMagnet: rpc(
      'realdebrid.addMagnet',
      [Schema.String, OptionalString],
      opaque<$AddTorrentOrMagnet>()
    ),
    getUserInfo: rpc('realdebrid.getUserInfo', [], opaque<$UserInfo>()),
    unrestrictLink: rpc(
      'realdebrid.unrestrictLink',
      [Schema.String],
      opaque<$UnrestrictLink>()
    ),
    getHosts: rpc('realdebrid.getHosts', [], opaque<$Hosts[]>()),
    getTorrentInfo: rpc(
      'realdebrid.getTorrentInfo',
      [Schema.String],
      opaque<$TorrentInfo>()
    ),
    isTorrentReady: rpc(
      'realdebrid.isTorrentReady',
      [Schema.String],
      Schema.Boolean
    ),
    selectTorrent: rpc(
      'realdebrid.selectTorrent',
      [Schema.String],
      Schema.Boolean
    ),
    addTorrent: rpc(
      'realdebrid.addTorrent',
      [Schema.String, OptionalString],
      opaque<$AddTorrentOrMagnet>()
    ),
  },
  alldebrid: {
    setKey: rpc('alldebrid.setKey', [Schema.String], Schema.String),
    updateKey: rpc('alldebrid.updateKey', [], Schema.Boolean),
    getUserInfo: rpc('alldebrid.getUserInfo', [], opaque<AllDebridUserInfo>()),
    getHosts: rpc('alldebrid.getHosts', [], opaque<AllDebridHosts>()),
    addMagnet: rpc(
      'alldebrid.addMagnet',
      [Schema.String, OptionalString],
      opaque<$AddMagnetOrTorrent>()
    ),
    isTorrentReady: rpc(
      'alldebrid.isTorrentReady',
      [Schema.String],
      Schema.Boolean
    ),
    getTorrentInfo: rpc(
      'alldebrid.getTorrentInfo',
      [Schema.String],
      opaque<$AllDebridTorrentInfo>()
    ),
    unrestrictLink: rpc(
      'alldebrid.unrestrictLink',
      [Schema.String],
      opaque<{
        link: string;
        download?: string;
        filename?: string;
        filesize?: number;
      }>()
    ),
    selectTorrent: rpc('alldebrid.selectTorrent', [], Schema.Boolean),
    addTorrent: rpc(
      'alldebrid.addTorrent',
      [Schema.String],
      Schema.NullOr(opaque<$AddMagnetOrTorrent>())
    ),
  },
  ddl: {
    download: rpc(
      'ddl.download',
      [
        Schema.mutable(
          Schema.Array(
            Schema.Struct({
              link: Schema.String,
              path: Schema.String,
              headers: Schema.optional(
                Schema.Record({ key: Schema.String, value: Schema.String })
              ),
            })
          )
        ),
        OptionalNumber,
      ],
      opaque<DownloadHandshakeResult>()
    ),
    pauseDownload: rpc('ddl.pauseDownload', [Schema.String], Void),
    resumeDownload: rpc('ddl.resumeDownload', [Schema.String], Schema.Boolean),
    abortDownload: rpc('ddl.abortDownload', [Schema.String], Void),
  },
  download: {
    consumeReplayEvents: rpc(
      'download.consumeReplayEvents',
      [Schema.String],
      Schema.Array(
        Schema.Struct({ channel: Schema.String, data: Schema.Unknown })
      )
    ),
    getHandshakeState: rpc(
      'download.getHandshakeState',
      [Schema.String],
      Schema.UndefinedOr(opaque<DownloadHandshakeResult>())
    ),
  },
  queue: {
    cancel: rpc('queue.cancel', [Schema.String], Void),
  },
  torrent: {
    downloadTorrent: rpc(
      'torrent.downloadTorrent',
      [Schema.String, Schema.String],
      opaque<DownloadHandshakeResult>()
    ),
    downloadMagnet: rpc(
      'torrent.downloadMagnet',
      [Schema.String, Schema.String],
      opaque<DownloadHandshakeResult>()
    ),
    pauseDownload: rpc('torrent.pauseDownload', [Schema.String], Void),
    resumeDownload: rpc('torrent.resumeDownload', [Schema.String], Void),
    abortDownload: rpc('torrent.abortDownload', [Schema.String], Void),
  },
  oobe: {
    downloadTools: rpc(
      'oobe.downloadTools',
      [],
      Schema.Tuple(Schema.Boolean, Schema.Boolean)
    ),
    setSteamGridDBKey: rpc(
      'oobe.setSteamGridDBKey',
      [Schema.String],
      Schema.Boolean
    ),
  },
  powerSave: {
    setActive: rpc('powerSave.setActive', [Schema.Boolean], Void),
  },
  installAddons: rpc('installAddons', [StringArray], StringArray),
  restartAddonServer: rpc('restartAddonServer', [], Void),
  deleteInstalledAddon: rpc(
    'deleteInstalledAddon',
    [Schema.String],
    Schema.Struct({
      success: Schema.Boolean,
      message: Schema.optional(Schema.String),
    })
  ),
  cleanAddons: rpc('cleanAddons', [StringArray], Void),
  updateAddons: rpc('updateAddons', [], Void),
  downloadTorrentInto: rpc(
    'downloadTorrentInto',
    [Schema.String],
    Schema.Uint8ArrayFromSelf
  ),
  getTorrentHash: rpc(
    'getTorrentHash',
    [Schema.Union(Schema.String, Schema.Uint8ArrayFromSelf)],
    Schema.String
  ),
} as const;

type RpcsIn<Value> = Value extends Rpc.Any
  ? Value
  : Value extends object
    ? RpcsIn<Value[keyof Value]>
    : never;

const rpcValues = (value: object): Rpc.Any[] =>
  Object.values(value).flatMap((entry) => {
    if (
      (typeof entry === 'object' || typeof entry === 'function') &&
      entry !== null &&
      '_tag' in entry
    ) {
      return [entry as Rpc.Any];
    }
    return typeof entry === 'object' && entry !== null ? rpcValues(entry) : [];
  });

export const ElectronRpcs = RpcGroup.make(
  ...rpcValues(ElectronRpc)
) as unknown as RpcGroup.RpcGroup<RpcsIn<typeof ElectronRpc>>;
