import z from 'zod';
import axios from 'axios';
import { ReadStream } from 'fs';

export interface RealDebridConfiguration {
  apiKey: string;
}

export const UnrestrictLinkZod = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  filesize: z.number(),
  link: z.string(),
  host: z.string(),
  chunks: z.number(),
  crc: z.number(),
  download: z.string(),
  streamable: z.number(),
});

export const UserInfoZod = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string(),
  points: z.number(),
  locale: z.string(),
  avatar: z.string(),
  type: z.string(),
  premium: z.number(),
  expiration: z.string(),
});

export const HostsZod = z.object({
  host: z.string(),
  max_file_size: z.number(),
});

export const AddTorrentOrMagnetZod = z.object({
  id: z.string(),
  uri: z.string().url(),
});

export const TorrentInfoZod = z.object({
  status: z.enum([
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
    'dead',
  ]),
  id: z.string(),
  filename: z.string(),
  hash: z.string(),
  bytes: z.number(),
  host: z.string(),
  split: z.number(),
  progress: z.number(),
  added: z.string(),
  links: z.array(z.string()),
  seeders: z.number().optional(),
  original_filename: z.string().optional(),
  original_bytes: z.number().optional(),
  files: z
    .array(
      z.object({
        id: z.number(),
        path: z.string(),
        bytes: z.number(),
        selected: z.number(),
      })
    )
    .optional(),
  ended: z.string().optional(),
  speed: z.number().optional(),
});

export type $Hosts = z.infer<typeof HostsZod>;
export type $UnrestrictLink = z.infer<typeof UnrestrictLinkZod>;
export type $UserInfo = z.infer<typeof UserInfoZod>;
export type $AddTorrentOrMagnet = z.infer<typeof AddTorrentOrMagnetZod>;
export type $TorrentInfo = z.infer<typeof TorrentInfoZod>;

const REAL_DEBRID_API_URL = 'https://api.real-debrid.com/rest/1.0';
export default class RealDebrid {
  constructor(public configuration: RealDebridConfiguration) {}

  public async getUserInfo() {
    const response = await axios(`${REAL_DEBRID_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
      },
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      const errorMessage =
        response.data?.error ||
        `Failed to fetch user info: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    const result = UserInfoZod.parse(response.data);

    return result;
  }

  public async unrestrictLink(link: string, password: string = '') {
    const formData = new URLSearchParams();
    formData.append('link', link);
    formData.append('password', password);
    const response = await axios(`${REAL_DEBRID_API_URL}/unrestrict/link`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: formData,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      const errorMessage =
        response.data?.error ||
        `Failed to unrestrict link: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    const result = UnrestrictLinkZod.parse(response.data);
    return result;
  }

  public async addTorrent(torrent: ReadStream, host?: string) {
    // set the type to binary
    const url = new URL(`${REAL_DEBRID_API_URL}/torrents/addTorrent`);
    if (host) {
      url.searchParams.append('host', host);
    }
    const response = await axios(url.toString(), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      data: torrent,
      validateStatus: () => true,
    });
    if (response.status !== 201) {
      const errorMessage =
        response.data?.error || `Failed to add torrent: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    torrent.close();
    const result = AddTorrentOrMagnetZod.parse(response.data);
    return result;
  }

  public async getTorrentInfo(id: string) {
    const response = await axios(`${REAL_DEBRID_API_URL}/torrents/info/${id}`, {
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
      },
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      const errorMessage =
        response.data?.error ||
        `Failed to fetch torrent info: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    const result = TorrentInfoZod.parse(response.data);
    return result;
  }

  public async addMagnet(magnet: string, host?: string) {
    const formData = new URLSearchParams();
    formData.append('magnet', magnet);
    if (host) {
      formData.append('host', host);
    }
    const response = await axios(`${REAL_DEBRID_API_URL}/torrents/addMagnet`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: formData,
      validateStatus: () => true,
    });
    if (response.status !== 201) {
      const errorMessage =
        response.data?.error || `Failed to add magnet: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    const result = AddTorrentOrMagnetZod.parse(response.data);
    return result;
  }

  public async selectTorrents(id: string): Promise<boolean> {
    const formData = new URLSearchParams();
    formData.append('files', 'all');
    const response = await axios(
      `${REAL_DEBRID_API_URL}/torrents/selectFiles/` + id,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.configuration.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: formData,
        validateStatus: () => true,
      }
    );
    if (response.status === 200 || response.status === 204) {
      return true;
    }
    const errorMessage =
      response.data?.error || `Failed to select files: ${response.statusText}`;
    const errorCode = response.data?.error_code;
    throw new Error(
      errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
    );
  }

  public async isTorrentReady(id: string) {
    const torrentInfo = await this.getTorrentInfo(id);
    return torrentInfo.status === 'downloaded';
  }

  public async getHosts() {
    const response = await axios.get(
      `${REAL_DEBRID_API_URL}/torrents/availableHosts`,
      {
        headers: {
          Authorization: `Bearer ${this.configuration.apiKey}`,
        },
        validateStatus: () => true,
      }
    );
    if (response.status !== 200) {
      const errorMessage =
        response.data?.error || `Failed to fetch hosts: ${response.statusText}`;
      const errorCode = response.data?.error_code;
      throw new Error(
        errorCode ? `${errorMessage} (error_code: ${errorCode})` : errorMessage
      );
    }
    const result = HostsZod.array().parse(response.data);
    return result;
  }
}
