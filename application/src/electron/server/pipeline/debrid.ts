import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { Debrid, type Debrided, type DebridService } from '@ogi-sdk/core';
import { DebridError, formatError } from '@ogi-sdk/errors';
import AllDebrid from 'all-debrid-js';
import axios from 'axios';
import { type Duration, Effect, Layer } from 'effect';
import type { ReadStream } from 'original-fs';
import RealDebrid from 'real-debrid-js';
import { getTorrentInfoHash } from '@/electron/lib/torrent-hash.js';
import { __dirname as dataDirectory } from '@/electron/manager/manager.paths.js';
import { runElectronEffect } from '@/electron/runtime.js';
import { Settings } from '@/electron/services/index.js';

// Each service: add the torrent, wait until it is cached, return links.
// Ported from the renderer's `lib/downloads/services/*`, minus the UI.

const debridError =
  (service: DebridService, message: string) => (cause: unknown) =>
    new DebridError({
      message: `${message}: ${formatError(cause)}`,
      service,
    });

const settings = Effect.promise(() =>
  runElectronEffect(Effect.flatMap(Settings, (s) => s.get))
);

/** Polls `ready` every `interval` until true, up to `attempts` times. */
const waitUntil = (
  service: DebridService,
  ready: Effect.Effect<boolean, DebridError>,
  attempts: number,
  interval: Duration.DurationInput
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (yield* ready) return;
      yield* Effect.sleep(interval);
    }
    return yield* new DebridError({
      message: 'Timed out waiting for the torrent to be ready.',
      service,
    });
  });

/** A `.torrent` link fetched into memory (debrid APIs take the file). */
const fetchTorrent = (service: DebridService, link: string) =>
  Effect.tryPromise({
    try: () =>
      axios
        .get<ArrayBuffer>(link, {
          responseType: 'arraybuffer',
          timeout: 60_000,
        })
        .then((response) => Buffer.from(response.data)),
    catch: debridError(service, 'Failed to download the torrent file'),
  });

/** Real-Debrid and AllDebrid upload a file stream, so stage it on disk. */
const withTorrentFile = <A>(
  service: DebridService,
  link: string,
  use: (stream: ReadStream) => Effect.Effect<A, DebridError>
) =>
  Effect.acquireUseRelease(
    fetchTorrent(service, link).pipe(
      Effect.flatMap((data) => {
        const path = join(
          dataDirectory,
          `temp-${service}-${Date.now()}.torrent`
        );
        return Effect.tryPromise({
          try: () => fsAsync.writeFile(path, data).then(() => path),
          catch: debridError(service, 'Failed to stage the torrent file'),
        });
      })
    ),
    (path) =>
      Effect.acquireUseRelease(
        Effect.sync(() => fs.createReadStream(path) as ReadStream),
        use,
        (stream) => Effect.sync(() => stream.destroy())
      ),
    (path) => Effect.promise(() => fsAsync.rm(path, { force: true }))
  );

// ---- Real-Debrid ----------------------------------------------------------

const realDebrid = (kind: 'torrent' | 'magnet', link: string) =>
  Effect.gen(function* () {
    const { debridApiKey } = yield* settings;
    if (!debridApiKey)
      return yield* new DebridError({
        message: 'Please set your Real-Debrid API key in the settings.',
        service: 'realdebrid',
      });
    const client = new RealDebrid({ apiKey: debridApiKey });
    const fail = (message: string) => debridError('realdebrid', message);
    const host = (yield* client
      .getHosts()
      .pipe(Effect.mapError(fail('Failed to load hosts'))))[0]?.host;
    const added =
      kind === 'magnet'
        ? yield* client
            .addMagnet(link, host)
            .pipe(Effect.mapError(fail('Failed to add magnet')))
        : yield* withTorrentFile('realdebrid', link, (stream) =>
            client
              .addTorrent(stream, host)
              .pipe(Effect.mapError(fail('Failed to add torrent')))
          );
    const ready = client
      .isTorrentReady(added.id)
      .pipe(Effect.mapError(fail('Failed to check torrent')));
    if (!(yield* ready)) {
      yield* client
        .selectTorrents(added.id)
        .pipe(Effect.mapError(fail('Failed to select files')));
      yield* waitUntil('realdebrid', ready, 200, '3 seconds');
    }
    const info = yield* client
      .getTorrentInfo(added.id)
      .pipe(Effect.mapError(fail('Failed to load torrent info')));
    const unrestricted = yield* client
      .unrestrictLink(info.links[0] ?? '')
      .pipe(Effect.mapError(fail('Failed to unrestrict the link')));
    return {
      zipped: false,
      files: [{ link: unrestricted.download, name: unrestricted.filename }],
    } satisfies Debrided;
  });

