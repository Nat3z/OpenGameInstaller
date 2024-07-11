import z from "zod"
import axios from "axios";

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
  host: z.string().url(),
  max_file_size: z.number(),
});

export const AddTorrentOrMagnetZod = z.object({
  id: z.string(),
  uri: z.string().url(),
});

export type $Hosts = z.infer<typeof HostsZod>;
export type $UnrestrictLink = z.infer<typeof UnrestrictLinkZod>;
export type $UserInfo = z.infer<typeof UserInfoZod>;
export type $AddTorrentOrMagnet = z.infer<typeof AddTorrentOrMagnetZod>;

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
    console.log(this.configuration.apiKey)
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

  public async addTorrent(torrent: string, host: $Hosts) {
    const formData = new URLSearchParams();
    formData.append('torrent', torrent);
    formData.append('host', host.host);
    const response = await axios(`${REAL_DEBRID_API_URL}/torrents/addTorrent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: formData,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      throw new Error(`Failed to add torrent: ${response.statusText}`);
    }
    const result = AddTorrentOrMagnetZod.parse(response.data);
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
    if (response.status !== 200) {
      throw new Error(`Failed to add torrent: ${response.statusText}`);
    }
    const result = AddTorrentOrMagnetZod.parse(response.data);
    return result;
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
    const result = HostsZod.parse(response.data);
    return result;
  }
}