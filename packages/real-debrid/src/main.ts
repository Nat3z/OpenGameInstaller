import type { ReadStream } from 'node:fs';
import {
  DebridApiError,
  DebridAuthError,
  DebridResponseError,
  HttpError,
} from '@ogi/errors';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from 'effect';

export interface RealDebridConfiguration {
  readonly apiKey: string;
}

export const UnrestrictLinkSchema = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  filesize: Schema.Number,
  link: Schema.String,
  host: Schema.String,
  chunks: Schema.Number,
  crc: Schema.Number,
  download: Schema.String,
  streamable: Schema.Number,
});

export const UserInfoSchema = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  email: Schema.String,
  points: Schema.Number,
  locale: Schema.String,
  avatar: Schema.String,
  type: Schema.String,
  premium: Schema.Number,
  expiration: Schema.String,
});

export const HostsSchema = Schema.Struct({
  host: Schema.String,
  max_file_size: Schema.Number,
});

export const AddTorrentOrMagnetSchema = Schema.Struct({
  id: Schema.String,
  uri: Schema.String.pipe(
    Schema.filter((value) => URL.canParse(value), {
      message: () => 'Expected a valid URL',
    })
  ),
});

export const TorrentInfoSchema = Schema.Struct({
  status: Schema.Literal(
    'magnet_error',
    'magnet_conversion',
    'waiting_files_selection',
    'queued',
    'downloading',
    'downloaded',
    'error',
    'virus',
    'compressing',
    'uploading',
    'dead'
  ),
  id: Schema.String,
  filename: Schema.String,
  hash: Schema.String,
  bytes: Schema.Number,
  host: Schema.String,
  split: Schema.Number,
  progress: Schema.Number,
  added: Schema.String,
  links: Schema.Array(Schema.String),
  seeders: Schema.optional(Schema.Number),
  original_filename: Schema.optional(Schema.String),
  original_bytes: Schema.optional(Schema.Number),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        path: Schema.String,
        bytes: Schema.Number,
        selected: Schema.Number,
      })
    )
  ),
  ended: Schema.optional(Schema.String),
  speed: Schema.optional(Schema.Number),
});

export type $Hosts = Schema.Schema.Type<typeof HostsSchema>;
export type $UnrestrictLink = Schema.Schema.Type<typeof UnrestrictLinkSchema>;
export type $UserInfo = Schema.Schema.Type<typeof UserInfoSchema>;
export type $AddTorrentOrMagnet = Schema.Schema.Type<
  typeof AddTorrentOrMagnetSchema
>;
export type $TorrentInfo = Schema.Schema.Type<typeof TorrentInfoSchema>;

const REAL_DEBRID_API_URL = 'https://api.real-debrid.com/rest/1.0';
const SERVICE = 'realdebrid' as const;

export type RealDebridHostInput =
  | string
  | { readonly host: string }
  | undefined;
export type RealDebridClientError =
  | HttpError
  | DebridApiError
  | DebridAuthError
  | DebridResponseError;

const normalizeHost = (host: RealDebridHostInput): string | undefined => {
  if (!host) return undefined;
  return typeof host === 'string' ? host : host.host;
};

const decodeUnknown = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  endpoint: string
): Effect.Effect<A, DebridResponseError> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new DebridResponseError({
          service: SERVICE,
          endpoint,
          message: `Invalid Real-Debrid API response from ${endpoint}`,
          cause,
        })
    )
  );

const ApiErrorResponseSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
});

const apiError = (
  response: AxiosResponse<unknown>,
  fallback: string
): DebridApiError | DebridAuthError => {
  if (response.status === 401 || response.status === 403) {
    return new DebridAuthError({
      service: SERVICE,
      message: `${SERVICE} authentication failed`,
    });
  }

  const payload = Option.getOrUndefined(
    Schema.decodeUnknownOption(ApiErrorResponseSchema)(response.data)
  );
  return new DebridApiError({
    service: SERVICE,
    message:
      payload?.error ??
      `${fallback}: ${response.statusText || response.status}`,
    apiCode:
      payload?.error_code === undefined
        ? undefined
        : String(payload.error_code),
    statusCode: response.status,
  });
};