// ---- AllDebrid --------------------------------------------------------------

const allDebrid = (kind: 'torrent' | 'magnet', link: string) =>
  Effect.gen(function* () {
    const { alldebridApiKey } = yield* settings;
    if (!alldebridApiKey)
      return yield* new DebridError({
        message: 'Please set your AllDebrid API key in the settings.',
        service: 'alldebrid',
      });
    const client = new AllDebrid({ apiKey: alldebridApiKey });
    const fail = (message: string) => debridError('alldebrid', message);
    const added =
      kind === 'magnet'
        ? yield* client
            .addMagnet(link)
            .pipe(Effect.mapError(fail('Failed to add magnet')))
        : yield* withTorrentFile('alldebrid', link, (stream) =>
            client
              .addTorrent(stream)
              .pipe(Effect.mapError(fail('Failed to add torrent')))
          );
    yield* waitUntil(
      'alldebrid',
      client
        .isTorrentReady(added.id)
        .pipe(Effect.mapError(fail('Failed to check torrent'))),
      200,
      '3 seconds'
    );
    const info = yield* client
      .getMagnetFiles(added.id)
      .pipe(Effect.mapError(fail('Failed to load torrent files')));
    const files = yield* Effect.forEach(info.links, (fileLink, index) =>
      client.unrestrictLink(fileLink).pipe(
        Effect.mapError(fail('Failed to unrestrict a link')),
        Effect.map((unlocked) => ({
          link: unlocked.download ?? unlocked.link,
          name:
            info.files[index]?.name ?? unlocked.filename ?? `part-${index + 1}`,
        }))
      )
    );
    return { zipped: false, files } satisfies Debrided;
  });

// ---- TorBox -------------------------------------------------------------------

const TORBOX = 'https://api.torbox.app/v1/api';

const torbox = (kind: 'torrent' | 'magnet', link: string) =>
  Effect.gen(function* () {
    const { torboxApiKey } = yield* settings;
    if (!torboxApiKey)
      return yield* new DebridError({
        message: 'Please set your TorBox API key in the settings.',
        service: 'torbox',
      });
    const auth = { Authorization: `Bearer ${torboxApiKey}` };
    const fail = (message: string) => debridError('torbox', message);
    const form = new FormData();
    let hash: string;
    if (kind === 'torrent') {
      const data = yield* fetchTorrent('torbox', link);
      form.append('file', new Blob([data]));
      hash = yield* getTorrentInfoHash(data).pipe(
        Effect.mapError(fail('Failed to hash torrent'))
      );
    } else {
      form.append('magnet', link);
      hash = yield* getTorrentInfoHash(link).pipe(
        Effect.mapError(fail('Failed to hash magnet'))
      );
    }
    form.append('seed', '1');
    form.append('allow_zip', 'true');
    form.append('as_queued', 'false');
    const created = yield* Effect.tryPromise({
      try: () =>
        axios.post<{
          error: string | null;
          detail: string;
          data?: {
            queued_id?: number;
            torrent_id?: number;
            cooldown_until?: number;
          };
        }>(`${TORBOX}/torrents/createtorrent`, form, {
          headers: auth,
          validateStatus: () => true,
        }),
      catch: fail('Failed to create the TorBox torrent'),
    });
    if (created.status !== 200) {
      const detail = created.data.detail ?? '';
      return yield* new DebridError({
        service: 'torbox',
        message:
          created.data.error === 'DOWNLOAD_TOO_LARGE'
            ? 'Your current plan does not support the requested download size.'
            : detail.includes('active torrent limit of')
              ? 'You have reached your active torrent limit.'
              : detail.includes('reached your monthly download limit')
                ? 'You have reached your monthly download limit.'
                : detail || 'TorBox refused the torrent.',
      });
    }
    const data = created.data.data ?? {};
    if (data.cooldown_until)
      return yield* new DebridError({
        service: 'torbox',
        message: `You are on cooldown until ${new Date(data.cooldown_until * 1000).toLocaleString()}.`,
      });
    if (data.queued_id)
      yield* Effect.tryPromise({
        try: () =>
          axios.post(
            `${TORBOX}/queued/controlqueued`,
            { queued_id: data.queued_id, operation: 'start', all: false },
            { headers: auth }
          ),
        catch: fail('Failed to start the queued torrent'),
      });

    let torrentId = data.torrent_id;
    yield* waitUntil(
      'torbox',
      Effect.tryPromise({
        try: () =>
          axios.get<{
            success: boolean;
            data: { id: number; hash: string; download_finished: boolean }[];
          }>(`${TORBOX}/torrents/mylist?bypass_cache=true`, { headers: auth }),
        catch: fail('Failed to poll TorBox'),
      }).pipe(
        Effect.map((list) => {
          const torrent = list.data.data?.find((item) => item.hash === hash);
          if (torrent?.download_finished) torrentId = torrent.id;
          return torrent?.download_finished === true;
        })
      ),
      217,
      '3 seconds'
    );
    const url = new URL(`${TORBOX}/torrents/requestdl`);
    url.searchParams.set('token', torboxApiKey);
    url.searchParams.set('torrent_id', String(torrentId));
    url.searchParams.set('zip_link', 'true');
    url.searchParams.set('redirect', 'true');
    return {
      zipped: true,
      files: [{ link: url.toString(), name: 'download.zip' }],
    } satisfies Debrided;
  });

