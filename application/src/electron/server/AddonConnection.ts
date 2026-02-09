import wsLib from 'ws';
import type {
  ClientSentEventTypes,
  OGIAddonConfiguration,
  OGIAddonEvent,
  StoreData,
  WebsocketMessageClient,
  WebsocketMessageServer,
} from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import { clients } from './addon-server.js';
import { addonSecret } from './constants.js';
import {
  currentScreens,
  isSecurityCheckEnabled,
  sendAskForInput,
  sendIPCMessage,
  sendNotification,
} from '../main.js';
import { DeferrableTask, DeferredTasks } from './DeferrableTask.js';

export class AddonConnection {
  public addonInfo: OGIAddonConfiguration | undefined;
  public ws: InstanceType<typeof wsLib>;
  public configTemplate: ConfigurationFile | undefined;
  public filePath: string | undefined;
  public addonLink: string | undefined;
  public eventsAvailable: OGIAddonEvent[] = [];
  private pendingResponses: Map<string, { resolve: (value: WebsocketMessageClient) => void; reject: (reason?: any) => void }> = new Map();
  private messageHandler: ((message: string | Buffer) => void) | null = null;
  constructor(ws: InstanceType<typeof wsLib>) {
    this.ws = ws;
  }

  public async setupWebsocket(): Promise<boolean> {
    return new Promise((resolve, _) => {
      const authenticationTimeout = setTimeout(() => {
        this.ws.close(1008, 'Authentication timeout');
        console.error('Client kicked due to authentication timeout');
        resolve(false);
      }, 1000);

      // Set up persistent message handler
      this.messageHandler = async (message: string | Buffer) => {
        let data: WebsocketMessageClient;
        try {
          data = JSON.parse(message.toString());
        } catch (err) {
          console.error('Failed to parse websocket message:', err);
          this.ws.close(1008, 'Invalid JSON message');
          return;
        }
        
        // Check if this is a response to a pending request
        if (data.event === 'response' && data.id && this.pendingResponses.has(data.id)) {
          const pending = this.pendingResponses.get(data.id)!;
          this.pendingResponses.delete(data.id);
          if (!data.args || data.statusError) {
            if (!data.args && !data.statusError) {
              pending.resolve({
                event: 'response',
                args: undefined,
                id: data.id,
              });
            } else {
              pending.reject(data.statusError);
            }
            return;
          }
          pending.resolve(data);
          return;
        }
        
        // Handle other message types
        switch (data.event) {
          case 'notification': {
            sendNotification(data.args[0]);
            break;
          }
          case 'authenticate': {
            clearTimeout(authenticationTimeout);

            // authentication
            const addonInfo = data.args as OGIAddonConfiguration;
            this.addonInfo = addonInfo;
            if (
              isSecurityCheckEnabled &&
              (!data.args.secret || data.args.secret !== addonSecret)
            ) {
              console.error(
                'Client attempted to authenticate with an invalid secret'
              );
              this.ws.close(
                1008,
                'Client attempted to authenticate with an invalid secret'
              );
              resolve(false);
              break;
            }

            // if (addonInfo.version !== ogiAddonVERSION) {
            //   sendNotification({
            //     type: 'error',
            //     message: 'Client attempted to authenticate with an addon version that is not compatible with the OGI Addon Server',
            //     id: 'addon-version-mismatch'
            //   });
            //   console.error('Client attempted to authenticate with an addon version that is not compatible with the OGI Addon Server');
            //   this.ws.close(1008, 'Client attempted to authenticate with an addon version that is not compatible with the OGI Addon Server');
            //   resolve(false)
            //   break;
            // }
            if (clients.has(addonInfo.id)) {
              console.error(
                'Client attempted to authenticate with an ID that is already in use'
              );
              this.ws.close(
                1008,
                'Client attempted to authenticate with an ID that is already in use'
              );
              resolve(false);
              break;
            }
            console.log('Client authenticated:', data.args.name);
            clients.set(addonInfo.id, this);
            sendIPCMessage('addon-connected', addonInfo.id);
            resolve(true);
            break;
          }
          case 'configure': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send config before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send config before authentication'
              );
              return;
            }
            this.configTemplate = data.args;
            break;
          }
          case 'defer-update': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send defer-update before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send defer-update before authentication'
              );
              return;
            }
            if (!data.args) return;

