import type { ReadStream } from 'node:fs';
import {
  DebridApiError,
  DebridAuthError,
  DebridResponseError,
  DebridTimeoutError,
  HttpError,
} from '@ogi/errors';
import axios, { type AxiosResponse } from 'axios';
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from 'effect';
import FormData from 'form-data';

const BASE_V4 = 'https://api.alldebrid.com/v4';
const BASE_V4_1 = 'https://api.alldebrid.com/v4.1';
const SERVICE = 'alldebrid' as const;

/** Configuration for the AllDebrid API client (API key). */
export interface AllDebridConfiguration {
  readonly apiKey: string;
}

const ApiResponseSuccess = <A, I, R>(dataSchema: Schema.Schema<A, I, R>) =>
  Schema.Struct({ status: Schema.Literal('success'), data: dataSchema });

const ApiResponseStatus = Schema.Struct({
  status: Schema.Union(Schema.Literal('success'), Schema.Literal('error')),
});

const ApiResponseError = Schema.Struct({
  status: Schema.Literal('error'),
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

// User
export const UserSchema = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  isPremium: Schema.Boolean,
  isSubscribed: Schema.Boolean,
  isTrial: Schema.Boolean,
  premiumUntil: Schema.Union(Schema.Number, Schema.String),
  lang: Schema.String,
  preferedDomain: Schema.String,
  fidelityPoints: Schema.Number,
  limitedHostersQuotas: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  notifications: Schema.Array(Schema.String),
});
export type $UserInfo = Schema.Schema.Type<typeof UserSchema>;

// Hosts (v4.1 returns object keyed by host name)
export const HostEntrySchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  domains: Schema.Array(Schema.String),
  regexp: Schema.optional(Schema.String),
  regexps: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(Schema.Boolean),
});
export const HostsResponseSchema = Schema.Struct({
  hosts: Schema.Record({ key: Schema.String, value: HostEntrySchema }),
});
export type $Hosts = Array<Schema.Schema.Type<typeof HostEntrySchema>>;

// Add magnet response: data.magnets[] with id, ready, hash, magnet, name, size
export const MagnetUploadItemSchema = Schema.Struct({
  id: Schema.Number,
  magnet: Schema.optional(Schema.String),
  hash: Schema.String,
  name: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  ready: Schema.optional(Schema.Boolean),
  error: Schema.optional(
    Schema.Struct({ code: Schema.String, message: Schema.String })
  ),
});
export const AddMagnetResponseSchema = Schema.Struct({
  magnets: Schema.Array(MagnetUploadItemSchema),
});
export type $AddMagnetOrTorrent = { readonly id: string; readonly uri: string };

// Upload file response: data.files[]
export const FileUploadItemSchema = Schema.Struct({
  id: Schema.Number,
  file: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  ready: Schema.optional(Schema.Boolean),
  error: Schema.optional(
    Schema.Struct({ code: Schema.String, message: Schema.String })
  ),
});
export const AddTorrentResponseSchema = Schema.Struct({
  files: Schema.Array(FileUploadItemSchema),
});

const NumberFromApi = Schema.Union(Schema.Number, Schema.NumberFromString);

// Magnet status (v4.1): data.magnets[] with statusCode (4 = Ready)
export const MagnetStatusItemSchema = Schema.Struct({
  id: NumberFromApi,
  filename: Schema.optional(Schema.String),
  size: Schema.optional(NumberFromApi),
  status: Schema.optional(Schema.String),
  statusCode: NumberFromApi,
});
export const MagnetStatusResponseSchema = Schema.Struct({
  magnets: Schema.Union(
    Schema.Array(MagnetStatusItemSchema),
    MagnetStatusItemSchema
  ),
});

/** Node in the AllDebrid files tree. */
type FileNode = {
  readonly n: string;
  readonly s?: number;
  readonly l?: string;
  readonly e?: ReadonlyArray<FileNode>;
};

const FileNodeSchema: Schema.Schema<FileNode> = Schema.suspend(() =>
  Schema.Struct({
    n: Schema.String,
    s: Schema.optional(Schema.Number),
    l: Schema.optional(Schema.String),
    e: Schema.optional(Schema.Array(FileNodeSchema)),
  })
);

// Magnet files: data.magnets[] with id and files[]
export const MagnetFilesMagnetSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
  files: Schema.optional(Schema.Array(FileNodeSchema)),
  error: Schema.optional(
    Schema.Struct({ code: Schema.String, message: Schema.String })
  ),
});
export const MagnetFilesResponseSchema = Schema.Struct({
  magnets: Schema.Array(MagnetFilesMagnetSchema),
});

export type $AllDebridTorrentInfo = {
  readonly links: string[];
  readonly files: Array<{
    readonly link: string;
    readonly name: string;
    readonly size?: number;
  }>;
};