const expectStatus = (
  response: AxiosResponse<unknown>,
  acceptedStatuses: ReadonlyArray<number>,
  fallback: string
): Effect.Effect<void, DebridApiError | DebridAuthError> =>
  acceptedStatuses.includes(response.status)
    ? Effect.void
    : Effect.fail(apiError(response, fallback));

export interface RealDebridClient {
  readonly getUserInfo: () => Effect.Effect<$UserInfo, RealDebridClientError>;
  readonly unrestrictLink: (
    link: string,
    password?: string
  ) => Effect.Effect<$UnrestrictLink, RealDebridClientError>;
  readonly addTorrent: (
    torrent: ReadStream,
    host?: RealDebridHostInput
  ) => Effect.Effect<$AddTorrentOrMagnet, RealDebridClientError>;
  readonly getTorrentInfo: (
    id: string
  ) => Effect.Effect<$TorrentInfo, RealDebridClientError>;
  readonly addMagnet: (
    magnet: string,
    host?: RealDebridHostInput
  ) => Effect.Effect<$AddTorrentOrMagnet, RealDebridClientError>;
  readonly selectTorrents: (
    id: string
  ) => Effect.Effect<boolean, RealDebridClientError>;
  readonly isTorrentReady: (
    id: string
  ) => Effect.Effect<boolean, RealDebridClientError>;
  readonly getHosts: () => Effect.Effect<
    ReadonlyArray<$Hosts>,
    RealDebridClientError
  >;
}

export class RealDebridClientResource extends Context.Tag(
  'real-debrid-js/RealDebridClient'
)<RealDebridClientResource, RealDebridClient>() {}

/** Effect-based client for the Real-Debrid REST API. */
export default class RealDebrid implements RealDebridClient {
  constructor(public readonly configuration: RealDebridConfiguration) {}

  private request(
    url: string,
    config: AxiosRequestConfig = {}
  ): Effect.Effect<AxiosResponse<unknown>, HttpError> {
    return Effect.tryPromise({
      try: () => axios.request<unknown>({ ...config, url }),
      catch: (cause) =>
        new HttpError({
          statusCode: axios.isAxiosError(cause)
            ? (cause.response?.status ?? 0)
            : 0,
          message: cause instanceof Error ? cause.message : String(cause),
          url,
        }),
    });
  }

  private authHeaders(): { readonly Authorization: string } {
    return { Authorization: `Bearer ${this.configuration.apiKey}` };
  }

