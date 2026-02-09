import z from 'zod';
import axios from 'axios';
import { ReadStream } from 'fs';
import FormData from 'form-data';

const BASE_V4 = 'https://api.alldebrid.com/v4';
const BASE_V4_1 = 'https://api.alldebrid.com/v4.1';

/** Configuration for the AllDebrid API client (API key). */
export interface AllDebridConfiguration {
  apiKey: string;
}

// Generic API response wrapper
const ApiResponseSuccess = <T>(dataSchema: z.ZodType<T>) =>
  z.object({ status: z.literal('success'), data: dataSchema });
const ApiResponseError = z.object({
  status: z.literal('error'),
  error: z.object({ code: z.string(), message: z.string() }),
});

// User
export const UserZod = z.object({
  username: z.string(),
  email: z.string(),
  isPremium: z.boolean(),
  isSubscribed: z.boolean(),
  isTrial: z.boolean(),
  premiumUntil: z.union([z.number(), z.string()]),
  lang: z.string(),
  preferedDomain: z.string(),
  fidelityPoints: z.number(),
  limitedHostersQuotas: z.record(z.unknown()).optional(),
  notifications: z.array(z.string()),
});
export type $UserInfo = z.infer<typeof UserZod>;

// Hosts (v4.1 returns object keyed by host name)
export const HostEntryZod = z.object({
  name: z.string(),
  type: z.string(),
  domains: z.array(z.string()),
  regexp: z.string().optional(),
  regexps: z.array(z.string()).optional(),
  status: z.boolean().optional(),
});
export const HostsResponseZod = z.object({ hosts: z.record(HostEntryZod) });
export type $Hosts = z.infer<typeof HostEntryZod>[];

