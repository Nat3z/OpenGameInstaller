import z from "zod"
import axios from "axios";
import { ReadStream } from "fs";

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
  status: z.enum(['magnet_error', 'magnet_conversion', 'waiting_files_selection', 'queued', 'downloading', 'downloaded', 'error', 'virus', 'compressing', 'uploading', 'dead']),
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
      throw new Error(`Failed to fetch user info: ${response.statusText}`);
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
      throw new Error(`Failed to unrestrict link: ${response.statusText}`);
    }
    const result = UnrestrictLinkZod.parse(response.data);
    return result;
  }

  public async addTorrent(torrent: ReadStream) {
    // set the type to binary
    const response = await axios(`${REAL_DEBRID_API_URL}/torrents/addTorrent`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      data: torrent,
      validateStatus: () => true,
    });
    if (response.status !== 201) {
      throw new Error(`Failed to add torrent: ${response.statusText}`);
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
      throw new Error(`Failed to fetch torrent info: ${response.statusText}`);
    }
    const result = TorrentInfoZod.parse(response.data);
    return result;
  }

  public async addMagnet(magnet: string, host: $Hosts) {
    const formData = new URLSearchParams();
    formData.append('magnet', magnet);
    formData.append('host', host.host);
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
      throw new Error(`Failed to add magnet: ${response.statusText}`);
    }
    const result = AddTorrentOrMagnetZod.parse(response.data);
    return result;
  }

  public async selectTorrents(id: string): Promise<boolean> {
    const formData = new URLSearchParams();
    formData.append('files', 'all');
    formData.append('check_cache', '1');
    const response = await axios(`${REAL_DEBRID_API_URL}/torrents/selectFiles/` + id, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: formData,
      validateStatus: () => true,
    });
    if (response.status === 200 || response.status === 204) {
      return true;
    }
    if (response.status !== 200) {
      throw new Error(`Failed to select files: ${response.statusText}`);
    }

    return false;
  }

  public async isTorrentReady(id: string) {
    const torrentInfo = await this.getTorrentInfo(id);
    return torrentInfo.status === 'downloaded';
  }

  public async getHosts() {
    const response = await axios.get(`${REAL_DEBRID_API_URL}/torrents/availableHosts`, {
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
      },
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch hosts: ${response.statusText}`);
    }
    const result = HostsZod.array().parse(response.data);
    return result;
  }
}