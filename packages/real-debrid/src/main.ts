import z from "zod"

export interface RealDebridConfiguration {
  apiKey: string;
}

const UnrestrictLinkZod = z.object({
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

const UserInfoZod = z.object({
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

const HostsZod = z.object({
  host: z.string().url(),
  max_file_size: z.number(),
});

const AddTorrentZod = z.object({
  id: z.string(),
  uri: z.string().url(),
});

type $Hosts = z.infer<typeof HostsZod>;
const REAL_DEBRID_API_URL = 'https://api.real-debrid.com/rest/1.0';
export default class RealDebrid {
  constructor(public configuration: RealDebridConfiguration) {}

  public async getUserInfo() {
    const response = await fetch(`${REAL_DEBRID_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.statusText}`);
    }
    const data = await response.json();
    const result = UserInfoZod.parse(data);

    return result;
  }

  public async unrestrictLink(link: string) {
    const response = await fetch(`${REAL_DEBRID_API_URL}/unrestrict/link`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ link }),
    });
    if (!response.ok) {
      throw new Error(`Failed to unrestrict link: ${response.statusText}`);
    }
    const data = await response.json();

    const result = UnrestrictLinkZod.parse(data);
    return result;
  }

  public async addMagnet(magnet: string, host: $Hosts) {
    const response = await fetch(`${REAL_DEBRID_API_URL}/torrents/addMagnet`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ magnet, host: host.host }),
    });
    if (!response.ok) {
      throw new Error(`Failed to add torrent: ${response.statusText}`);
    }
    const data = await response.json();
    const result = AddTorrentZod.parse(data);
    return result;
  }

  public async getHosts() {
    const response = await fetch(`${REAL_DEBRID_API_URL}/torrents/availableHosts`, {
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch hosts: ${response.statusText}`);
    }
    const data = await response.json();
    const result = HostsZod.parse(data);
    return result;
  }
}