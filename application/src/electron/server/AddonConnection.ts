import wsLib from 'ws';
import {
  ClientSentEventTypes,
  OGIAddonConfiguration,
  WebsocketMessageClient,
  WebsocketMessageServer,
} from 'ogi-addon';
import { ConfigurationFile } from 'ogi-addon/src/config/ConfigurationBuilder';
import { clients } from './addon-server.js';
import { DefferedTasks } from './api/defer.js';
import { addonSecret } from './constants.js';
import {
  currentScreens,
  isSecurityCheckEnabled,
  sendAskForInput,
  sendNotification,
  steamAppSearcher,
} from '../main.js';
import { DeferrableTask } from './DeferrableTask.js';

export class AddonConnection {
  public addonInfo: OGIAddonConfiguration;
  public ws: wsLib.WebSocket;
  public configTemplate: ConfigurationFile;

  constructor(ws: wsLib.WebSocket) {
    this.ws = ws;
  }

  public async setupWebsocket(): Promise<boolean> {
    return new Promise((resolve, _) => {
      const authenticationTimeout = setTimeout(() => {
        this.ws.close(1008, 'Authentication timeout');
        console.error('Client kicked due to authentication timeout');
        resolve(false);
      }, 1000);

      this.ws.on('message', (message) => {
        const data: WebsocketMessageClient = JSON.parse(message.toString());
        switch (data.event) {
          case 'notification':
            sendNotification(data.args[0]);
            break;
          case 'authenticate':
            clearTimeout(authenticationTimeout);

            // authentication
            this.addonInfo = data.args;
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

            // if (this.addonInfo.version !== ogiAddonVERSION) {
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
            if (clients.has(this.addonInfo.id)) {
              console.error(
                'Client attempted to authenticate with an ID that is already in use'
              );
              clients.delete(this.addonInfo.id);
              this.ws.close(
                1008,
                'Client attempted to authenticate with an ID that is already in use'
              );
              resolve(false);
              break;
            }
            console.log('Client authenticated:', data.args.name);
            resolve(true);
            break;
          case 'configure':
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
          case 'defer-update':
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
            const deferredTask = DefferedTasks.get(data.args.deferID);
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
            if (deferredTask.addonOwner !== this.addonInfo.id) {
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
          case 'input-asked':
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
            // now send the configuration to the client
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
          case 'steam-search':
            if (!this.addonInfo) {
              console.error(
                'Client attempted to send steam-search before authentication'
              );
              this.ws.close(
                1008,
                'Client attempted to send steam-search before authentication'
              );
              return;
            }
            if (!steamAppSearcher) {
              console.error(
                'Client attempted to send steam-search before steamAppSearcher is initialized'
              );
              this.ws.close(
                1008,
                'Client attempted to send steam-search before steamAppSearcher is initialized'
              );
              return;
            }
            const { query, strict }: ClientSentEventTypes['steam-search'] =
              data.args;
            // now run the search
            let results = steamAppSearcher.search(query);
            // if strict, filter out results that are not exact matches to the appid
            if (strict) {
              results = results.filter(
                (result) => result.item.appid === Number(query)
              );
            }
            this.sendEventMessage(
              {
                event: 'response',
                args: results.map((result) => result.item),
                id: data.id,
              },
              false
            );
            break;
          case 'task-update':
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
            let task = DefferedTasks.get(data.args.id);

            if (!task) {
              task = new DeferrableTask(async () => {
                return null;
              }, this.addonInfo.id);
              DefferedTasks.set(data.args.id, task);
              sendNotification({
                type: 'info',
                message: 'Task started by ' + this.addonInfo.name,
                id: data.args.id,
              });
            }
            task.progress = taskUpdate.progress;
            task.logs = taskUpdate.logs;
            task.finished = taskUpdate.finished;
            task.failed = taskUpdate.failed;

            if (taskUpdate.failed) {
              task.finished = true;
              sendNotification({
                type: 'error',
                message: 'Task failed by ' + this.addonInfo.name,
                id: data.args.id,
              });
              // Don't delete the task immediately for failed tasks so users can see the error
              break;
            }

            if (taskUpdate.finished && !taskUpdate.failed) {
              DefferedTasks.delete(data.args.id);
              sendNotification({
                type: 'success',
                message: 'Task finished by ' + this.addonInfo.name,
                id: data.args.id,
              });
            }
            break;
        }
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
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          reject(err);
        }
      });
      if (expectResponse) {
        const waitResponse = () => {
          if (this.ws.readyState === wsLib.CLOSED) {
            reject('Websocket closed');
            return;
          }
          this.ws.once('message', (messageRaw) => {
            const messageFromClient: WebsocketMessageClient = JSON.parse(
              '' + messageRaw.toString()
            );
            if (
              messageFromClient.event === 'response' &&
              messageFromClient.id === message.id
            ) {
              if (messageFromClient.args.statusError) {
                reject(messageFromClient.args.statusError);
                return;
              }
              resolve(messageFromClient);
            } else {
              waitResponse();
            }
          });
        };
        waitResponse();
      } else {
        resolve({ event: 'response', args: 'OK' });
      }
    });
  }
}
