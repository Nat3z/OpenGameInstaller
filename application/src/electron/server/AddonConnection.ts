
import wsLib from 'ws';
import { OGIAddonConfiguration, WebsocketMessageClient, WebsocketMessageServer } from "ogi-addon";
import { ConfigurationFile } from 'ogi-addon/src/config/ConfigurationBuilder';
import { clients } from './addon-server';
import { DefferedTasks } from './api/defer';

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
        console.error("Client kicked due to authentication timeout")
        resolve(false)
      }, 1000);

      this.ws.on('message', (message) => {
        const data: WebsocketMessageClient = JSON.parse(message.toString());

        switch (data.event) {
          case 'authenticate':
            clearTimeout(authenticationTimeout);

            // authentication
            this.addonInfo = data.args;

            if (clients.has(this.addonInfo.id)) {
              console.error('Client attempted to authenticate with an ID that is already in use');
              clients.delete(this.addonInfo.id);
              this.ws.close(1008, 'Client attempted to authenticate with an ID that is already in use');
              resolve(false)
              break
            }
            console.log('Client authenticated:', data.args.name);
            resolve(true);
            break;
          case 'configure':
            if (!this.addonInfo) {
              console.error('Client attempted to send config before authentication');
              this.ws.close(1008, 'Client attempted to send config before authentication');
              return;
            }
            this.configTemplate = data.args;
            break;
          case 'defer-update':
            if (!this.addonInfo) {
              console.error('Client attempted to send defer-update before authentication');
              this.ws.close(1008, 'Client attempted to send defer-update before authentication');
              return;
            }
            if (!data.args)
              return;

            if (!data.args.deferID) {
              console.error('Client attempted to send defer-update without an ID');
              this.ws.close(1008, 'Client attempted to send defer-update without an ID');
              return;
            }
            const deferredTask = DefferedTasks.get(data.args.deferID);
            if (!deferredTask) {
              console.error('Client attempted to send defer-update with an invalid ID');
              this.ws.close(1008, 'Client attempted to send defer-update with an invalid ID');
              return;
            }
            if (deferredTask.addonOwner !== this.addonInfo.id) {
              console.error('Client attempted to send defer-update with an ID that does not belong to them');
              this.ws.close(1008, 'Client attempted to send defer-update with an ID that does not belong to them');
              return;
            }
            deferredTask.logs = data.args.logs;
            deferredTask.progress = data.args.progress;
            break;
        }
      });

    });
  }
  public sendEventMessage(message: WebsocketMessageServer, expectResponse: boolean = true): Promise<WebsocketMessageClient> {
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
            const messageFromClient: WebsocketMessageClient = JSON.parse("" + messageRaw.toString())
            if (messageFromClient.event === "response" && messageFromClient.id === message.id) {
              console.log(messageFromClient)
              resolve(messageFromClient);
            }
            else {
              waitResponse();
            }
          });
        }
        waitResponse();
      }
      else {
        resolve({ event: 'response', args: 'OK' });
      }
    });
  }
}