// Link unlock: when delayed is present, link may not be returned.
export const UnrestrictLinkResponseSchema = Schema.Struct({
  link: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  filesize: Schema.optional(Schema.Number),
  host: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  delayed: Schema.optional(Schema.Number),
}).pipe(
  Schema.filter(
    (data) => data.link !== undefined || data.delayed !== undefined,
    {
      message: () =>
        'Either link or delayed must be present in unlock response',
    }
  )
);
export type $UnrestrictLink = {
  readonly link: string;
  readonly filename?: string;
  readonly filesize?: number;
  readonly download?: string;
};

// Delayed link status response: status (1=processing, 2=ready, 3=error)
export const DelayedLinkResponseSchema = Schema.Struct({
  status: Schema.Union(Schema.Literal(1), Schema.Literal(2), Schema.Literal(3)),
  time_left: Schema.Number,
  link: Schema.optional(Schema.String),
});
export type $DelayedLinkStatus = Schema.Schema.Type<
  typeof DelayedLinkResponseSchema
>;

export type AllDebridClientError =
  | HttpError
  | DebridApiError
  | DebridAuthError
  | DebridResponseError
  | DebridTimeoutError;

const decodeUnknown =
  <A, I>(schema: Schema.Schema<A, I>, endpoint: string) =>
  (input: unknown): Effect.Effect<A, DebridResponseError> =>
    Schema.decodeUnknown(schema)(input).pipe(
      Effect.mapError(
        (cause) =>
          new DebridResponseError({
            service: SERVICE,
            endpoint,
            message: `Invalid AllDebrid API response from ${endpoint}`,
            cause,
          })
      )
    );

/** Parses the response envelope and decodes its payload at the client seam. */
const checkResponse = <A, I>(
  response: AxiosResponse<unknown>,
  dataSchema: Schema.Schema<A, I>,
  endpoint: string
): Effect.Effect<A, DebridApiError | DebridAuthError | DebridResponseError> =>
  Effect.gen(function* () {
    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        new DebridAuthError({
          service: SERVICE,
          message: `${SERVICE} authentication failed`,
        })
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const parsed = Option.getOrUndefined(
        Schema.decodeUnknownOption(ApiResponseError)(response.data)
      );
      return yield* Effect.fail(
        new DebridApiError({
          service: SERVICE,
          message:
            parsed?.error.message ??
            `AllDebrid request failed with status ${response.status}`,
          apiCode: parsed?.error.code,
          statusCode: response.status,
        })
      );
    }

    const status = yield* decodeUnknown(
      ApiResponseStatus,
      endpoint
    )(response.data);
    if (status.status === 'error') {
      const parsed = yield* decodeUnknown(
        ApiResponseError,
        endpoint
      )(response.data);
      return yield* Effect.fail(
        new DebridApiError({
          service: SERVICE,
          message: parsed.error.message,
          apiCode: parsed.error.code,
          statusCode: response.status,
        })
      );
    }

    const parsed = yield* decodeUnknown(
      ApiResponseSuccess(dataSchema),
      endpoint
    )(response.data);
    return parsed.data;
  });

/** Recursively collects all direct file links from an AllDebrid files tree. */
const collectLinks = (
  nodes: ReadonlyArray<FileNode>
): Array<{ link: string; name: string; size?: number }> => {
  const output: Array<{ link: string; name: string; size?: number }> = [];
  for (const node of nodes) {
    if (node.l) output.push({ link: node.l, name: node.n, size: node.s });
    if (node.e) output.push(...collectLinks(node.e));
  }
  return output;
};

export interface AllDebridClient {
  readonly getUserInfo: () => Effect.Effect<$UserInfo, AllDebridClientError>;
  readonly getHosts: () => Effect.Effect<$Hosts, AllDebridClientError>;
  readonly addMagnet: (
    magnet: string,
    host?: string
  ) => Effect.Effect<$AddMagnetOrTorrent, AllDebridClientError>;
  readonly addTorrent: (
    torrent: ReadStream
  ) => Effect.Effect<$AddMagnetOrTorrent, AllDebridClientError>;
  readonly getMagnetStatus: (
    id: string
  ) => Effect.Effect<{ readonly statusCode: number }, AllDebridClientError>;
  readonly isTorrentReady: (
    id: string
  ) => Effect.Effect<boolean, AllDebridClientError>;
  readonly getMagnetFiles: (
    id: string
  ) => Effect.Effect<$AllDebridTorrentInfo, AllDebridClientError>;
  readonly unrestrictLink: (
    link: string,
    password?: string
  ) => Effect.Effect<$UnrestrictLink, AllDebridClientError>;
}

