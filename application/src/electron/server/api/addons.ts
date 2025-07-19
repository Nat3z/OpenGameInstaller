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
        steamappid: z.string().optional(),
        gameID: z.string().optional(),
      })
    )
    .handler(async (input) => {
      if (!input.steamappid && !input.gameID) {
        return new ProcedureError(400, 'No query provided');
      }

      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      const deferrableTask = new DeferrableTask(async () => {
        const event = await client.sendEventMessage({
          event: 'search',
          args: {
            text: input.gameID ?? input.steamappid,
            type: input.gameID
              ? 'internal'
              : input.steamappid
                ? 'steamapp'
                : '',
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

      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.sendEventMessage({
          event: 'request-dl',
          args: { appID: input.appID, info: input.info },
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
      })
    )
    .handler(async (input) => {
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');
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
            multiFiles: input.multiPartFiles,
            deferID: deferrableTask.id!!,
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
        addonID: z.string(),
        gameID: z.string(),
      })
    )
    .handler(async (input) => {
      const client = clients.get(input.addonID);
      if (!client) return new ProcedureError(404, 'Client not found');

      const gameID = parseInt(input.gameID);
      const deferrableTask = new DeferrableTask(async () => {
        const data = await client.sendEventMessage({
          event: 'game-details',
          args: gameID,
        });
        data.args.description = sanitize(data.args.description);
        return data.args;
      }, client.addonInfo.id);

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
