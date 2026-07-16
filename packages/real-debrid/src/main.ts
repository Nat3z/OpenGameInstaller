import type { ReadStream } from 'node:fs';
import {
  DebridAuthError,
  DebridError,
  HttpError,
  ValidationError,
} from '@ogi/errors';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { Effect, Schema } from 'effect';

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

type RealDebridHostInput = string | { readonly host: string } | undefined;
type ApiError = DebridError | DebridAuthError | ValidationError;
type ClientError = HttpError | ApiError;

const normalizeHost = (host: RealDebridHostInput): string | undefined => {
  if (!host) return undefined;
  return typeof host === 'string' ? host : host.host;
};

const decodeUnknown = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown
): Effect.Effect<A, ValidationError> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (error) =>
        new ValidationError({
          message: `Invalid Real-Debrid API response: ${String(error)}`,
        })
    )
  );

const responseField = (data: unknown, key: string): unknown => {
  if (typeof data !== 'object' || data === null || !(key in data)) {
    return undefined;
  }
  return data[key as keyof typeof data];
};

const apiError = (
  response: AxiosResponse<unknown>,
  fallback: string
): DebridError | DebridAuthError => {
  if (response.status === 401 || response.status === 403) {
    return new DebridAuthError({ service: SERVICE });
  }

  const rawMessage = responseField(response.data, 'error');
  const rawCode = responseField(response.data, 'error_code');
  return new DebridError({
    service: SERVICE,
    message:
      typeof rawMessage === 'string'
        ? rawMessage
        : `${fallback}: ${response.statusText || response.status}`,
    apiCode: rawCode === undefined ? undefined : String(rawCode),
  });
};

const expectStatus = (
  response: AxiosResponse<unknown>,
  acceptedStatuses: ReadonlyArray<number>,
  fallback: string
): Effect.Effect<void, DebridError | DebridAuthError> =>
  acceptedStatuses.includes(response.status)
    ? Effect.void
    : Effect.fail(apiError(response, fallback));

/** Effect-based client for the Real-Debrid REST API. */
export default class RealDebrid {
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

  public getUserInfo(): Effect.Effect<$UserInfo, ClientError> {
    const url = `${REAL_DEBRID_API_URL}/user`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch user info');
      return yield* decodeUnknown(UserInfoSchema, response.data);
    });
  }

  public unrestrictLink(
    link: string,
    password = ''
  ): Effect.Effect<$UnrestrictLink, ClientError> {
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
      return yield* decodeUnknown(UnrestrictLinkSchema, response.data);
    });
  }

  public addTorrent(
    torrent: ReadStream,
    host?: RealDebridHostInput
  ): Effect.Effect<$AddTorrentOrMagnet, ClientError> {
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
      yield* Effect.try({
        try: () => torrent.close(),
        catch: (cause) =>
          new DebridError({
            service: SERVICE,
            message: `Failed to close torrent stream: ${String(cause)}`,
          }),
      });
      return yield* decodeUnknown(AddTorrentOrMagnetSchema, response.data);
    });
  }

  public getTorrentInfo(id: string): Effect.Effect<$TorrentInfo, ClientError> {
    const url = `${REAL_DEBRID_API_URL}/torrents/info/${id}`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch torrent info');
      return yield* decodeUnknown(TorrentInfoSchema, response.data);
    });
  }

  public addMagnet(
    magnet: string,
    host?: RealDebridHostInput
  ): Effect.Effect<$AddTorrentOrMagnet, ClientError> {
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
      return yield* decodeUnknown(AddTorrentOrMagnetSchema, response.data);
    });
  }

  public selectTorrents(id: string): Effect.Effect<boolean, ClientError> {
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

  public isTorrentReady(id: string): Effect.Effect<boolean, ClientError> {
    return Effect.gen(this, function* () {
      const torrentInfo = yield* this.getTorrentInfo(id);
      return torrentInfo.status === 'downloaded';
    });
  }

  public getHosts(): Effect.Effect<ReadonlyArray<$Hosts>, ClientError> {
    const url = `${REAL_DEBRID_API_URL}/torrents/availableHosts`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, {
        headers: this.authHeaders(),
        validateStatus: () => true,
      });
      yield* expectStatus(response, [200], 'Failed to fetch hosts');
      return yield* decodeUnknown(Schema.Array(HostsSchema), response.data);
    });
  }
}
