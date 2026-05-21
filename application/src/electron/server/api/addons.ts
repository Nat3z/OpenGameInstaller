import { z } from 'zod';
import { addonServer } from '@/electron/server/addon-server.js';
import { DeferrableTask } from '@ogi-sdk/addon-server';

import sanitize from 'sanitize-html';
import {
  type Procedure,
  procedure,
  ProcedureError,
  ProcedureJSON,
  ProcedureDeferTask,
} from '@/electron/server/ipc.js';
import * as fs from 'fs/promises';
import { join } from 'path';
import { restartAddonServer } from '@/electron/handlers/handler.addon.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import type {
  ConfigurationFile,
  LibraryInfo,
  SearchResult,
  StoreData,
} from '@ogi-sdk/connect';
import { ZodLibraryInfo } from 'ogi-addon';
import { supportsStorefront } from '@/lib/storefronts.js';

const procedures: Record<string, Procedure<any>> = {
  // Get all addon info
  getAllAddons: procedure()
    .input(z.object({}))
    .handler(async () => {
      let info = [];
      for (const client of addonServer.getConnections().values()) {
        if (client.addonInfo) {
          info.push({
            ...client.addonInfo,
            configTemplate: client.configTemplate,
          });
        }
      }
      return new ProcedureJSON(200, info);
    }),

  // Update addon config
  updateConfig: procedure()
    .input(
      z.object({
        addonID: z.string(),
        config: z.unknown(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      const response = await client.events.configUpdate(
        input.config as ConfigurationFile
      );
      const args = response.args as { success?: boolean; error?: unknown } | undefined;

      if (args?.success) {
        return new ProcedureJSON(200, { success: true });
      } else {
        return new ProcedureJSON(400, {
          success: false,
          errors: args?.error || 'Unknown error',
        });
      }
    }),

  // Search for games
  search: procedure()
    .input(
      z.object({
        addonID: z.string(),
        appID: z.number(),
        storefront: z.string(),
        for: z.enum(['game', 'task', 'all', 'update']),
        libraryInfo: ZodLibraryInfo.optional(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');
      if (!client.eventsAvailable.includes('search')) {
        return new ProcedureError(400, 'Client does not support search');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const event = await client.events.search({
          appID: input.appID,
          storefront: input.storefront,
          for: input.for,
          libraryInfo: input.libraryInfo as LibraryInfo,
        });
        console.log('searchComplete', event.args);
        return event.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  // Search library with query
  searchQuery: procedure()
    .input(
      z.object({
        addonID: z.string(),
        query: z.string(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      if (!client.eventsAvailable.includes('library-search')) {
        return new ProcedureError(
          400,
          'Client does not support library-search'
        );
      }

      const deferrableTask = new DeferrableTask(async () => {
        const event = await client.events.librarySearch(input.query);
        return event.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  // Request download
  requestDownload: procedure()
    .input(
      z.object({
        addonID: z.string(),
        appID: z.unknown(),
        info: z.unknown(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      if (!client.eventsAvailable.includes('request-dl')) {
        return new ProcedureError(400, 'Client does not support request-dl');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.events.requestDl(
          input.appID as number,
          input.info as SearchResult
        );
        return data.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  // Get Catalogs
  getCatalogs: procedure()
    .input(
      z.object({
        addonID: z.string(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      if (!client.eventsAvailable.includes('catalog')) {
        return new ProcedureError(400, 'Client does not support catalog');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.events.catalog();
        return data.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),
  // Setup app
  setupApp: procedure()
    .input(
      z.object({
        for: z.enum(['game', 'update']),
        currentLibraryInfo: ZodLibraryInfo.optional(),
        addonID: z.string(),
        path: z.string(),
        type: z.string(),
        name: z.string(),
        appID: z.unknown(),
        usedRealDebrid: z.boolean(),
        clearOldFilesBeforeUpdate: z.boolean().optional(),
        storefront: z.string(),
        multiPartFiles: z
          .array(
            z.object({
              name: z.string(),
              downloadURL: z.string(),
              headers: z.record(z.string(), z.string()).optional(),
            })
          )
          .optional(),
        manifest: z.unknown().optional(),
      })
    )
    .handler(async (input) => {
      console.log('setupApp', input);
      const client = addonServer.getClient(input.addonID);
      if (!client) {
        console.error('Client not found');
        return new ProcedureError(404, 'Client not found');
      }
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      if (!client.eventsAvailable.includes('setup')) {
        console.error('Client does not support setup');
        return new ProcedureError(400, 'Client does not support setup');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.events.setup({
          path: input.path,
          appID: input.appID as number,
          type: input.type as 'direct' | 'torrent' | 'magnet' | 'empty',
          usedRealDebrid: input.usedRealDebrid,
          clearOldFilesBeforeUpdate: input.clearOldFilesBeforeUpdate,
          storefront: input.storefront,
          name: input.name,
          multiPartFiles: input.multiPartFiles,
          currentLibraryInfo: input.currentLibraryInfo as LibraryInfo,
          for: input.for,
          manifest: input.manifest as Record<string, unknown>,
        });
        return data.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  // Get game details
  gameDetails: procedure()
    .input(
      z.object({
        gameID: z.string(),
        storefront: z.string(),
      })
    )
    .handler(async (input) => {
      const clientsWithStorefront = Array.from(
        addonServer.getConnections().values()
      ).filter(
        (client) =>
          supportsStorefront(client.addonInfo?.storefronts, input.storefront) &&
          client.eventsAvailable.includes('game-details')
      );
      if (clientsWithStorefront.length === 0)
        return new ProcedureError(
          404,
          'Client not found to serve this storefront'
        );

      const gameID = parseInt(input.gameID);
      const deferrableTask = new DeferrableTask(async () => {
        // find a client that can serve this storefront
        let appDetails: StoreData | undefined;
        for (const client of clientsWithStorefront) {
          const data = await client.events.gameDetails({
            appID: gameID,
            storefront: input.storefront,
          });
          if (data.args) {
            appDetails = data.args as StoreData;
            break;
          }
        }
        if (!appDetails) {
          return new ProcedureError(404, 'No app details found');
        }
        appDetails.description = sanitize(appDetails.description, {
          allowedTags: [
            'p',
            'br',
            'strong',
            'em',
            'u',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'ul',
            'ol',
            'li',
            'a',
            'img',
          ],
          allowedAttributes: {
            a: ['href', 'target'],
            img: ['src', 'alt', 'width', 'height', 'class'],
          },
        });
        return appDetails;
      }, '*');

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  deleteAddon: procedure()
    .input(z.object({ addonID: z.string() }))
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');
      if (!client.addonLink || client.addonLink.startsWith('local:')) {
        return new ProcedureError(
          400,
          'Addon was not spawned by OpenGameInstaller or is a "local:..." addon.'
        );
      }
      // time to delete the addon
      // remove the addon from the local storage
      const generalConfig = JSON.parse(
        await fs.readFile(
          join(__dirname, 'config/option/general.json'),
          'utf-8'
        )
      );
      const addons = generalConfig.addons;

      generalConfig.addons = addons.filter(
        (addon: string) => addon !== client.addonLink
      );

      await fs.writeFile(
        join(__dirname, 'config/option/general.json'),
        JSON.stringify(generalConfig, null, 2)
      );

      restartAddonServer();
      // wait for the processes to be killed
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let promises = await Promise.allSettled([
        fs.rm(client.filePath!!, {
          recursive: true,
          force: true,
        }),
        fs.rm(join(__dirname, 'config', input.addonID), {
          recursive: true,
          force: true,
        }),
      ]);
      if (promises[0].status === 'fulfilled') {
        console.log('Addon removed from addons folder');
      } else {
        console.error('Failed to remove addon from addons folder');
      }
      if (promises[1].status === 'fulfilled') {
        console.log('Addon removed from config folder');
      } else {
        console.error('Failed to remove addon from config folder');
      }

      if (promises[0].status === 'fulfilled') {
        return new ProcedureJSON(200, { success: true });
      } else {
        return new ProcedureError(500, 'Failed to remove addon');
      }
    }),

  runTask: procedure()
    .input(
      z.object({
        addonID: z.string(),
        manifest: z.unknown(),
        downloadPath: z.string().optional(),
        name: z.string().optional(),
        taskName: z.string().optional(),
        libraryInfo: ZodLibraryInfo.optional(),
      })
    )
    .handler(async (input) => {
      const client = addonServer.getClient(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.events.taskRun({
          manifest: input.manifest as Record<string, unknown>,
          downloadPath: input.downloadPath,
          name: input.name,
          taskName: input.taskName,
          deferID: deferrableTask.id!!,
          libraryInfo: input.libraryInfo as LibraryInfo,
        });
        return data.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  checkForUpdates: procedure()
    .input(
      z.object({
        appID: z.number(),
        storefront: z.string(),
        currentVersion: z.string(),
      })
    )
    .handler(async (input) => {
      const clientsWithStorefront = Array.from(
        addonServer.getConnections().values()
      ).filter(
        (client) =>
          supportsStorefront(client.addonInfo?.storefronts, input.storefront) &&
          client.eventsAvailable.includes('check-for-updates')
      );
      if (clientsWithStorefront.length === 0)
        return new ProcedureError(
          404,
          'Client not found to serve this storefront'
        );

      if (clientsWithStorefront.length > 1) {
        return new ProcedureError(
          400,
          'Multiple clients found to serve this storefront'
        );
      }
      const client = clientsWithStorefront[0];

      if (!client.addonInfo)
        return new ProcedureError(400, 'Client has no addon info');
      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.events.checkForUpdates({
          appID: input.appID,
          storefront: input.storefront,
          currentVersion: input.currentVersion,
        });
        return data.args;
      }, client.addonInfo.id);
      return new ProcedureDeferTask(200, deferrableTask);
    }),

  launchApp: procedure()
    .input(
      z.object({
        libraryInfo: ZodLibraryInfo,
        launchType: z.enum(['pre', 'post']),
      })
    )
    .handler(async (input) => {
      const clientsWithEvent = Array.from(
        addonServer.getConnections().values()
      ).filter((client) => client.eventsAvailable.includes('launch-app'));

      console.log(
        'clientsWithEvent',
        clientsWithEvent.map((client) => client.addonInfo?.name)
      );

      if (clientsWithEvent.length === 0) {
        return new ProcedureJSON(200, { success: true, results: [] });
      }

      // Fire off the event to all clients, and wait for all to finish
      const results = await Promise.all(
        clientsWithEvent.map(async (client) => {
          const data = await client.events.launchApp({
            libraryInfo: input.libraryInfo as LibraryInfo,
            launchType: input.launchType,
          });
          return data.args;
        })
      );

      return new ProcedureJSON(200, { success: true, results });
    }),
};

export default procedures;