// ---- Premiumize ---------------------------------------------------------------

const PREMIUMIZE = 'https://www.premiumize.me/api';

const premiumize = (kind: 'torrent' | 'magnet', link: string) =>
  Effect.gen(function* () {
    const { premiumizeApiKey } = yield* settings;
    if (!premiumizeApiKey)
      return yield* new DebridError({
        message: 'Please set your Premiumize API key in the settings.',
        service: 'premiumize',
      });
    const key = `apikey=${premiumizeApiKey}`;
    const fail = (message: string) => debridError('premiumize', message);
    type Reply<A> =
      | { status: 'error'; message: string }
      | ({ status: 'success' } & A);
    // Lazy, so a poll sends a fresh request each time.
    const call = <A>(
      request: () => Promise<{ data: Reply<A> }>,
      message: string
    ) =>
      Effect.tryPromise({ try: request, catch: fail(message) }).pipe(
        Effect.flatMap(({ data }) =>
          data.status === 'error'
            ? Effect.fail(
                new DebridError({
                  message: data.message,
                  service: 'premiumize',
                })
              )
            : Effect.succeed(data)
        )
      );

    // Everything goes in one OpenGameInstaller folder, made on first use.
    const folderId = yield* call<{ id: string }>(
      () =>
        axios.post(
          `${PREMIUMIZE}/folder/create?${key}`,
          new URLSearchParams({ name: 'OpenGameInstaller' })
        ),
      'Failed to create the folder'
    ).pipe(
      Effect.map((folder) => folder.id),
      Effect.orElse(() =>
        call<{ content: { id: string; name: string }[] }>(
          () =>
            axios.get(`${PREMIUMIZE}/folder/search?${key}&q=OpenGameInstaller`),
          'Failed to find the folder'
        ).pipe(
          Effect.map(
            (found) =>
              found.content.find((item) => item.name === 'OpenGameInstaller')
                ?.id ?? ''
          )
        )
      )
    );
    const form = new FormData();
    if (kind === 'torrent')
      form.append('file', new Blob([yield* fetchTorrent('premiumize', link)]));
    else form.append('src', link);
    form.append('folder_id', folderId);
    const transfer = yield* call<{ id: string }>(
      () => axios.post(`${PREMIUMIZE}/transfer/create?${key}`, form),
      'Failed to create the transfer'
    );

    let contentFolder = '';
    yield* waitUntil(
      'premiumize',
      call<{ transfers: { id: string; status: string; folder_id: string }[] }>(
        () => axios.get(`${PREMIUMIZE}/transfer/list?${key}`),
        'Failed to check the transfer'
      ).pipe(
        Effect.map((list) => {
          const found = list.transfers.find((item) => item.id === transfer.id);
          if (found?.status === 'finished') contentFolder = found.folder_id;
          return found?.status === 'finished';
        })
      ),
      120,
      '2500 millis'
    );
    const zip = yield* call<{ location: string }>(
      () =>
        axios.post(
          `${PREMIUMIZE}/zip/generate?${key}`,
          new URLSearchParams({ 'folders[]': contentFolder })
        ),
      'Failed to generate the download'
    );
    return {
      zipped: true,
      files: [{ link: zip.location, name: 'download.zip' }],
    } satisfies Debrided;
  });

/** Core's debrid adapter: the four services, keys read from settings. */
export const DebridFromSettings = Layer.succeed(Debrid, {
  resolve: (service, kind, link) =>
    service === 'realdebrid'
      ? realDebrid(kind, link)
      : service === 'alldebrid'
        ? allDebrid(kind, link)
        : service === 'torbox'
          ? torbox(kind, link)
          : premiumize(kind, link),
});