  public getUserInfo(): Effect.Effect<$UserInfo, RealDebridClientError> {
    const url = `${REAL_DEBRID_API_URL}/user`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch user info');
      return yield* decodeUnknown(UserInfoSchema, response.data, url);
    });
  }

  public unrestrictLink(
    link: string,
    password = ''
  ): Effect.Effect<$UnrestrictLink, RealDebridClientError> {
    const url = `${REAL_DEBRID_API_URL}/unrestrict/link`;
    return Effect.gen(this, function* () {
      const formData = new URLSearchParams({ link });
      if (password) formData.append('password', password);

      const response = yield* this.request(url, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: formData,
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to unrestrict link');
      return yield* decodeUnknown(UnrestrictLinkSchema, response.data, url);
    });
  }

  public addTorrent(
    torrent: ReadStream,
    host?: RealDebridHostInput
  ): Effect.Effect<$AddTorrentOrMagnet, RealDebridClientError> {
    const url = new URL(`${REAL_DEBRID_API_URL}/torrents/addTorrent`);
    const normalizedHost = normalizeHost(host);
    if (normalizedHost) url.searchParams.append('host', normalizedHost);
    const requestUrl = url.toString();

    return Effect.gen(this, function* () {
      const response = yield* this.request(requestUrl, {
        method: 'PUT',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/octet-stream',
        },
        data: torrent,
        validateStatus: () => true,
      });
      yield* expectStatus(response, [201], 'Failed to add torrent');
      return yield* decodeUnknown(
        AddTorrentOrMagnetSchema,
        response.data,
        requestUrl
      );
    });
  }

  public getTorrentInfo(
    id: string
  ): Effect.Effect<$TorrentInfo, RealDebridClientError> {
    const url = `${REAL_DEBRID_API_URL}/torrents/info/${id}`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch torrent info');
      return yield* decodeUnknown(TorrentInfoSchema, response.data, url);
    });
  }

  public addMagnet(
    magnet: string,
    host?: RealDebridHostInput
  ): Effect.Effect<$AddTorrentOrMagnet, RealDebridClientError> {
    const url = `${REAL_DEBRID_API_URL}/torrents/addMagnet`;
    return Effect.gen(this, function* () {
      const formData = new URLSearchParams({ magnet });
      const normalizedHost = normalizeHost(host);
      if (normalizedHost) formData.append('host', normalizedHost);

      const response = yield* this.request(url, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: formData,
        validateStatus: () => true,
      });
      yield* expectStatus(response, [201], 'Failed to add magnet');
      return yield* decodeUnknown(AddTorrentOrMagnetSchema, response.data, url);
    });
  }

  public selectTorrents(
    id: string
  ): Effect.Effect<boolean, RealDebridClientError> {
    const url = `${REAL_DEBRID_API_URL}/torrents/selectFiles/${id}`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: new URLSearchParams({ files: 'all' }),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200, 202, 204], 'Failed to select files');
      return true;
    });
  }

  public isTorrentReady(
    id: string
  ): Effect.Effect<boolean, RealDebridClientError> {
    return Effect.gen(this, function* () {
      const torrentInfo = yield* this.getTorrentInfo(id);
      return torrentInfo.status === 'downloaded';
    });
  }

  public getHosts(): Effect.Effect<
    ReadonlyArray<$Hosts>,
    RealDebridClientError
  > {
    const url = `${REAL_DEBRID_API_URL}/torrents/availableHosts`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch hosts');
      return yield* decodeUnknown(
        Schema.Array(HostsSchema),
        response.data,
        url
      );
    });
  }
}

export const makeRealDebridClient = (
  configuration: RealDebridConfiguration
): RealDebridClient => new RealDebrid(configuration);

export const RealDebridClientLayer = (
  configuration: RealDebridConfiguration
): Layer.Layer<RealDebridClientResource> =>
  Layer.succeed(RealDebridClientResource, makeRealDebridClient(configuration));

const runLegacyPromise = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

/** Promise adapter for consumers that have not migrated to Effect. */
export class LegacyRealDebridPromiseClient {
  private readonly client: RealDebridClient;

  constructor(configuration: RealDebridConfiguration) {
    this.client = makeRealDebridClient(configuration);
  }

  public getUserInfo(): Promise<$UserInfo> {
    return runLegacyPromise(this.client.getUserInfo());
  }

  public unrestrictLink(
    link: string,
    password?: string
  ): Promise<$UnrestrictLink> {
    return runLegacyPromise(this.client.unrestrictLink(link, password));
  }

  public addTorrent(
    torrent: ReadStream,
    host?: RealDebridHostInput
  ): Promise<$AddTorrentOrMagnet> {
    return runLegacyPromise(this.client.addTorrent(torrent, host));
  }

  public getTorrentInfo(id: string): Promise<$TorrentInfo> {
    return runLegacyPromise(this.client.getTorrentInfo(id));
  }

  public addMagnet(
    magnet: string,
    host?: RealDebridHostInput
  ): Promise<$AddTorrentOrMagnet> {
    return runLegacyPromise(this.client.addMagnet(magnet, host));
  }

  public selectTorrents(id: string): Promise<boolean> {
    return runLegacyPromise(this.client.selectTorrents(id));
  }

  public isTorrentReady(id: string): Promise<boolean> {
    return runLegacyPromise(this.client.isTorrentReady(id));
  }

  public getHosts(): Promise<ReadonlyArray<$Hosts>> {
    return runLegacyPromise(this.client.getHosts());
  }
}