export class AllDebridClientResource extends Context.Tag(
  'all-debrid-js/AllDebridClient'
)<AllDebridClientResource, AllDebridClient>() {}

/** Client for the AllDebrid API (v4 / v4.1). */
export default class AllDebrid implements AllDebridClient {
  constructor(public readonly configuration: AllDebridConfiguration) {}

  private headers(): { readonly Authorization: string } {
    return { Authorization: `Bearer ${this.configuration.apiKey}` };
  }

  private request(
    url: string,
    request: () => Promise<AxiosResponse<unknown>>
  ): Effect.Effect<AxiosResponse<unknown>, HttpError> {
    return Effect.tryPromise({
      try: request,
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

  /** Fetches the current user's account info. */
  public getUserInfo(): Effect.Effect<$UserInfo, AllDebridClientError> {
    const url = `${BASE_V4}/user`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.get(url, {
          headers: this.headers(),
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(
        response,
        Schema.Struct({ user: UserSchema }),
        url
      );
      return data.user;
    });
  }

  /** Returns the currently supported hosts. */
  public getHosts(): Effect.Effect<$Hosts, AllDebridClientError> {
    const url = `${BASE_V4_1}/user/hosts`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.get(url, {
          headers: this.headers(),
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(response, HostsResponseSchema, url);
      return Object.values(data.hosts);
    });
  }

  /** Adds a magnet and returns its AllDebrid id. */
  public addMagnet(
    magnet: string,
    _host?: string
  ): Effect.Effect<$AddMagnetOrTorrent, AllDebridClientError> {
    const url = `${BASE_V4}/magnet/upload`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.post(url, new URLSearchParams({ 'magnets[]': magnet }), {
          headers: {
            ...this.headers(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(response, AddMagnetResponseSchema, url);
      const first = data.magnets[0];
      if (!first || first.error) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message: first?.error?.message ?? 'No magnet returned',
            apiCode: first?.error?.code,
          })
        );
      }
      return { id: String(first.id), uri: first.magnet ?? magnet };
    });
  }

  /** Uploads a torrent file and returns its AllDebrid id and magnet URI. */
  public addTorrent(
    torrent: ReadStream
  ): Effect.Effect<$AddMagnetOrTorrent, AllDebridClientError> {
    const url = `${BASE_V4}/magnet/upload/file`;
    return Effect.gen(this, function* () {
      const form = yield* Effect.try({
        try: () => {
          const body = new FormData();
          body.append('files[]', torrent, { filename: 'file.torrent' });
          return body;
        },
        catch: (cause) =>
          new DebridApiError({
            service: SERVICE,
            message: `Unable to prepare torrent upload: ${String(cause)}`,
          }),
      });
      const response = yield* this.request(url, () =>
        axios.post(url, form, {
          headers: { ...this.headers(), ...form.getHeaders() },
          validateStatus: () => true,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        })
      );
      const data = yield* checkResponse(
        response,
        AddTorrentResponseSchema,
        url
      );
      const first = data.files[0];
      if (!first || first.error) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message: first?.error?.message ?? 'No file returned',
            apiCode: first?.error?.code,
          })
        );
      }
      if (!first.hash) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message: 'Torrent upload did not return a hash',
          })
        );
      }
      return { id: String(first.id), uri: `magnet:?xt=urn:btih:${first.hash}` };
    });
  }

  /** Gets magnet status. statusCode 4 means ready. */
  public getMagnetStatus(
    id: string
  ): Effect.Effect<{ readonly statusCode: number }, AllDebridClientError> {
    const url = `${BASE_V4_1}/magnet/status`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.post(url, new URLSearchParams({ id }), {
          headers: {
            ...this.headers(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(
        response,
        MagnetStatusResponseSchema,
        url
      );
      const magnet = Array.isArray(data.magnets)
        ? data.magnets[0]
        : data.magnets;
      if (!magnet) {
        return yield* Effect.fail(
          new DebridApiError({ service: SERVICE, message: 'Magnet not found' })
        );
      }
      return { statusCode: magnet.statusCode };
    });
  }

  /** Returns whether a magnet/torrent is ready for download. */
  public isTorrentReady(
    id: string
  ): Effect.Effect<boolean, AllDebridClientError> {
    return Effect.gen(this, function* () {
      const { statusCode } = yield* this.getMagnetStatus(id);
      return statusCode === 4;
    });
  }

  /** Gets the files and direct links for a magnet. */
  public getMagnetFiles(
    id: string
  ): Effect.Effect<$AllDebridTorrentInfo, AllDebridClientError> {
    const url = `${BASE_V4}/magnet/files`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.post(url, new URLSearchParams({ 'id[]': id }), {
          headers: {
            ...this.headers(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(
        response,
        MagnetFilesResponseSchema,
        url
      );
      const magnet = data.magnets[0];
      if (!magnet || magnet.error) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message: magnet?.error?.message ?? 'Magnet files not found',
            apiCode: magnet?.error?.code,
          })
        );
      }
      const files = magnet.files ? collectLinks(magnet.files) : [];
      return { links: files.map((file) => file.link), files };
    });
  }

  private getDelayedLink(
    delayedId: number
  ): Effect.Effect<string | null, AllDebridClientError> {
    const url = `${BASE_V4}/link/delayed`;
    return Effect.gen(this, function* () {
      const response = yield* this.request(url, () =>
        axios.post(url, new URLSearchParams({ id: String(delayedId) }), {
          headers: {
            ...this.headers(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(
        response,
        DelayedLinkResponseSchema,
        url
      );

      if (data.status === 2) {
        if (!data.link) {
          return yield* Effect.fail(
            new DebridApiError({
              service: SERVICE,
              message: 'Delayed link is ready but no link was returned',
            })
          );
        }
        return data.link;
      }
      if (data.status === 3) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message: `Failed to generate delayed link (time_left: ${data.time_left})`,
          })
        );
      }
      return null;
    });
  }

  /** Unlocks a link, polling Effectfully when AllDebrid returns a delayed id. */
  public unrestrictLink(
    link: string,
    password = ''
  ): Effect.Effect<$UnrestrictLink, AllDebridClientError> {
    const url = `${BASE_V4}/link/unlock`;
    return Effect.gen(this, function* () {
      const params = new URLSearchParams({ link });
      if (password) params.append('password', password);

      const response = yield* this.request(url, () =>
        axios.post(url, params, {
          headers: {
            ...this.headers(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          validateStatus: () => true,
        })
      );
      const data = yield* checkResponse(
        response,
        UnrestrictLinkResponseSchema,
        url
      );

      if (data.link) {
        return {
          link: data.link,
          filename: data.filename,
          filesize: data.filesize,
          download: data.link,
        };
      }

      if (data.delayed === undefined) {
        return yield* Effect.fail(
          new DebridApiError({
            service: SERVICE,
            message:
              'Unlock response contained neither a link nor a delayed id',
          })
        );
      }

      for (let attempt = 0; attempt < 60; attempt += 1) {
        const delayedLink = yield* this.getDelayedLink(data.delayed);
        if (delayedLink !== null) {
          return {
            link: delayedLink,
            filename: data.filename,
            filesize: data.filesize,
            download: delayedLink,
          };
        }
        yield* Effect.sleep('5 seconds');
      }

      return yield* Effect.fail(
        new DebridTimeoutError({
          service: SERVICE,
          operation: 'unlock delayed link',
          timeoutMs: 300_000,
          message: `${SERVICE} timed out while unlocking a delayed link`,
        })
      );
    });
  }
}

export const makeAllDebridClient = (
  configuration: AllDebridConfiguration
): AllDebridClient => new AllDebrid(configuration);

export const AllDebridClientLayer = (
  configuration: AllDebridConfiguration
): Layer.Layer<AllDebridClientResource> =>
  Layer.succeed(AllDebridClientResource, makeAllDebridClient(configuration));

const runLegacyPromise = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

/** Promise adapter for consumers that have not migrated to Effect. */
export class LegacyAllDebridPromiseClient {
  private readonly client: AllDebridClient;

  constructor(configuration: AllDebridConfiguration) {
    this.client = makeAllDebridClient(configuration);
  }

  public getUserInfo(): Promise<$UserInfo> {
    return runLegacyPromise(this.client.getUserInfo());
  }

  public getHosts(): Promise<$Hosts> {
    return runLegacyPromise(this.client.getHosts());
  }

  public addMagnet(
    magnet: string,
    host?: string
  ): Promise<$AddMagnetOrTorrent> {
    return runLegacyPromise(this.client.addMagnet(magnet, host));
  }

  public addTorrent(torrent: ReadStream): Promise<$AddMagnetOrTorrent> {
    return runLegacyPromise(this.client.addTorrent(torrent));
  }

  public getMagnetStatus(id: string): Promise<{ readonly statusCode: number }> {
    return runLegacyPromise(this.client.getMagnetStatus(id));
  }

  public isTorrentReady(id: string): Promise<boolean> {
    return runLegacyPromise(this.client.isTorrentReady(id));
  }

  public getMagnetFiles(id: string): Promise<$AllDebridTorrentInfo> {
    return runLegacyPromise(this.client.getMagnetFiles(id));
  }

  public unrestrictLink(
    link: string,
    password?: string
  ): Promise<$UnrestrictLink> {
    return runLegacyPromise(this.client.unrestrictLink(link, password));
  }
}
