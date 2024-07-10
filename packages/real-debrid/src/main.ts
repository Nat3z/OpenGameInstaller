import z from "zod"

import { RequestInfo, RequestInit } from "node-fetch";

const fetch = (url: RequestInfo, init?: RequestInit) =>  import("node-fetch").then(({ default: fetch }) => fetch(url, init));
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
    const result = AddTorrentOrMagnetZod.parse(data);
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