            if (!data.args.deferID) {
              console.error(
                'Client attempted to send defer-update without an ID'
              );
              this.ws.close(
                1008,
                'Client attempted to send defer-update without an ID'
              );
              return;
            }
            const deferredTask = DeferredTasks.getTasks()[data.args.deferID];
            if (!deferredTask) {
              console.error(
                'Client attempted to send defer-update with an invalid ID'
              );
              this.ws.close(
                1008,
                'Client attempted to send defer-update with an invalid ID'
              );
              return;
            }
            if (deferredTask.addonOwner !== this.addonInfo!.id) {
              console.error(
                'Client attempted to send defer-update with an ID that does not belong to them'
              );
              this.ws.close(
                1008,
                'Client attempted to send defer-update with an ID that does not belong to them'
              );
              return;
            }
            deferredTask.logs = data.args.logs;
            deferredTask.progress = data.args.progress;
            if (data.args.failed) {
              deferredTask.failed = data.args.failed;
              deferredTask.finished = true;
            }
            break;
          }
          case 'input-asked': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send input-asked before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send input-asked before authentication'
              );
              return;
            }
            if (!data.args) return;
            if (
              !data.args.config ||
              !data.args.name ||
              !data.args.description
            ) {
              console.error(
                'Client attempted to send input-asked without a configuration'
              );
              this.ws.close(
                1008,
                'Client attempted to send input-asked without a configuration'
              );
              return;
            }

            if (!data.id) {
              console.error(
                'Client attempted to send input-asked without an ID'
              );
              this.ws.close(
                1008,
                'Client attempted to send input-asked without an ID'
              );
              return;
            }
            const configurationAsked = data.args.config as
              | ConfigurationFile
              | undefined;
            const name = data.args.name as string;
            const description = data.args.description as string;
            if (!configurationAsked || !name || !description) {
              console.error(
                'Client attempted to send input-asked without a configuration'
              );
              this.ws.close(
                1008,
                'Client attempted to send input-asked without a configuration'
              );
              return;
            }

            sendAskForInput(data.id, configurationAsked, name, description);
            const waitForClient = setInterval(() => {
              const screenData = currentScreens.get(data.id!!);
              if (screenData) {
                clearInterval(waitForClient);
                currentScreens.delete(data.id!!);
                this.sendEventMessage(
                  { event: 'response', args: screenData, id: data.id!! },
                  false
                );
              }
            }, 100);

            break;
          }
          case 'task-update': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send task-update before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send task-update before authentication'
              );
              return;
            }
            if (!data.args.id) {
              console.error(
                'Client attempted to send task-update without an ID'
              );
              this.ws.close(
                1008,
                'Client attempted to send task-update without an ID'
              );
              return;
            }
            const taskUpdate = data.args as ClientSentEventTypes['task-update'];
            let task = DeferredTasks.getTasks()[data.args.id];

            if (!task) {
              task = new DeferrableTask(async () => {
                return null;
              }, this.addonInfo!.id);
              DeferredTasks.getTasks()[data.args.id] = task;
              // sendNotification({
              //   type: 'info',
              //   message: 'Task started by ' + this.addonInfo.name,
              //   id: data.args.id,
              // });
            }
            task.progress = taskUpdate.progress;
            task.logs = taskUpdate.logs;
            task.finished = taskUpdate.finished;
            task.failed = taskUpdate.failed;

            if (taskUpdate.failed) {
              task.finished = true;
              // sendNotification({
              //   type: 'error',
              //   message: 'Task failed by ' + this.addonInfo.name,
              //   id: data.args.id,
              // });
              // Don't delete the task immediately for failed tasks so users can see the error
              break;
            }

            if (taskUpdate.finished && !taskUpdate.failed) {
              DeferredTasks.removeTask(data.args.id);
              // sendNotification({
              //   type: 'success',
              //   message: 'Task finished by ' + this.addonInfo.name,
              //   id: data.args.id,
              // });
            }
            break;
          }
          case 'get-app-details': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send get-app-details before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send get-app-details before authentication'
              );
              return;
            }
            const {
              appID,
              storefront,
            }: ClientSentEventTypes['get-app-details'] = data.args;
            // query all of the clients for the app details
            const clientsWithStorefront = Array.from(clients.values()).filter(
              (client) =>
                client.addonInfo?.storefronts.includes(storefront) &&
                client.eventsAvailable.includes('game-details')
            );
            // find a storefront that gives app details that isn't undefined
            let appDetails: StoreData | undefined;
            for (const client of clientsWithStorefront) {
              const response = await client.sendEventMessage(
                {
                  event: 'game-details',
                  args: { appID, storefront },
                },
                true
              );
              if (response.args) {
                appDetails = response.args;
                break;
              }
            }
            if (!appDetails) {
              console.error('No app details found for client');
              this.sendEventMessage(
                {
                  event: 'response',
                  args: undefined,
                  id: data.id,
                },
                false
              );
              return;
            }
            this.sendEventMessage(
              {
                event: 'response',
                args: appDetails,
                id: data.id,
              },
              false
            );
            console.log('Sent app details to client');
            break;
          }
          case 'search-app-name': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send search-app-name before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send search-app-name before authentication'
              );
              return;
            }
            const {
              query,
              storefront,
            }: ClientSentEventTypes['search-app-name'] = data.args;
            const clientsWithStorefront = Array.from(clients.values()).filter(
              (client) =>
                client.addonInfo?.storefronts.includes(storefront) &&
                client.eventsAvailable.includes('library-search')
            );
            const searchResult: StoreData[] = [];
            for (const client of clientsWithStorefront) {
              const response = await client.sendEventMessage(
                { event: 'library-search', args: query },
                true
              );
              if (response.args) {
                searchResult.push(...response.args);
              }
            }
            this.sendEventMessage(
              { event: 'response', args: searchResult, id: data.id },
              false
            );
            break;
          }
          case 'flag': {
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send flag before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send flag before authentication'
              );
              return;
            }
            if (data.args.flag === 'events-available') {
              console.log(
                'Setting events-available to',
                data.args.value,
                'for addon',
                this.addonInfo!.id
              );
              this.eventsAvailable = data.args.value as OGIAddonEvent[];
            }
            break;
          }
        }
      };
      
      this.ws.on('message', this.messageHandler);
      
      // Clean up pending responses on close/error
      this.ws.on('close', () => {
        for (const [id, pending] of this.pendingResponses.entries()) {
          pending.reject(new Error('Websocket closed'));
        }
        this.pendingResponses.clear();
      });
      
      this.ws.on('error', () => {
        for (const [id, pending] of this.pendingResponses.entries()) {
          pending.reject(new Error('Websocket error'));
        }
        this.pendingResponses.clear();
      });
    });
  }
  public sendEventMessage(
    message: WebsocketMessageServer,
    expectResponse: boolean = true
  ): Promise<WebsocketMessageClient> {
    if (expectResponse) {
      message.id = Math.random().toString(36).substring(7);
    }
    return new Promise((resolve, reject) => {
      // CLOSED state is 3
      if (this.ws.readyState === 3) {
        reject(new Error('Websocket closed'));
        return;
      }
      
      this.ws.send(JSON.stringify(message), (err: Error | null | undefined) => {
        if (err) {
          reject(err);
          return;
        }
      });
      
      if (expectResponse && message.id) {
        // Store the pending response handler
        this.pendingResponses.set(message.id, { resolve, reject });
      } else {
        resolve({ event: 'response', args: 'OK' });
      }
    });
  }
}
