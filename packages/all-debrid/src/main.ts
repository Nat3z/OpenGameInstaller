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
export const MagnetUploadItemZod = z.object({
  id: z.number(),
  magnet: z.string().optional(),
  hash: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  ready: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const AddMagnetResponseZod = z.object({
  magnets: z.array(MagnetUploadItemZod),
});
export type $AddMagnetOrTorrent = { id: string; uri: string };

// Upload file response: data.files[]
export const FileUploadItemZod = z.object({
  id: z.number(),
  file: z.string().optional(),
  name: z.string().optional(),
  hash: z.string().optional(),
  size: z.number().optional(),
  ready: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const AddTorrentResponseZod = z.object({
  files: z.array(FileUploadItemZod),
});

// Magnet status (v4.1): data.magnets[] with statusCode (4 = Ready)
export const MagnetStatusItemZod = z.object({
  id: z.number(),
  filename: z.string().optional(),
  size: z.number().optional(),
  status: z.string().optional(),
  statusCode: z.number(),
});
export const MagnetStatusResponseZod = z.object({
  magnets: z.array(MagnetStatusItemZod),
});

// Magnet files: data.magnets[] with id and files[]; each file: n (name), s (size), l (link), e (entries for folders)
const FileNodeZod: z.ZodType<{ n: string; s?: number; l?: string; e?: z.infer<typeof FileNodeZod>[] }> = z.lazy(() =>
  z.object({
    n: z.string(),
    s: z.number().optional(),
    l: z.string().optional(),
    e: z.array(FileNodeZod).optional(),
  })
);
export const MagnetFilesMagnetZod = z.object({
  id: z.union([z.string(), z.number()]),
  files: z.array(FileNodeZod).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const MagnetFilesResponseZod = z.object({
  magnets: z.array(MagnetFilesMagnetZod),
});

// Link unlock: data.link, data.filename, data.filesize (API may return more fields)
export const UnrestrictLinkResponseZod = z.object({
  link: z.string(),
  filename: z.string().optional(),
  filesize: z.number().optional(),
  host: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
}).passthrough();
export type $UnrestrictLink = { link: string; filename?: string; filesize?: number; download?: string };

/**
 * Parses and validates an API response; throws on error status or invalid shape.
 * @param response - Axios response with data
 * @param dataSchema - Zod schema for the success payload
 * @returns Validated data on success
 */
function checkResponse<T>(response: { data: unknown }, dataSchema: z.ZodType<T>): T {
  const successSchema = ApiResponseSuccess(dataSchema);
  const errorSchema = ApiResponseError;

  if (response.data && typeof response.data === 'object' && 'status' in response.data) {
    const status = (response.data as any).status;
    if (status === 'error') {
      const parsed = errorSchema.safeParse(response.data);
      if (parsed.success) {
        throw new Error(`${parsed.data.error.message} (${parsed.data.error.code})`);
      }
    } else if (status === 'success') {
      const parsed = successSchema.safeParse(response.data);
      if (parsed.success) {
        return parsed.data.data as T;
      }
    }
  }
  throw new Error('Invalid API response');
}

/** Node in AllDebrid files tree: n (name), s (size), l (link), e (children). */
type Node = { n: string; s?: number; l?: string; e?: Node[] };

/**
 * Recursively collect all direct file links from AllDebrid files tree (n, s, l, e).
 */
function collectLinks(nodes: Node[]): { link: string; name: string; size?: number }[] {
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
  public async addMagnet(magnet: string, _host?: string): Promise<$AddMagnetOrTorrent> {
    const response = await axios.post(
      `${BASE_V4}/magnet/upload`,
      new URLSearchParams({ 'magnets[]': magnet }),
      {
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
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
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      }
    );
    const data = checkResponse(response, MagnetStatusResponseZod);
    const magnet = data.magnets[0];
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
  public async getMagnetFiles(id: string): Promise<{ links: string[]; files: { link: string; name: string; size?: number }[] }> {
    const response = await axios.post(
      `${BASE_V4}/magnet/files`,
      new URLSearchParams({ 'id[]': id }),
      {
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
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
   * Unrestrict a link. Returns shape compatible with app: { link, download?, filename, filesize }.
   * AllDebrid returns data.link as the direct download URL.
   */
  public async unrestrictLink(link: string, password: string = ''): Promise<$UnrestrictLink> {
    const params = new URLSearchParams({ link });
    if (password) params.append('password', password);
    const response = await axios.post(`${BASE_V4}/link/unlock`, params, {
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    const data = checkResponse(response, UnrestrictLinkResponseZod);
    return {
      link: data.link,
      filename: data.filename,
      filesize: data.filesize,
      download: data.link,
    };
  }
}