// Add magnet response: data.magnets[] with id, ready, hash, magnet, name, size
export const MagnetUploadItemZod = z
  .object({
    id: z.number(),
    magnet: z.string().optional(),
    hash: z.string(),
    name: z.string().optional(),
    size: z.number().optional(),
    ready: z.boolean().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .passthrough();
export const AddMagnetResponseZod = z.object({
  magnets: z.array(MagnetUploadItemZod),
});
export type $AddMagnetOrTorrent = { id: string; uri: string };

// Upload file response: data.files[]
export const FileUploadItemZod = z
  .object({
    id: z.number(),
    file: z.string().optional(),
    name: z.string().optional(),
    hash: z.string().optional(),
    size: z.number().optional(),
    ready: z.boolean().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .passthrough();
export const AddTorrentResponseZod = z.object({
  files: z.array(FileUploadItemZod),
});

// Magnet status (v4.1): data.magnets[] with statusCode (4 = Ready)
export const MagnetStatusItemZod = z
  .object({
    id: z.coerce.number(),
    filename: z.string().optional(),
    size: z.coerce.number().optional(),
    status: z.string().optional(),
    statusCode: z.coerce.number(),
  })
  .passthrough();
export const MagnetStatusResponseZod = z
  .object({
    magnets: z.union([z.array(MagnetStatusItemZod), MagnetStatusItemZod]),
  })
  .passthrough();

// Magnet files: data.magnets[] with id and files[]; each file: n (name), s (size), l (link), e (entries for folders)
const FileNodeZod: z.ZodType<{
  n: string;
  s?: number;
  l?: string;
  e?: z.infer<typeof FileNodeZod>[];
}> = z.lazy(() =>
  z.object({
    n: z.string(),
    s: z.number().optional(),
    l: z.string().optional(),
    e: z.array(FileNodeZod).optional(),
  })
);
export const MagnetFilesMagnetZod = z
  .object({
    id: z.union([z.string(), z.number()]),
    files: z.array(FileNodeZod).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .passthrough();
export const MagnetFilesResponseZod = z.object({
  magnets: z.array(MagnetFilesMagnetZod),
});

export type $AllDebridTorrentInfo = {
  links: string[];
  files: { link: string; name: string; size?: number }[];
};

// Link unlock: data.link, data.filename, data.filesize (API may return more fields)
// When delayed is present, link may not be returned (delayed link flow)
export const UnrestrictLinkResponseZod = z
  .object({
    link: z.string().optional(),
    filename: z.string().optional(),
    filesize: z.number().optional(),
    host: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    delayed: z.number().optional(),
  })
  .passthrough()
  .refine((data) => data.link !== undefined || data.delayed !== undefined, {
    message: 'Either link or delayed must be present in unlock response',
  });
export type $UnrestrictLink = {
  link: string;
  filename?: string;
  filesize?: number;
  download?: string;
};

// Delayed link status response: status (1=processing, 2=ready, 3=error), time_left, optional link
export const DelayedLinkResponseZod = z.object({
  status: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  time_left: z.number(),
  link: z.string().optional(),
});
export type $DelayedLinkStatus = z.infer<typeof DelayedLinkResponseZod>;

/**
 * Parses and validates an API response; throws on error status or invalid shape.
 * @param response - Axios response with data
 * @param dataSchema - Zod schema for the success payload
 * @returns Validated data on success
 */
function checkResponse<T>(
  response: { data: unknown },
  dataSchema: z.ZodType<T>
): T {
  const successSchema = ApiResponseSuccess(dataSchema);
  const errorSchema = ApiResponseError;

  if (
    response.data &&
    typeof response.data === 'object' &&
    'status' in response.data
  ) {
    const status = (response.data as any).status;
    if (status === 'error') {
      const parsed = errorSchema.safeParse(response.data);
      if (parsed.success) {
        throw new Error(
          `${parsed.data.error.message} (${parsed.data.error.code})`
        );
      }
    } else if (status === 'success') {
      const parsed = successSchema.safeParse(response.data);
      if (parsed.success) {
        return parsed.data.data as T;
      }
      // Include Zod validation error details
      throw new Error(
        `Invalid API response: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        { cause: response.data }
      );
    }
  }
  throw new Error('Invalid API response', { cause: response.data });
}

/** Node in AllDebrid files tree: n (name), s (size), l (link), e (children). */
type Node = { n: string; s?: number; l?: string; e?: Node[] };

/**
 * Recursively collect all direct file links from AllDebrid files tree (n, s, l, e).
 */
function collectLinks(
  nodes: Node[]
): { link: string; name: string; size?: number }[] {
  const out: { link: string; name: string; size?: number }[] = [];
  for (const node of nodes) {
    if (node.l) out.push({ link: node.l, name: node.n, size: node.s });
    if (node.e) out.push(...collectLinks(node.e));
  }
  return out;
}

/**
 * Client for the AllDebrid API (v4 / v4.1). Handles user info, hosts, magnet/torrent upload,
 * status polling, file links, and link unrestrict.
 */
export default class AllDebrid {
  /** Creates an AllDebrid API client with the given configuration (API key). */
  constructor(public configuration: AllDebridConfiguration) {}

  /** Returns auth headers for API requests. */
  private headers() {
    return { Authorization: `Bearer ${this.configuration.apiKey}` };
  }

  /** Fetches the current user's account info (username, premium status, etc.). */
  public async getUserInfo(): Promise<$UserInfo> {
    const response = await axios.get(`${BASE_V4}/user`, {
      headers: this.headers(),
      validateStatus: () => true,
    });
    const data = checkResponse(response, z.object({ user: UserZod }));
    return data.user;
  }

  /**
   * Returns a minimal list so callers that pass "host" to addMagnet still work. AllDebrid does not use host for magnet upload.
   */
  public async getHosts(): Promise<$Hosts> {
    const response = await axios.get(`${BASE_V4_1}/user/hosts`, {
      headers: this.headers(),
      validateStatus: () => true,
    });
    const data = checkResponse(response, HostsResponseZod);
    return Object.values(data.hosts);
  }

  /**
   * Add magnet. Returns { id, uri } shape for compatibility with Real-Debrid usage. Id is string.
   */
  public async addMagnet(
    magnet: string,
    _host?: string
  ): Promise<$AddMagnetOrTorrent> {
    const response = await axios.post(
      `${BASE_V4}/magnet/upload`,
      new URLSearchParams({ 'magnets[]': magnet }),
      {
        headers: {
          ...this.headers(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      }
    );
    const data = checkResponse(response, AddMagnetResponseZod);
    const first = data.magnets[0];
    if (!first || first.error) {
      throw new Error(first?.error?.message ?? 'No magnet returned');
    }
    return { id: String(first.id), uri: first.magnet ?? magnet };
  }

  /**
   * Upload torrent file (multipart). Returns { id, uri } shape. Id is string.
   */
  public async addTorrent(torrent: ReadStream): Promise<$AddMagnetOrTorrent> {
    const form = new FormData();
    form.append('files[]', torrent as any, { filename: 'file.torrent' });
    const response = await axios.post(`${BASE_V4}/magnet/upload/file`, form, {
      headers: { ...this.headers(), ...form.getHeaders() },
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    const data = checkResponse(response, AddTorrentResponseZod);
    const first = data.files[0];
    if (!first || first.error) {
      throw new Error(first?.error?.message ?? 'No file returned');
    }
    if (!first.hash) {
      throw new Error('Torrent upload did not return a hash');
    }
    return { id: String(first.id), uri: `magnet:?xt=urn:btih:${first.hash}` };
  }

  /**
   * Get magnet status. statusCode 4 = Ready.
   */
  public async getMagnetStatus(id: string): Promise<{ statusCode: number }> {
    const response = await axios.post(
      `${BASE_V4_1}/magnet/status`,
      new URLSearchParams({ id }),
      {
        headers: {
          ...this.headers(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      }
    );
    const data = checkResponse(response, MagnetStatusResponseZod);
    // API returns object when querying single magnet, array when querying all
    const magnet = Array.isArray(data.magnets) ? data.magnets[0] : data.magnets;
    if (!magnet) throw new Error('Magnet not found');
    return { statusCode: magnet.statusCode };
  }

  /** Returns true when the magnet/torrent is ready for download (statusCode 4). */
  public async isTorrentReady(id: string): Promise<boolean> {
    const { statusCode } = await this.getMagnetStatus(id);
    return statusCode === 4;
  }

  /**
   * Get files/links for a magnet. Returns { links: string[], files: { link, name, size }[] }.
   * Uses first file link if no filename match; callers can pick by result.filename or take first.
   */
  public async getMagnetFiles(id: string): Promise<$AllDebridTorrentInfo> {
    const response = await axios.post(
      `${BASE_V4}/magnet/files`,
      new URLSearchParams({ 'id[]': id }),
      {
        headers: {
          ...this.headers(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      }
    );
    const data = checkResponse(response, MagnetFilesResponseZod);
    const magnet = data.magnets[0];
    if (!magnet || magnet.error) {
      throw new Error(magnet?.error?.message ?? 'Magnet files not found');
    }
    const files = magnet.files ? collectLinks(magnet.files) : [];
    const links = files.map((f) => f.link).filter(Boolean);
    return { links, files };
  }

  /**
   * Check status of a delayed link. Returns the link when ready (status 2), null when still processing (status 1),
   * or throws when error (status 3).
   * @param delayedId - The delayed ID from link/unlock response
   * @returns Link string when ready, null when still processing
   * @throws Error when status is 3 (error) or API call fails
   */
  private async getDelayedLink(delayedId: number): Promise<string | null> {
    const response = await axios.post(
      `${BASE_V4}/link/delayed`,
      new URLSearchParams({ id: String(delayedId) }),
      {
        headers: {
          ...this.headers(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      }
    );
    const data = checkResponse(response, DelayedLinkResponseZod);

    if (data.status === 2) {
      // Ready - link is available
      if (!data.link) {
        throw new Error(
          'Delayed link status is ready but no link was returned'
        );
      }
      return data.link;
    } else if (data.status === 3) {
      // Error - could not generate download link
      throw new Error(
        `Failed to generate delayed link (status: ${data.status}, time_left: ${data.time_left})`
      );
    } else if (data.status === 1) {
      // Still processing
      return null;
    } else {
      throw new Error(`Unexpected delayed link status: ${data.status}`);
    }
  }

  /**
   * Unrestrict a link. Returns shape compatible with app: { link, download?, filename, filesize }.
   * AllDebrid returns data.link as the direct download URL, or data.delayed if the link needs time to generate.
   * When delayed is present, polls /link/delayed until the link is ready.
   */
  public async unrestrictLink(
    link: string,
    password: string = ''
  ): Promise<$UnrestrictLink> {
    const params = new URLSearchParams({ link });
    if (password) params.append('password', password);
    const response = await axios.post(`${BASE_V4}/link/unlock`, params, {
      headers: {
        ...this.headers(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });
    const data = checkResponse(response, UnrestrictLinkResponseZod) as z.infer<
      typeof UnrestrictLinkResponseZod
    >;

    // If link is immediately available, return it
    if (data.link) {
      return {
        link: data.link,
        filename: data.filename,
        filesize: data.filesize,
        download: data.link,
      };
    }

    // If delayed is present, poll until link is ready
    if (data.delayed !== undefined) {
      const POLL_INTERVAL_MS = 5000; // 5 seconds as per docs
      const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes timeout
      const startTime = Date.now();

      while (Date.now() - startTime < MAX_POLL_TIME_MS) {
        const delayedLink = await this.getDelayedLink(data.delayed);
        if (delayedLink !== null) {
          // Link is ready
          return {
            link: delayedLink,
            filename: data.filename,
            filesize: data.filesize,
            download: delayedLink,
          };
        }
        // Still processing, wait before next poll
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      // Timeout reached
      throw new Error(
        `Delayed link not ready after ${MAX_POLL_TIME_MS / 1000} seconds`
      );
    }

    // Neither link nor delayed present (should not happen due to schema validation)
    throw new Error(
      'Invalid unlock response: neither link nor delayed present'
    );
  }
}
