import { z } from 'zod';
import { clients } from '../addon-server.js';
import { DeferrableTask } from '../DeferrableTask.js';
import sanitize from 'sanitize-html';
import {
  type Procedure,
  procedure,
  ProcedureError,
  ProcedureJSON,
  ProcedureDeferTask,
} from '../serve.js';
import * as fs from 'fs/promises';
import { join } from 'path';
import { restartAddonServer } from '../../handlers/addon-manager.js';
import { __dirname } from '../../paths.js';
import { StoreData } from 'ogi-addon';

const procedures: Record<string, Procedure<any>> = {
  // Get all addon info
  getAllAddons: procedure()
    .input(z.object({}))
    .handler(async () => {
      let info = [];
      for (const client of clients.values()) {
        info.push({
          ...client.addonInfo,
          configTemplate: client.configTemplate,
        });
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
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      const response = await client.sendEventMessage({
        event: 'config-update',
        args: input.config,
      });

      if (response.args.success) {
        return new ProcedureJSON(200, { success: true });
      } else {
        return new ProcedureJSON(400, {
          success: false,
          errors: response.args.error,
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
      })
    )
    .handler(async (input) => {
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
      if (!client.eventsAvailable.includes('search')) {
        return new ProcedureError(400, 'Client does not support search');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const event = await client.sendEventMessage({
          event: 'search',
          args: {
            appID: input.appID,
            storefront: input.storefront,
          },
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
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      if (!client.eventsAvailable.includes('library-search')) {
        return new ProcedureError(
          400,
          'Client does not support library-search'
        );
      }

      const deferrableTask = new DeferrableTask(async () => {
        const event = await client.sendEventMessage({
          event: 'library-search',
          args: input.query,
        });
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
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      if (!client.eventsAvailable.includes('request-dl')) {
        return new ProcedureError(400, 'Client does not support request-dl');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.sendEventMessage({
          event: 'request-dl',
          args: { appID: input.appID, info: input.info },
        });
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
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      if (!client.eventsAvailable.includes('catalog')) {
        return new ProcedureError(400, 'Client does not support catalog');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.sendEventMessage({
          event: 'catalog',
          args: {},
        });
        return data.args;
      }, client.addonInfo.id);

      return new ProcedureDeferTask(200, deferrableTask);
    }),
  // Setup app
  setupApp: procedure()
    .input(
      z.object({
        addonID: z.string(),
        path: z.string(),
        type: z.string(),
        name: z.string(),
        appID: z.unknown(),
        usedRealDebrid: z.boolean(),
        storefront: z.string(),
        multiPartFiles: z.unknown().optional(),
        manifest: z.unknown().optional(),
      })
    )
    .handler(async (input) => {
      console.log('setupApp', input);
      const client = clients.get(input.addonID);
      if (!client) {
        console.error('Client not found');
        return new ProcedureError(404, 'Client not found');
      }

      if (!client.eventsAvailable.includes('setup')) {
        console.error('Client does not support setup');
        return new ProcedureError(400, 'Client does not support setup');
      }

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.sendEventMessage({
          event: 'setup',
          args: {
            path: input.path,
            appID: input.appID,
            type: input.type,
            usedRealDebrid: input.usedRealDebrid,
            storefront: input.storefront,
            name: input.name,
            multiPartFiles: input.multiPartFiles,
            deferID: deferrableTask.id!!,
            manifest: input.manifest,
          },
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
      const clientsWithStorefront = Array.from(clients.values()).filter(
        (client) =>
          client.addonInfo.storefronts.includes(input.storefront) &&
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
          const data = await client.sendEventMessage({
            event: 'game-details',
            args: { appID: gameID, storefront: input.storefront },
          });
          if (data.args) {
            appDetails = data.args;
            break;
          }
        }
        if (!appDetails) {
          return new ProcedureError(404, 'No app details found');
        }
        appDetails.description = sanitize(appDetails.description);
        return appDetails;
      }, '*');

      return new ProcedureDeferTask(200, deferrableTask);
    }),

  deleteAddon: procedure()
    .input(z.object({ addonID: z.string() }))
    .handler(async (input) => {
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
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
};

export default procedures;
